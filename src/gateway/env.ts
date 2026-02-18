import type { MoltbotEnv } from '../types';
import type { TenantConfig } from '../tenant';

/**
 * Build environment variables to pass to the OpenClaw container process
 *
 * @param env - Worker environment bindings
 * @returns Environment variables record
 */
export function buildEnvVars(env: MoltbotEnv): Record<string, string> {
  const envVars: Record<string, string> = {};

  // Cloudflare AI Gateway configuration (new native provider)
  if (env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
    envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  }
  if (env.CF_AI_GATEWAY_ACCOUNT_ID) {
    envVars.CF_AI_GATEWAY_ACCOUNT_ID = env.CF_AI_GATEWAY_ACCOUNT_ID;
  }
  if (env.CF_AI_GATEWAY_GATEWAY_ID) {
    envVars.CF_AI_GATEWAY_GATEWAY_ID = env.CF_AI_GATEWAY_GATEWAY_ID;
  }

  // Direct provider keys
  if (env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;

  // Legacy AI Gateway support: AI_GATEWAY_BASE_URL + AI_GATEWAY_API_KEY
  // When set, these override direct keys for backward compatibility
  if (env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
    const normalizedBaseUrl = env.AI_GATEWAY_BASE_URL.replace(/\/+$/, '');
    envVars.AI_GATEWAY_BASE_URL = normalizedBaseUrl;
    // Legacy path routes through Anthropic base URL
    envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
    envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
  } else if (env.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }

  // Map MOLTBOT_GATEWAY_TOKEN to OPENCLAW_GATEWAY_TOKEN (container expects this name)
  if (env.MOLTBOT_GATEWAY_TOKEN) envVars.OPENCLAW_GATEWAY_TOKEN = env.MOLTBOT_GATEWAY_TOKEN;
  if (env.DEV_MODE) envVars.OPENCLAW_DEV_MODE = env.DEV_MODE;
  if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_DM_POLICY) envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_DM_POLICY) envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  if (env.CF_AI_GATEWAY_MODEL) envVars.CF_AI_GATEWAY_MODEL = env.CF_AI_GATEWAY_MODEL;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;
  if (env.CDP_SECRET) envVars.CDP_SECRET = env.CDP_SECRET;
  if (env.WORKER_URL) envVars.WORKER_URL = env.WORKER_URL;

  // R2 persistence credentials (used by rclone in start-openclaw.sh)
  if (env.R2_ACCESS_KEY_ID) envVars.R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
  if (env.R2_SECRET_ACCESS_KEY) envVars.R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY;
  if (env.R2_BUCKET_NAME) envVars.R2_BUCKET_NAME = env.R2_BUCKET_NAME;

  // XPR Network agent configuration
  if (env.XPR_ACCOUNT) envVars.XPR_ACCOUNT = env.XPR_ACCOUNT;
  if (env.XPR_PRIVATE_KEY) envVars.XPR_PRIVATE_KEY = env.XPR_PRIVATE_KEY;
  if (env.XPR_NETWORK) envVars.XPR_NETWORK = env.XPR_NETWORK;
  if (env.XPR_RPC_ENDPOINT) envVars.XPR_RPC_ENDPOINT = env.XPR_RPC_ENDPOINT;
  if (env.XPR_INDEXER_URL) envVars.XPR_INDEXER_URL = env.XPR_INDEXER_URL;
  if (env.OPENCLAW_HOOK_TOKEN) envVars.OPENCLAW_HOOK_TOKEN = env.OPENCLAW_HOOK_TOKEN;

  return envVars;
}

/**
 * Build environment variables from KV-based tenant config (multi-tenant mode).
 *
 * Merges per-agent secrets from KV with shared infrastructure config
 * (R2 credentials, CF_ACCOUNT_ID) from the Worker's own env.
 *
 * @param config - Per-agent config from KV
 * @param env - Worker environment bindings (shared infra secrets)
 * @param agentName - Agent name used as TENANT_ID for R2 path scoping
 */
export function buildEnvVarsFromConfig(
  config: TenantConfig,
  env: MoltbotEnv,
  agentName: string,
): Record<string, string> {
  const envVars: Record<string, string> = {};

  // TENANT_ID is used by start-openclaw.sh to scope R2 paths
  envVars.TENANT_ID = agentName;

  // AI provider — from tenant config
  if (config.anthropicApiKey) envVars.ANTHROPIC_API_KEY = config.anthropicApiKey;

  // Shared AI Gateway config from Worker env (all tenants share the same gateway)
  if (env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
    envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  }
  if (env.CF_AI_GATEWAY_ACCOUNT_ID) envVars.CF_AI_GATEWAY_ACCOUNT_ID = env.CF_AI_GATEWAY_ACCOUNT_ID;
  if (env.CF_AI_GATEWAY_GATEWAY_ID) envVars.CF_AI_GATEWAY_GATEWAY_ID = env.CF_AI_GATEWAY_GATEWAY_ID;
  if (env.CF_AI_GATEWAY_MODEL) envVars.CF_AI_GATEWAY_MODEL = env.CF_AI_GATEWAY_MODEL;

  // Legacy AI Gateway (from Worker env)
  if (env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
    const normalizedBaseUrl = env.AI_GATEWAY_BASE_URL.replace(/\/+$/, '');
    envVars.AI_GATEWAY_BASE_URL = normalizedBaseUrl;
    envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
    envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
  }

  // OpenClaw v2026.1.29+ requires a token when binding to LAN (--bind lan).
  // Even though the Worker's wallet auth middleware protects the public-facing endpoint,
  // the container gateway still needs a token to start. The Worker injects this token
  // server-side when proxying WebSocket connections to the container.
  if (config.moltbotGatewayToken) {
    envVars.OPENCLAW_GATEWAY_TOKEN = config.moltbotGatewayToken;
  }
  // OPENCLAW_DEV_MODE enables allowInsecureAuth for the Control UI.
  envVars.OPENCLAW_DEV_MODE = 'true';

  // R2 persistence — shared infra credentials
  if (env.R2_ACCESS_KEY_ID) envVars.R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
  if (env.R2_SECRET_ACCESS_KEY) envVars.R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY;
  if (env.R2_BUCKET_NAME) envVars.R2_BUCKET_NAME = env.R2_BUCKET_NAME;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;

  // Chat channels — per-tenant
  if (config.telegramBotToken) envVars.TELEGRAM_BOT_TOKEN = config.telegramBotToken;
  if (config.discordBotToken) envVars.DISCORD_BOT_TOKEN = config.discordBotToken;
  if (config.slackBotToken) envVars.SLACK_BOT_TOKEN = config.slackBotToken;
  if (config.slackAppToken) envVars.SLACK_APP_TOKEN = config.slackAppToken;

  // XPR Network agent — per-tenant
  if (config.xprAccount) envVars.XPR_ACCOUNT = config.xprAccount;
  if (config.xprPrivateKey) envVars.XPR_PRIVATE_KEY = config.xprPrivateKey;
  if (config.xprNetwork) envVars.XPR_NETWORK = config.xprNetwork;
  if (config.xprRpcEndpoint) envVars.XPR_RPC_ENDPOINT = config.xprRpcEndpoint;
  if (config.xprIndexerUrl) envVars.XPR_INDEXER_URL = config.xprIndexerUrl;
  if (config.openclawHookToken) envVars.OPENCLAW_HOOK_TOKEN = config.openclawHookToken;

  // Browser/CDP — shared infra
  if (env.CDP_SECRET) envVars.CDP_SECRET = env.CDP_SECRET;
  if (env.WORKER_URL) envVars.WORKER_URL = env.WORKER_URL;

  return envVars;
}
