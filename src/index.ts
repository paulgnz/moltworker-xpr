/**
 * Moltbot + Cloudflare Sandbox
 *
 * This Worker runs Moltbot personal AI assistant in a Cloudflare Sandbox container.
 * It proxies all requests to the Moltbot Gateway's web UI and WebSocket endpoint.
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 * - Configuration via environment secrets
 *
 * Required secrets (set via `wrangler secret put`):
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - MOLTBOT_GATEWAY_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { Context } from 'hono';
import type { AppEnv, MoltbotEnv } from './types';
import { MOLTBOT_PORT } from './config';
import { createAuthMiddleware } from './auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './gateway';
import { publicRoutes, api, adminUi, debug, cdp } from './routes';
import { redactSensitiveParams } from './utils/logging';
import { isMultiTenant, resolveAgentFromHostname, getTenantConfig, mergeTenantEnv } from './tenant';
import loadingPageHtml from './assets/loading.html';
import configErrorHtml from './assets/config-error.html';
import walletLoginHtml from './assets/wallet-login.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

export { Sandbox };

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];
  const isTestMode = env.DEV_MODE === 'true' || env.E2E_TEST_MODE === 'true';

  if (!env.MOLTBOT_GATEWAY_TOKEN) {
    missing.push('MOLTBOT_GATEWAY_TOKEN');
  }

  // CF Access vars not required when wallet auth (XPR_OWNER_ACCOUNT) is configured,
  // or in dev/test mode since auth is skipped entirely
  if (!isTestMode && !env.XPR_OWNER_ACCOUNT) {
    if (!env.CF_ACCESS_TEAM_DOMAIN) {
      missing.push('CF_ACCESS_TEAM_DOMAIN');
    }

    if (!env.CF_ACCESS_AUD) {
      missing.push('CF_ACCESS_AUD');
    }
  }

  // Check for AI provider configuration (at least one must be set)
  const hasCloudflareGateway = !!(
    env.CLOUDFLARE_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  );
  const hasLegacyGateway = !!(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL);
  const hasAnthropicKey = !!env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!env.OPENAI_API_KEY;

  if (!hasCloudflareGateway && !hasLegacyGateway && !hasAnthropicKey && !hasOpenAIKey) {
    missing.push(
      'ANTHROPIC_API_KEY, OPENAI_API_KEY, or CLOUDFLARE_AI_GATEWAY_API_KEY + CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_GATEWAY_ID',
    );
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 *
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 *
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv, tenantConfig?: import('./tenant').TenantConfig): SandboxOptions {
  const sleepAfter = (tenantConfig?.sandboxSleepAfter || env.SANDBOX_SLEEP_AFTER || 'never').toLowerCase();

  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  // Otherwise, use the specified duration
  return { sleepAfter };
}

/**
 * Serve the wallet login page with network config injected via template replacement.
 */
function serveWalletLoginPage(c: Context<AppEnv>) {
  const network = c.env.XPR_NETWORK || 'mainnet';
  const chainId =
    network === 'testnet'
      ? '71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd'
      : '384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0';

  const rpcEndpoint =
    c.env.XPR_RPC_ENDPOINT ||
    (network === 'testnet' ? 'https://testnet.protonchain.com' : 'https://proton.eosusa.io');
  const rpcEndpoints = JSON.stringify([rpcEndpoint]).replace(/"/g, '&quot;');
  const requesterAccount = c.env.XPR_ACCOUNT || 'agentcore';

  const html = walletLoginHtml
    .replace('{{CHAIN_ID}}', chainId)
    .replace('{{RPC_ENDPOINTS}}', rpcEndpoints)
    .replace('{{REQUESTER_ACCOUNT}}', requesterAccount)
    .replace('{{API_MODE}}', network);

  return c.html(html);
}

// Main app
const app = new Hono<AppEnv>();

/**
 * Track which sandbox IDs have been initialized (setSandboxName/setKeepAlive called).
 * After first init, subsequent requests create stubs without passing options to avoid
 * redundant setKeepAlive() DO storage writes. We can't cache the stub itself because
 * CF Workers enforce I/O context isolation between requests.
 */
const initializedSandboxIds = new Set<string>();

function getOrInitSandbox(env: MoltbotEnv, sandboxId: string, options: SandboxOptions): Sandbox {
  if (initializedSandboxIds.has(sandboxId)) {
    // Already initialized — create a lightweight stub without options
    // This avoids redundant setSandboxName/setKeepAlive RPC calls
    return getSandbox(env.Sandbox, sandboxId);
  }
  // First time — full init with options (sets keepAlive, sandboxName in DO storage)
  const sandbox = getSandbox(env.Sandbox, sandboxId, options);
  initializedSandboxIds.add(sandboxId);
  return sandbox;
}

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  await next();
});

// Middleware: Resolve tenant and initialize sandbox
app.use('*', async (c, next) => {
  // Try multi-tenant resolution if AGENT_KV is bound and hostname has a valid agent subdomain.
  // Falls through to single-tenant if no subdomain or agent not found in KV.
  const agentName = isMultiTenant(c.env)
    ? resolveAgentFromHostname(c.req.header('host') || '')
    : null;

  if (agentName && c.env.AGENT_KV) {
    const config = await getTenantConfig(c.env.AGENT_KV, agentName);
    if (!config) {
      return c.json({ error: `Agent '${agentName}' not found` }, 404);
    }

    c.set('agentName', agentName);
    c.set('tenantConfig', config);

    // Merge ALL tenant config fields into env so downstream code
    // (buildEnvVars, auth middleware, rclone sync, etc.) works automatically
    mergeTenantEnv(c.env, config);

    const options = buildSandboxOptions(c.env, config);
    const sandbox = getOrInitSandbox(c.env, agentName, options);
    c.set('sandbox', sandbox);
  } else {
    // Single-tenant mode: fixed sandbox ID (workers.dev, bare domain, or no AGENT_KV)
    const options = buildSandboxOptions(c.env);
    const sandbox = getOrInitSandbox(c.env, 'moltbot', options);
    c.set('sandbox', sandbox);
  }

  await next();
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /logo-small.png, /api/status, /_admin/assets/*
app.route('/', publicRoutes);

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode, debug routes, and tenant mode)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  // Skip validation in dev mode or when tenant config is loaded from KV
  if (c.env.DEV_MODE === 'true' || c.get('tenantConfig')) {
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));

    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }

    // Return JSON error for API requests
    return c.json(
      {
        error: 'Configuration error',
        message: 'Required environment variables are not configured',
        missing: missingVars,
        hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
      },
      503,
    );
  }

  return next();
});

// Middleware: Authentication for protected routes (wallet auth or CF Access)
// In multi-tenant mode, tenant config values are injected into c.env by the sandbox
// middleware above, so the auth middleware reads per-tenant XPR_OWNER_ACCOUNT,
// MOLTBOT_GATEWAY_TOKEN, etc. automatically.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip auth for public routes (health checks, auth endpoints, static assets, CDP)
  if (
    url.pathname === '/sandbox-health' ||
    url.pathname === '/api/status' ||
    url.pathname.startsWith('/api/auth/') ||
    url.pathname === '/api/gateway/restart' ||
    url.pathname === '/logo.png' ||
    url.pathname === '/logo-small.png' ||
    url.pathname.startsWith('/_admin/assets/') ||
    url.pathname.startsWith('/cdp')
  ) {
    return next();
  }

  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createAuthMiddleware({
    type: acceptsHtml ? 'html' : 'json',
    redirectOnMissing: acceptsHtml,
  });

  // Run the middleware
  const response = await middleware(c, next);

  // Intercept wallet login redirect signal — serve the login page instead
  if (response && response.status === 401) {
    try {
      const body = (await response.clone().json()) as Record<string, unknown>;
      if (body?._walletLoginRequired) {
        return serveWalletLoginPage(c);
      }
    } catch {
      // Not JSON — pass through
    }
  }

  return response;
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await)
    const tc = c.get('tenantConfig');
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env, tc).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      }),
    );

    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure moltbot is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env, c.get('tenantConfig'));
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json(
      {
        error: 'Moltbot gateway failed to start',
        details: errorMessage,
        hint,
      },
      503,
    );
  }

  // Proxy to Moltbot with WebSocket message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection to Moltbot');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    // In multi-tenant mode, the Worker's wallet auth handles authentication.
    // The container's gateway runs without token auth (--allow-unconfigured),
    // so no token injection needed. wsConnect doesn't forward query params anyway.
    //
    // In single-tenant mode, inject the gateway token via query param.
    // CF Access redirects strip query params, so we re-inject server-side.
    let wsRequest = request;
    if (!c.get('tenantConfig')) {
      // Single-tenant: inject the gateway token via query param
      const gatewayToken = c.env.MOLTBOT_GATEWAY_TOKEN;
      if (gatewayToken && !url.searchParams.has('token')) {
        const tokenUrl = new URL(url.toString());
        tokenUrl.searchParams.set('token', gatewayToken);
        wsRequest = new Request(tokenUrl.toString(), request);
        console.log('[WS] Token injected (single-tenant mode)');
      }
    } else {
      console.log('[WS] Multi-tenant mode — no container token needed');
    }

    // Get WebSocket connection to the container
    const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);

    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }

    if (debugLogs) {
      console.log('[WS] Got container WebSocket, setting up interception');
    }

    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    // Accept both WebSockets
    serverWs.accept();
    containerWs.accept();

    if (debugLogs) {
      console.log('[WS] Both WebSockets accepted');
      console.log('[WS] containerWs.readyState:', containerWs.readyState);
      console.log('[WS] serverWs.readyState:', serverWs.readyState);
    }

    // Relay messages from client to container
    serverWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Client -> Container:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)',
        );
      }
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data);
      } else if (debugLogs) {
        console.log('[WS] Container not open, readyState:', containerWs.readyState);
      }
    });

    // Relay messages from container to client, with error transformation
    containerWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Container -> Client (raw):',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)',
        );
      }
      let data = event.data;

      // Try to intercept and transform error messages
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (debugLogs) {
            console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
          }
          if (parsed.error?.message) {
            if (debugLogs) {
              console.log('[WS] Original error.message:', parsed.error.message);
            }
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            if (debugLogs) {
              console.log('[WS] Transformed error.message:', parsed.error.message);
            }
            data = JSON.stringify(parsed);
          }
        } catch (e) {
          if (debugLogs) {
            console.log('[WS] Not JSON or parse error:', e);
          }
        }
      }

      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else if (debugLogs) {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });

    // Handle close events
    serverWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Client closed:', event.code, event.reason);
      }
      containerWs.close(event.code, event.reason);
    });

    containerWs.addEventListener('close', (event) => {
      // Always log close reason to help debug token issues
      console.log('[WS] Container closed:', event.code, event.reason);
      // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
      let reason = transformErrorMessage(event.reason, url.host);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      if (debugLogs) {
        console.log('[WS] Transformed close reason:', reason);
      }
      // Code 1006 is reserved (abnormal closure) and can't be sent in a close frame.
      // Use 1011 (unexpected condition) as a safe fallback.
      const safeCode = event.code === 1006 || event.code === 1005 ? 1011 : event.code;
      try {
        serverWs.close(safeCode, reason);
      } catch (closeErr) {
        console.error('[WS] Failed to close client WebSocket:', closeErr);
      }
    });

    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      try { containerWs.close(1011, 'Client error'); } catch { /* already closed */ }
    });

    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      try { serverWs.close(1011, 'Container error'); } catch { /* already closed */ }
    });

    if (debugLogs) {
      console.log('[WS] Returning intercepted WebSocket response');
    }
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);

  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

export default {
  fetch: app.fetch,
};
