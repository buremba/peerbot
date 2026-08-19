/**
 * Automation run arm.
 *
 * The connector-worker daemon claims connector sync/action/auth/embed jobs. For
 * `run_type='automation'` (device mode only — the gateway never hands an
 * automation run to a trusted fleet worker), the daemon now spawns the user's
 * local agent CLI (`claude`, `codex`, …) the same way the Mac app's
 * `AutomationDispatcher` does: build the prompt from the poll envelope, spawn
 * headless, heartbeat, then post the process exit to `/complete-automation` and
 * honour the server's `resume` decision.
 *
 * Ported from `packages/owletto`'s `AutomationDispatcher` (AgentSpec routing,
 * `SpecExecutor` subprocess supervision, and the finalize/resume loop). The
 * prompt and the `AgentSpec` table now live in
 * `@lobu/core/contracts/worker/device-automation`, so the two runtimes cannot
 * drift.
 *
 * Unlike connector children (which inherit a small system-env allowlist), the
 * spawned agent CLI must run as the user: it inherits the daemon's environment
 * (PATH, HOME, the user's CLI credentials) minus `WORKER_API_TOKEN`, which the
 * CLI must never see — it authenticates through its own `~/.config/lobu`
 * credentials or the MCP bearer wired per-spec.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  buildDeviceAutomationPrompt,
  DEVICE_AGENT_SPECS_BY_KIND,
  type AgentKind,
  type AgentSpec,
} from '@lobu/core/contracts/worker/device-automation';
import type {
  AutomationPollPayload,
  CompleteAutomationResponse,
  PollResponse,
  WorkerExitReason,
} from '@lobu/core/contracts/worker/protocol';
import type { ExecutorClient } from './client.js';
import { WorkerDecodeError, WorkerHttpError } from './client.js';
import type { ExecutorConfig } from './executor.js';
import { log } from './log.js';

/** Local-CLI run result, mirrored from the Mac app's `ExecutorResult`. */
export interface ExecutorResult {
  output: string;
  error: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitReason: WorkerExitReason;
  durationMs: number;
}

const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 1 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;
const LOCAL_MAX_ROUNDS = 8;
const EXIT_REPORT_DELIVERY_ATTEMPTS = 3;
const EXIT_REPORT_RETRY_DELAY_MS = 2000;

/** Sentinel for "binary not on PATH" so it maps to a distinct exit reason. */
class ExecutableNotFoundError extends Error {
  constructor(name: string) {
    super(`${name} binary not found on PATH`);
    this.name = 'ExecutableNotFoundError';
  }
}

/** Search prefixes for CLI discovery — mirrors the Mac app's detector list. */
function searchDirs(): string[] {
  const home = homedir();
  return [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

function locateBinary(name: string): string | null {
  const dirs = [
    ...searchDirs(),
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drain a child stream to a byte-capped buffer; stop at EOF. */
function drain(stream: Readable, capBytes: number): Promise<{ data: Buffer; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    stream.on('data', (chunk: Buffer) => {
      if (total < capBytes) {
        const room = capBytes - total;
        if (chunk.length > room) {
          truncated = true;
          chunks.push(chunk.subarray(0, room));
          total += room;
        } else {
          chunks.push(chunk);
          total += chunk.length;
        }
      } else {
        truncated = true;
      }
    });
    const settle = () => resolve({ data: Buffer.concat(chunks), truncated });
    stream.on('end', settle);
    stream.on('error', settle);
    // `close` covers the forced-destroy path below, which emits neither.
    stream.on('close', settle);
  });
}

/**
 * Await a drain with a hard deadline. A grandchild that inherited the child's
 * pipes can hold the read end open after the child is reaped, so an unbounded
 * wait here would hang the run forever — claimed, heartbeating, never swept.
 * Past the deadline, force-close the pipe and take what was flushed.
 */
async function awaitDrain(
  pending: Promise<{ data: Buffer; truncated: boolean }>,
  stream: Readable,
  deadlineMs: number
): Promise<{ data: Buffer; truncated: boolean }> {
  const expired = Symbol('drain-deadline');
  const outcome = await Promise.race([
    pending,
    new Promise<typeof expired>((resolve) => {
      setTimeout(() => resolve(expired), deadlineMs).unref?.();
    }),
  ]);
  if (outcome !== expired) return outcome;
  stream.destroy();
  return pending;
}

/** Wait for the child to exit, or report the timeout lapsed. */
function waitForExit(
  proc: ChildProcess,
  timeoutMs: number
): Promise<{ timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const onExit = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false });
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.removeListener('exit', onExit);
        resolve({ timedOut: true });
      }
    }, timeoutMs);
    timer.unref?.();
    proc.once('exit', onExit);
  });
}

/** Assemble argv from the spec + execution config, mirroring `SpecExecutor`. */
export function buildArguments(
  spec: AgentSpec,
  prompt: string,
  config: AutomationPollPayload['automation']['execution_config'],
  mcpArgs: string[],
  timeoutSeconds: number
): string[] {
  const args: string[] = [];
  let trailingPrompt: string | undefined;
  if (spec.promptDelivery.kind === 'flag') {
    args.push(spec.promptDelivery.flag, prompt);
  } else {
    args.push(...spec.promptDelivery.subcommand);
    trailingPrompt = prompt;
  }
  args.push(...spec.headlessArgs);
  args.push(...mcpArgs);
  if (spec.timeoutFlag) {
    const seconds = Math.max(1, Math.trunc(timeoutSeconds));
    args.push(spec.timeoutFlag.flag, `${seconds}${spec.timeoutFlag.suffix}`);
  }
  if (config) {
    if (config.model && config.model !== '' && spec.modelFlag) {
      args.push(spec.modelFlag, config.model);
    }
    if (config.max_budget_usd && config.max_budget_usd > 0 && spec.budgetFlag) {
      args.push(spec.budgetFlag, String(config.max_budget_usd));
    }
    if (config.permission_mode && config.permission_mode !== '' && spec.permissionModeFlag) {
      args.push(spec.permissionModeFlag, config.permission_mode);
    }
    if (config.effort && config.effort !== '' && spec.effortFlag) {
      args.push(spec.effortFlag, config.effort);
    }
  }
  args.push(...spec.trailingArgs);
  if (trailingPrompt !== undefined) args.push(trailingPrompt);
  return args;
}

/** Build the MCP wiring args/env for the spawned CLI (if the client has any). */
function buildMcp(
  spec: AgentSpec,
  mcpWiring: { url: string; bearer?: string } | undefined
): { mcpArgs: string[]; mcpEnv: Record<string, string>; cleanup: () => void } {
  const mcpArgs: string[] = [];
  const mcpEnv: Record<string, string> = {};
  let cleanup = () => {};
  if (!mcpWiring) return { mcpArgs, mcpEnv, cleanup };

  const bearer = mcpWiring.bearer ?? '';
  if (spec.mcpDelivery.kind === 'claude-config-file') {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-automation-mcp-'));
    const file = path.join(dir, 'mcp.json');
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          lobu: {
            type: 'http',
            url: mcpWiring.url,
            headers: { Authorization: `Bearer ${bearer}` },
          },
        },
      }),
      { mode: 0o600 }
    );
    mcpArgs.push(spec.mcpDelivery.flag, file, ...spec.mcpDelivery.extraArgs);
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  } else if (spec.mcpDelivery.kind === 'opencode-config-env') {
    mcpEnv[spec.mcpDelivery.variable] = JSON.stringify({
      mcp: {
        lobu: {
          type: 'remote',
          url: mcpWiring.url,
          headers: { Authorization: `Bearer ${bearer}` },
          enabled: true,
        },
      },
    });
  }
  return { mcpArgs, mcpEnv, cleanup };
}

/** Spawn one CLI run and classify how it ended. */
async function runCli(
  spec: AgentSpec,
  prompt: string,
  config: AutomationPollPayload['automation']['execution_config'],
  mcpWiring: { url: string; bearer?: string } | undefined,
  timeoutMs: number,
  binaryPath?: string
): Promise<ExecutorResult> {
  const binary = binaryPath ?? locateBinary(spec.binaryName);
  if (!binary || !existsSync(binary)) throw new ExecutableNotFoundError(spec.binaryName);

  const { mcpArgs, mcpEnv, cleanup } = buildMcp(spec, mcpWiring);
  try {
    const args = buildArguments(spec, prompt, config, mcpArgs, timeoutMs / 1000);
    const started = Date.now();

    // Inherit the user's environment (PATH, HOME, CLI credentials) but never
    // leak the daemon's worker token into the spawned agent.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.WORKER_API_TOKEN;
    for (const [key, value] of Object.entries(mcpEnv)) env[key] = value;
    // GUI/app-launched daemons can have a stripped PATH; re-add common installs.
    const extraPath = searchDirs().join(':');
    const currentPath = env.PATH ?? '/usr/bin:/bin';
    if (!currentPath.includes('/.local/bin')) {
      env.PATH = `${extraPath}:${currentPath}`;
    }

    const proc = spawn(binary, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutPromise = drain(proc.stdout, STDOUT_CAP);
    const stderrPromise = drain(proc.stderr, STDERR_CAP);

    const { timedOut } = await waitForExit(proc, timeoutMs);
    let killedSignal: string | null = null;
    if (timedOut) {
      proc.kill('SIGTERM');
      killedSignal = 'SIGTERM';
      await sleep(3000);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
        killedSignal = 'SIGKILL';
      }
      // Bounded wait for the process to be reaped so the pipes flush.
      await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        sleep(5000),
      ]);
    }

    // A SIGKILLed child gets a short flush window; a clean exit gets a long one.
    const drainDeadlineMs = killedSignal === 'SIGKILL' ? 2000 : 60_000;
    // Both pipes must race the SAME clock. Awaiting them in sequence gave
    // stderr a fresh deadline only after stdout's had expired, so a grandchild
    // holding both ends cost 2x the deadline (measured: 120s for a child that
    // had already exited cleanly), not the one window the constant describes.
    const [
      { data: stdoutData, truncated: stdoutTruncated },
      { data: stderrData },
    ] = await Promise.all([
      awaitDrain(stdoutPromise, proc.stdout, drainDeadlineMs),
      awaitDrain(stderrPromise, proc.stderr, drainDeadlineMs),
    ]);

    const label = spec.binaryName;
    const exitCode = proc.exitCode;
    const exitSignal =
      killedSignal ?? (proc.signalCode != null ? `signal:${proc.signalCode}` : null);

    let exitReason: WorkerExitReason;
    let errorMessage: string | null;
    if (timedOut) {
      exitReason = 'timeout';
      errorMessage = `${label} exited via ${killedSignal ?? 'SIGTERM'} after ${Math.trunc(timeoutMs / 1000)}s timeout`;
    } else if (exitCode === 0) {
      exitReason = 'ok';
      errorMessage = null;
    } else if (proc.signalCode != null) {
      exitReason = 'crash';
      errorMessage = `${label} exited via signal (status=${proc.signalCode})`;
    } else {
      exitReason = 'error_message';
      // Prefer stderr, but fall back to the tail of stdout. `claude` prints its
      // fatal there ("Credit balance is too low") and leaves stderr empty, so
      // reading stderr alone reported the most likely real failure as a bare
      // "exited with non-zero status 1" with the cause only in output_tail.
      const detail =
        stderrData.toString('utf8').trim() ||
        stdoutData.toString('utf8').trim().slice(-500);
      errorMessage =
        detail === ''
          ? `${label} exited with non-zero status ${exitCode}`
          : `${label} exited with status ${exitCode}: ${detail}`;
    }

    let output = stdoutData.toString('utf8');
    if (stdoutTruncated) output += '\n[output truncated]';
    const durationMs = Date.now() - started;

    return {
      output,
      error: errorMessage,
      exitCode,
      exitSignal,
      exitReason,
      durationMs,
    };
  } finally {
    cleanup();
  }
}

/**
 * A delivery failure's retry classification: HTTP 5xx/429 and transport errors
 * are retriable; a server answer we could not read (decode) or a 4xx is not.
 */
function isRetriableDeliveryFailure(err: unknown): boolean {
  if (err instanceof WorkerHttpError) return err.status >= 500 || err.status === 429;
  if (err instanceof WorkerDecodeError) return false;
  return true;
}

/** The CLI spawn + exit-report seams the resume loop drives. Injecting them is
 * how the loop is tested without spawning a real CLI or hitting the network —
 * the same seam `AutomationDispatcher` exposes via its `LocalAgentExecutor`
 * protocol. */
export interface AutomationRunIo {
  /** Spawn one CLI run (with any finalize nudge appended) and classify its exit. */
  run: (finalizeNudge: string | undefined) => Promise<ExecutorResult>;
  /** Post one exit report, retrying on retriable failures; null = unknown. */
  deliver: (
    result: ExecutorResult,
    finalizeAttempt: number
  ) => Promise<CompleteAutomationResponse | null>;
  /** Best-effort local-failure report so the run does not sit `running`. */
  reportError: (error: string, reason: WorkerExitReason) => Promise<void>;
}

/**
 * Execute a device automation run: spawn the local CLI per its AgentSpec, then
 * post the exit report and honour the server's `resume` decision.
 */
export async function executeAutomationRun(
  client: ExecutorClient,
  job: PollResponse,
  cfg: ExecutorConfig
): Promise<{ itemsCollected: number; error?: string }> {
  const runId = job.run_id;
  const payload = job.payload;
  if (runId == null) {
    return { itemsCollected: 0, error: 'automation run missing run_id' };
  }
  if (!payload) {
    const message = 'automation run missing payload envelope';
    await completeAutomationWithError(client, runId, message, 'error_message');
    return { itemsCollected: 0, error: message };
  }

  const kind = payload.automation.agent_kind ?? null;
  const spec = kind != null ? DEVICE_AGENT_SPECS_BY_KIND.get(kind as AgentKind) : undefined;
  if (!spec) {
    const message = `no local agent executor configured for agent_kind='${kind ?? '(unset)'}'`;
    log.info(`[executor] Automation run ${runId}: ${message}`);
    await completeAutomationWithError(client, runId, message, 'error_message');
    return { itemsCollected: 0, error: message };
  }

  log.info(
    `[executor] Starting automation run ${runId} (agent=${spec.binaryName})`
  );

  const configuredTimeout = payload.automation.execution_config?.timeout_seconds;
  const timeoutMs =
    configuredTimeout != null && configuredTimeout > 0
      ? configuredTimeout * 1000
      : (cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Heartbeat the run while the CLI executes so the server's stale-run sweeper
  // can distinguish a live turn from an abandoned one.
  const heartbeat = setInterval(() => {
    client.heartbeat(runId).catch((err) => {
      log.debug('[executor] Automation heartbeat failed:', err);
    });
  }, cfg.heartbeatIntervalMs ?? 30_000);

  const io: AutomationRunIo = {
    run: async (finalizeNudge) => {
      let prompt = buildDeviceAutomationPrompt(payload, runId);
      if (finalizeNudge && finalizeNudge !== '') {
        prompt += `\n\n---\nFINALIZE NUDGE (prior attempt did not complete the window):\n${finalizeNudge}\n`;
      }
      return runCli(
        spec,
        prompt,
        payload.automation.execution_config,
        client.mcpWiring,
        timeoutMs,
        cfg.binaryOverrides?.[spec.kind]
      );
    },
    deliver: (result, finalizeAttempt) =>
      deliverExitReport(client, runId, result, finalizeAttempt),
    reportError: (error, reason) =>
      completeAutomationWithError(client, runId, error, reason),
  };

  try {
    return await dispatchAutomationResumeLoop(io);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Spawn → exit report → resume loop, mirroring `AutomationDispatcher.dispatch`. */
export async function dispatchAutomationResumeLoop(
  io: AutomationRunIo
): Promise<{ itemsCollected: number; error?: string }> {
  let finalizeNudge: string | undefined;
  let finalizeAttempt = 0;

  for (let round = 0; round < LOCAL_MAX_ROUNDS; round++) {
    let result: ExecutorResult;
    try {
      result = await io.run(finalizeNudge);
    } catch (err) {
      // Unambiguous: nothing has been reported yet. Missing binary is a
      // configuration problem, not a crash.
      const reason: WorkerExitReason =
        err instanceof ExecutableNotFoundError ? 'error_message' : 'crash';
      const message = err instanceof Error ? err.message : String(err);
      await io.reportError(message, reason);
      return { itemsCollected: 0, error: message };
    }

    const report = await io.deliver(result, finalizeAttempt);
    if (!report) {
      // Outcome unknown after the retry budget. Leave the run claimed and say
      // nothing: heartbeats stop when we return, so the server's heartbeat-stale
      // reaper reclaims it in minutes if the report never landed.
      log.info(
        '[executor] Automation run exit report undelivered — leaving the run to the server sweep'
      );
      return { itemsCollected: 0 };
    }

    if (report.status === 'resume') {
      finalizeNudge =
        report.nudge ??
        report.error ??
        'Prior attempt did not call completeWindow. Finalize via lobu CLI or MCP.';
      finalizeAttempt = report.attempt ?? finalizeAttempt + 1;
      continue;
    }
    return { itemsCollected: 0 };
  }

  // Every path out of the loop is a delivered report that came back `resume`:
  // the server granted past its own budget. Report the honest description.
  const message = `device finalize resume loop exceeded local safety cap (${LOCAL_MAX_ROUNDS})`;
  await io.reportError(message, 'error_message');
  return { itemsCollected: 0, error: message };
}

/** Post one exit report, re-sending on retriable failures. */
export async function deliverExitReport(
  client: ExecutorClient,
  runId: number,
  result: ExecutorResult,
  finalizeAttempt: number
): Promise<CompleteAutomationResponse | null> {
  for (let attempt = 0; attempt < EXIT_REPORT_DELIVERY_ATTEMPTS; attempt++) {
    try {
      return await client.completeAutomation(runId, {
        worker_id: client.id,
        output: result.output,
        error: result.error ?? undefined,
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        exit_signal: result.exitSignal,
        exit_reason: result.exitReason,
        finalize_attempt: finalizeAttempt,
      });
    } catch (err) {
      const retriable = isRetriableDeliveryFailure(err);
      log.debug(
        `[executor] Automation run=${runId} exit report delivery failed ` +
          `(try ${attempt + 1}/${EXIT_REPORT_DELIVERY_ATTEMPTS}, retriable=${retriable ? 'yes' : 'no'}): ` +
          (err instanceof Error ? err.message : String(err))
      );
      if (!retriable) return null;
      if (attempt + 1 < EXIT_REPORT_DELIVERY_ATTEMPTS) {
        await sleep(EXIT_REPORT_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  return null;
}

/** Best-effort: tell the server this run failed locally so it does not sit
 * `running` forever. */
async function completeAutomationWithError(
  client: ExecutorClient,
  runId: number,
  error: string,
  exitReason: WorkerExitReason
): Promise<void> {
  try {
    await client.completeAutomation(runId, {
      worker_id: client.id,
      output: '',
      error,
      duration_ms: 0,
      exit_reason: exitReason,
    });
  } catch {
    // Swallowed — the run times out server-side via the heartbeat watchdog.
  }
}
