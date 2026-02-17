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

  const agentName = parts[0];

  // Skip reserved/infrastructure subdomains
  if (RESERVED_SUBDOMAINS.has(agentName)) return null;

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
