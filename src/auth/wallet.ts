/**
 * XPR wallet-based authentication for Moltworker.
 *
 * Auth flow:
 * 1. User signs a `proton.wrap::generateauth` tx with their wallet (broadcast: false)
 * 2. Worker pushes the signed tx to chain via /v1/chain/push_transaction
 * 3. Chain validates the signature (supports K1, WA, R1) and confirms the signer
 * 4. Worker issues a JWT (HMAC-SHA256, 24h expiry) if the signer matches XPR_OWNER_ACCOUNT
 *
 * No tokens are transferred — generateauth is a no-op action that just proves identity.
 */

import { SignJWT, jwtVerify } from 'jose';
import type { MoltbotEnv } from '../types';

const JWT_ISSUER = 'moltworker-wallet-auth';
const JWT_AUDIENCE = 'moltworker';
const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

export interface WalletProof {
  signer: { actor: string; permission: string };
  transaction: string; // hex-encoded serialized transaction
  signatures: string[]; // SIG_K1_..., SIG_WA_..., or SIG_R1_...
  chainId: string;
}

export interface WalletJWTPayload {
  actor: string;
  permission: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

/**
 * Derive a JWT signing key from MOLTBOT_GATEWAY_TOKEN using Web Crypto HMAC.
 * This avoids needing a separate JWT_SECRET env var.
 */
async function getJWTSecret(env: MoltbotEnv): Promise<CryptoKey> {
  const secret = env.MOLTBOT_GATEWAY_TOKEN;
  if (!secret) {
    throw new Error('MOLTBOT_GATEWAY_TOKEN is required for wallet auth JWT signing');
  }

  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Resolve the RPC endpoint for auth transaction verification.
 */
function getAuthRpcEndpoint(env: MoltbotEnv): string {
  if (env.XPR_AUTH_RPC_ENDPOINT) return env.XPR_AUTH_RPC_ENDPOINT;
  if (env.XPR_RPC_ENDPOINT) return env.XPR_RPC_ENDPOINT;

  const network = env.XPR_NETWORK || 'mainnet';
  return network === 'testnet' ? 'https://testnet.protonchain.com' : 'https://proton.eosusa.io';
}

/**
 * Verify a wallet proof by pushing the signed transaction to chain.
 *
 * The chain validates all signature types (K1, R1, WA) natively against
 * the account's registered keys. If the chain accepts the transaction,
 * the signer is authenticated.
 *
 * generateauth is a no-op action — no state changes, no tokens transferred.
 */
export async function verifyWalletProof(
  proof: WalletProof,
  env: MoltbotEnv,
): Promise<{ valid: boolean; error?: string }> {
  const rpcEndpoint = getAuthRpcEndpoint(env);

  if (!proof.transaction || !proof.signatures?.length) {
    return { valid: false, error: 'Missing transaction or signatures' };
  }

  if (!proof.signer?.actor) {
    return { valid: false, error: 'Missing signer actor' };
  }

  try {
    const res = await fetch(`${rpcEndpoint}/v1/chain/push_transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signatures: proof.signatures,
        compression: 0,
        packed_context_free_data: '',
        packed_trx: proof.transaction,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      return { valid: true };
    }

    // Check for specific errors that indicate signature was valid but tx had other issues
    const body = await res.text();
    let errorMsg: string;
    try {
      const parsed = JSON.parse(body);
      errorMsg =
        parsed?.error?.details?.[0]?.message || parsed?.error?.what || parsed?.message || body;
    } catch {
      errorMsg = body;
    }

    // tx_duplicate means the same tx was already pushed (e.g., user retried) — sig was valid
    if (errorMsg.includes('tx_duplicate') || errorMsg.includes('duplicate transaction')) {
      return { valid: true };
    }

    // expired_tx_exception means the tx window passed — sig was valid but too slow
    if (errorMsg.includes('expired_tx_exception') || errorMsg.includes('Expired Transaction')) {
      return { valid: false, error: 'Transaction expired. Please try signing again.' };
    }

    console.error(`[wallet-auth] Chain rejected transaction: ${errorMsg.substring(0, 200)}`);
    return { valid: false, error: `Chain verification failed: ${errorMsg.substring(0, 100)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wallet-auth] RPC call failed: ${msg}`);
    return { valid: false, error: `RPC error: ${msg}` };
  }
}

/**
 * Sign a JWT for an authenticated wallet user.
 */
export async function signWalletJWT(
  actor: string,
  permission: string,
  env: MoltbotEnv,
): Promise<string> {
  const key = await getJWTSecret(env);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ actor, permission })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_EXPIRY_SECONDS)
    .sign(key);
}

/**
 * Verify and decode a wallet JWT.
 */
export async function verifyWalletJWT(
  token: string,
  env: MoltbotEnv,
): Promise<WalletJWTPayload | null> {
  try {
    const key = await getJWTSecret(env);
    const { payload } = await jwtVerify(token, key, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    const actor = payload.actor as string | undefined;
    const permission = payload.permission as string | undefined;

    if (!actor) return null;

    return {
      actor,
      permission: permission || 'active',
      iss: payload.iss || JWT_ISSUER,
      aud: JWT_AUDIENCE,
      exp: payload.exp || 0,
      iat: payload.iat || 0,
    };
  } catch (err) {
    console.error(
      '[wallet-auth] JWT verification failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
