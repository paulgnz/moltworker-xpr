import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import type { TenantConfig } from '../tenant';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars, buildEnvVarsFromConfig } from './env';
import { ensureRcloneConfig } from './r2';

/** Per-sandbox dedup locks: prevents concurrent ensureMoltbotGateway calls per tenant.
 *  Keyed by sandbox ID (agent name or 'moltbot' for single-tenant). */
const startupPromises = new Map<string, Promise<Process>>();

/**
 * Check if a process command matches a gateway process (not a CLI helper).
 */
function isGatewayCommand(command: string): boolean {
  const isGateway =
    command.includes('start-openclaw.sh') ||
    command.includes('openclaw gateway') ||
    command.includes('start-moltbot.sh') ||
    command.includes('clawdbot gateway');
  const isCli =
    command.includes('openclaw devices') ||
    command.includes('openclaw --version') ||
    command.includes('openclaw onboard') ||
    command.includes('clawdbot devices') ||
    command.includes('clawdbot --version');
  return isGateway && !isCli;
}

/**
 * Find an existing OpenClaw gateway process
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      if (isGatewayCommand(proc.command)) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Kill ALL gateway processes (not just the first one).
 * Prevents zombie process accumulation.
 */
async function killAllGatewayProcesses(sandbox: Sandbox): Promise<number> {
  let killed = 0;
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      if (isGatewayCommand(proc.command) && (proc.status === 'starting' || proc.status === 'running')) {
        try {
          await proc.kill();
          killed++;
        } catch (e) {
          console.log('Failed to kill process', proc.id, ':', e);
        }
      }
    }
  } catch (e) {
    console.log('Could not list/kill processes:', e);
  }
  if (killed > 0) {
    console.log(`[Gateway] Killed ${killed} zombie gateway process(es)`);
  }
  return killed;
}

/**
 * Ensure the OpenClaw gateway is running.
 * Deduplicates concurrent calls per sandbox — if a startup is already in-flight
 * for this sandbox, joins it instead of racing.
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param tenantConfig - Per-agent config from KV (multi-tenant mode)
 * @param sandboxId - Unique ID for this sandbox (agent name or 'moltbot')
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv, tenantConfig?: TenantConfig, sandboxId = 'moltbot'): Promise<Process> {
  // Dedup: if a startup is already in-flight for this sandbox, join it
  const existing = startupPromises.get(sandboxId);
  if (existing) {
    console.log(`[Gateway] Joining existing startup for '${sandboxId}'...`);
    return existing;
  }

  const promise = doEnsureMoltbotGateway(sandbox, env, tenantConfig)
    .finally(() => { startupPromises.delete(sandboxId); });

  startupPromises.set(sandboxId, promise);
  return promise;
}

/**
 * Internal implementation — must only be called via ensureMoltbotGateway().
 */
async function doEnsureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv, tenantConfig?: TenantConfig): Promise<Process> {
  // Configure rclone for R2 persistence (non-blocking if not configured).
  await ensureRcloneConfig(sandbox, env);

  // Check if gateway is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log(
      'Found existing gateway process:',
      existingProcess.id,
      'status:',
      existingProcess.status,
    );

    try {
      console.log('Waiting for gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Gateway is reachable');
      return existingProcess;
      // eslint-disable-next-line no-unused-vars
    } catch (_e) {
      // Timeout — kill ALL gateway processes (not just this one) to clear zombies
      console.log('Existing process not reachable after full timeout, killing ALL gateway processes...');
      await killAllGatewayProcesses(sandbox);
    }
  }

  // Start a new OpenClaw gateway
  console.log('Starting new OpenClaw gateway...');
  const agentName = tenantConfig?.agentAccount;
  const envVars = tenantConfig && agentName
    ? buildEnvVarsFromConfig(tenantConfig, env, agentName)
    : buildEnvVars(env);

  const command = '/usr/local/bin/start-openclaw.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for OpenClaw gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] OpenClaw gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] startup failed. Stderr:', logs.stderr);
      console.error('[Gateway] startup failed. Stdout:', logs.stdout);
      throw new Error(`OpenClaw gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`, {
        cause: e,
      });
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }

  console.log('[Gateway] Verifying gateway health...');
  return process;
}
