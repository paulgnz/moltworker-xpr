import type { Context, Next } from 'hono';
import type { AppEnv, MoltbotEnv } from '../types';
import { verifyAccessJWT } from './jwt';
import { verifyWalletJWT } from './wallet';

/**
 * Options for creating an auth middleware
 */
export interface AuthMiddlewareOptions {
  /** Response type: 'json' for API routes, 'html' for UI routes */
  type: 'json' | 'html';
  /** Whether to redirect/show login when JWT is missing (only for 'html' type) */
  redirectOnMissing?: boolean;
}

/**
 * Check if running in development mode (skips auth + device pairing)
 */
export function isDevMode(env: MoltbotEnv): boolean {
  return env.DEV_MODE === 'true';
}

/**
 * Check if running in E2E test mode (skips auth but keeps device pairing)
 */
export function isE2ETestMode(env: MoltbotEnv): boolean {
  return env.E2E_TEST_MODE === 'true';
}

/**
 * Extract JWT from request — checks multiple sources in order:
 * 1. CF-Access-JWT-Assertion header (CF Access)
 * 2. CF_Authorization cookie (CF Access)
 * 3. Authorization: Bearer header (wallet auth)
 * 4. moltbot_session cookie (wallet auth)
 */
export function extractJWT(c: Context<AppEnv>): { token: string; source: 'cf-access' | 'wallet' } | null {
  // CF Access sources
  const cfHeader = c.req.header('CF-Access-JWT-Assertion');
  if (cfHeader) return { token: cfHeader, source: 'cf-access' };

  const cookies = c.req.raw.headers.get('Cookie') || '';

  const cfCookie = cookies
    .split(';')
    .find((cookie) => cookie.trim().startsWith('CF_Authorization='))
    ?.split('=')[1];
  if (cfCookie) return { token: cfCookie, source: 'cf-access' };

  // Wallet auth sources
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return { token: authHeader.slice(7), source: 'wallet' };
  }

  const walletCookie = cookies
    .split(';')
    .find((cookie) => cookie.trim().startsWith('moltbot_session='))
    ?.split('=')[1]
    ?.trim();
  if (walletCookie) return { token: walletCookie, source: 'wallet' };

  return null;
}

/**
 * Create a dual-mode authentication middleware.
 *
 * Priority:
 * 1. DEV_MODE / E2E_TEST_MODE → skip auth
 * 2. XPR_OWNER_ACCOUNT set → try wallet JWT (moltbot_session cookie or Bearer token)
 * 3. CF_ACCESS_TEAM_DOMAIN set → try CF Access JWT
 * 4. Neither configured → 503 error
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { type, redirectOnMissing = false } = options;

  return async (c: Context<AppEnv>, next: Next) => {
    // Skip auth in dev mode or E2E test mode
    if (isDevMode(c.env) || isE2ETestMode(c.env)) {
      c.set('accessUser', { email: 'dev@localhost', name: 'Dev User' });
      return next();
    }

    const hasWalletAuth = !!c.env.XPR_OWNER_ACCOUNT;
    const hasCfAccess = !!(c.env.CF_ACCESS_TEAM_DOMAIN && c.env.CF_ACCESS_AUD);

    // No auth method configured
    if (!hasWalletAuth && !hasCfAccess) {
      if (type === 'json') {
        return c.json(
          {
            error: 'No authentication method configured',
            hint: 'Set XPR_OWNER_ACCOUNT for wallet auth, or CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD for Cloudflare Access',
          },
          503,
        );
      }
      return c.html(
        `<html><body><h1>Authentication Not Configured</h1>
        <p>Set XPR_OWNER_ACCOUNT or CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD.</p></body></html>`,
        503,
      );
    }

    const jwt = extractJWT(c);

    // Try wallet JWT first if wallet auth is configured
    if (hasWalletAuth && jwt) {
      // Wallet JWT can come from any source (Bearer header or moltbot_session cookie)
      const walletPayload = await verifyWalletJWT(jwt.token, c.env);
      if (walletPayload) {
        // Verify the actor matches the configured owner
        if (walletPayload.actor === c.env.XPR_OWNER_ACCOUNT) {
          c.set('accessUser', {
            email: `${walletPayload.actor}@xpr.network`,
            name: walletPayload.actor,
          });
          return next();
        }
        // Valid JWT but wrong account
        console.warn(`[auth] Wallet JWT for ${walletPayload.actor} denied — expected ${c.env.XPR_OWNER_ACCOUNT}`);
      }
    }

    // Try CF Access JWT if configured
    if (hasCfAccess && jwt?.source === 'cf-access') {
      try {
        const payload = await verifyAccessJWT(
          jwt.token,
          c.env.CF_ACCESS_TEAM_DOMAIN!,
          c.env.CF_ACCESS_AUD!,
        );
        c.set('accessUser', { email: payload.email, name: payload.name });
        return next();
      } catch (err) {
        console.error('[auth] CF Access JWT verification failed:', err);
      }
    }

    // No valid JWT found — return appropriate error
    if (!jwt) {
      // For wallet auth with HTML requests, signal that login page should be shown
      if (hasWalletAuth && type === 'html') {
        // Set a flag so index.ts can serve the login page
        return c.json({ _walletLoginRequired: true }, 401);
      }

      if (hasCfAccess && type === 'html' && redirectOnMissing) {
        return c.redirect(`https://${c.env.CF_ACCESS_TEAM_DOMAIN}`, 302);
      }

      if (type === 'json') {
        return c.json({ error: 'Unauthorized', hint: 'Missing authentication token' }, 401);
      }

      return c.html(
        `<html><body><h1>Unauthorized</h1><p>Missing authentication token.</p></body></html>`,
        401,
      );
    }

    // JWT present but invalid
    if (type === 'json') {
      return c.json(
        { error: 'Unauthorized', details: 'Invalid or expired authentication token' },
        401,
      );
    }

    if (hasWalletAuth) {
      // Wallet auth with expired/invalid JWT — show login page
      return c.json({ _walletLoginRequired: true }, 401);
    }

    return c.html(
      `<html><body><h1>Unauthorized</h1>
      <p>Your session is invalid or expired.</p>
      ${hasCfAccess ? `<a href="https://${c.env.CF_ACCESS_TEAM_DOMAIN}">Login again</a>` : ''}
      </body></html>`,
      401,
    );
  };
}
