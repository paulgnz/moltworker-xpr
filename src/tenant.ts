/**
 * Multi-tenant support for shared gateway mode.
 *
 * In multi-tenant mode (AGENT_KV binding present), each agent gets its own
 * isolated Sandbox DO instance via `getSandbox(env.Sandbox, agentName)`.
 * Per-agent secrets are stored in a KV namespace keyed by `agent:{name}`.
 *
 * In single-tenant mode (no AGENT_KV), behavior is unchanged — the sandbox
 * ID is fixed to 'moltbot' and all config comes from Worker secrets.
 */

import type { MoltbotEnv } from './types';

/**
 * Per-agent configuration stored in KV.
 * Key format: `agent:{agentName}`
 * Must match KVAgentConfig in xpr-deploy-service/src/cloudflare.ts.
 */
export interface TenantConfig {
  agentAccount: string;
  owner: string;
  xprAccount: string;
  xprPrivateKey: string;
  xprNetwork: string;
  xprRpcEndpoint: string;
  anthropicApiKey: string;
  openclawHookToken: string;
  moltbotGatewayToken: string;
  xprOwnerAccount: string;
  xprIndexerUrl?: string;
  sandboxSleepAfter?: string;
  telegramBotToken?: string;
  discordBotToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
}

/**
 * Check if the worker is running in multi-tenant mode.
 * Multi-tenant mode is active when the AGENT_KV binding exists.
 */
export function isMultiTenant(env: MoltbotEnv): boolean {
  return !!env.AGENT_KV;
}

/** Subdomains that are NOT agent names (infrastructure, etc.) */
const RESERVED_SUBDOMAINS = new Set([
  'www', 'deploy', 'api', 'app', 'admin', 'mail', 'smtp', 'imap',
  'ftp', 'ns1', 'ns2', 'cdn', 'static', 'assets', 'docs',
  'xpr-agent-sandbox', // workers.dev name
]);

/**
 * Resolve agent name from hostname subdomain.
 * e.g., `charliebot.xpragents.com` → `"charliebot"`
 *
 * Returns null if no subdomain can be extracted (e.g., bare domain or workers.dev).
 */
export function resolveAgentFromHostname(hostname: string): string | null {
  if (!hostname) return null;

  // Strip port if present
  const host = hostname.split(':')[0];

  // Match pattern: {agent}.xpragents.com or {agent}.{subdomain}.workers.dev
  const parts = host.split('.');

  // Need at least 3 parts: agent.domain.tld
  if (parts.length < 3) return null;

  const subdomain = parts[0];

  // Skip reserved/infrastructure subdomains
  if (RESERVED_SUBDOMAINS.has(subdomain)) return null;

  // EOSIO names use dots (a-z, 1-5, .) but dots can't appear in subdomains,
  // so the deploy service replaces dots with hyphens in URLs.
  // Since EOSIO names never contain hyphens, this conversion is unambiguous.
  const agentName = subdomain.includes('-') ? subdomain.replace(/-/g, '.') : subdomain;

  // Sanity check: must be a valid EOSIO name (1-12 chars, a-z.1-5)
  if (!/^[a-z1-5.]{1,12}$/.test(agentName)) return null;

  return agentName;
}

/**
 * Load tenant configuration from KV.
 * Returns null if tenant is not found.
 */
export async function getTenantConfig(
  kv: KVNamespace,
  agentName: string,
): Promise<TenantConfig | null> {
  const key = `agent:${agentName}`;
  const raw = await kv.get(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as TenantConfig;
  } catch {
    console.error(`[tenant] Failed to parse config for ${key}`);
    return null;
  }
}

/**
 * Merge tenant-specific KV config into the global worker environment.
 * Overlays all tenant fields onto env so downstream code (buildEnvVars,
 * auth middleware, rclone sync, etc.) works without per-field plumbing.
 */
export function mergeTenantEnv(env: MoltbotEnv, config: TenantConfig): void {
  // AI provider
  if (config.anthropicApiKey) env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  // XPR Network
  env.XPR_ACCOUNT = config.xprAccount;
  env.XPR_PRIVATE_KEY = config.xprPrivateKey;
  env.XPR_NETWORK = config.xprNetwork;
  env.XPR_RPC_ENDPOINT = config.xprRpcEndpoint;
  env.XPR_OWNER_ACCOUNT = config.xprOwnerAccount;
  if (config.xprIndexerUrl) env.XPR_INDEXER_URL = config.xprIndexerUrl;
  // Auth tokens
  env.OPENCLAW_HOOK_TOKEN = config.openclawHookToken;
  env.MOLTBOT_GATEWAY_TOKEN = config.moltbotGatewayToken;
  // Container sleep
  if (config.sandboxSleepAfter) env.SANDBOX_SLEEP_AFTER = config.sandboxSleepAfter;
  // Chat channels (only override if set in KV)
  if (config.telegramBotToken) env.TELEGRAM_BOT_TOKEN = config.telegramBotToken;
  if (config.discordBotToken) env.DISCORD_BOT_TOKEN = config.discordBotToken;
  if (config.slackBotToken) env.SLACK_BOT_TOKEN = config.slackBotToken;
  if (config.slackAppToken) env.SLACK_APP_TOKEN = config.slackAppToken;
  // Tenant marker (used by R2 sync for path isolation)
  env.TENANT_ID = config.agentAccount;
}
