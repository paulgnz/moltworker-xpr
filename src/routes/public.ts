import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';
import { verifyWalletProof, signWalletJWT, verifyWalletJWT } from '../auth';
import type { WalletProof } from '../auth';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

// =============================================================================
// WALLET AUTH ENDPOINTS (public — they ARE the auth)
// =============================================================================

// POST /api/auth/authorize — verify signed generateauth tx and issue JWT
publicRoutes.post('/api/auth/authorize', async (c) => {
  if (!c.env.XPR_OWNER_ACCOUNT) {
    return c.json({ error: 'Wallet auth not configured (XPR_OWNER_ACCOUNT not set)' }, 503);
  }

  let proof: WalletProof;
  try {
    proof = await c.req.json<WalletProof>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!proof.signer?.actor || !proof.transaction || !proof.signatures?.length) {
    return c.json({ error: 'Missing required fields: signer, transaction, signatures' }, 400);
  }

  // Check that the signer matches the configured owner account
  if (proof.signer.actor !== c.env.XPR_OWNER_ACCOUNT) {
    console.warn(
      `[wallet-auth] Rejected auth from ${proof.signer.actor} — expected ${c.env.XPR_OWNER_ACCOUNT}`,
    );
    return c.json(
      {
        success: false,
        error: `Unauthorized account. Only ${c.env.XPR_OWNER_ACCOUNT} can access this gateway.`,
      },
      403,
    );
  }

  // Verify by pushing the signed tx to chain
  const result = await verifyWalletProof(proof, c.env);
  if (!result.valid) {
    return c.json({ success: false, error: result.error || 'Verification failed' }, 401);
  }

  // Issue JWT
  const token = await signWalletJWT(proof.signer.actor, proof.signer.permission || 'active', c.env);

  return c.json({
    success: true,
    validated: true,
    actor: proof.signer.actor,
    permission: proof.signer.permission || 'active',
    token,
    timestamp: Date.now(),
  });
});

// POST /api/auth/validate — validate an existing JWT
publicRoutes.post('/api/auth/validate', async (c) => {
  if (!c.env.XPR_OWNER_ACCOUNT) {
    return c.json({ error: 'Wallet auth not configured' }, 503);
  }

  // Extract token from Bearer header or request body
  let token: string | undefined;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    try {
      const body = await c.req.json<{ token?: string }>();
      token = body.token;
    } catch {
      // no body
    }
  }

  if (!token) {
    return c.json({ valid: false, error: 'No token provided' }, 400);
  }

  const payload = await verifyWalletJWT(token, c.env);
  if (!payload) {
    return c.json({ valid: false, error: 'Invalid or expired token' });
  }

  return c.json({
    valid: true,
    actor: payload.actor,
    expiresAt: payload.exp * 1000,
  });
});

export { publicRoutes };
