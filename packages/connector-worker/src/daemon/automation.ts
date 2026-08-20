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
 * spawned agent CLI runs in the user's environment (PATH, HOME) minus the
 * `WORKER_API_TOKEN` env var, so the child cannot act as the worker/poll loop.
 * Its Lobu credential is the poll envelope's per-run `agent_session` when the
 * server minted one (see `resolveAutomationRunAccess`): the run authenticates
 * as the Automation's assigned agent, not as the daemon or the user's ambient
 * CLI session. The daemon's own bearer remains only the fallback for a run the
 * server sent no session for — an older server, or one that could not mint.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { locateBinary, searchDirs } from './agent-binaries.js';
import type { ExecutorClient } from './client.js';
import { WorkerDecodeError, WorkerHttpError } from './client.js';
import { log } from './log.js';
import {
  detectParentClaudeSession,
  handoffToParentClaude,
  type ParentClaudeSession,
} from './parent-claude.js';

/**
 * The slice of the daemon's `ExecutorConfig` the automation arm reads.
 *
 * Declared narrowly so a caller that only executes automations — the one-shot
 * `executeClaimedAutomationRun` entry point — does not have to fabricate
 * connector-sync fields (`batchSize`, `generateEmbeddings`, `maxOldSpaceSize`)
 * that this arm never touches. The daemon's full `ExecutorConfig` is
 * structurally assignable to it.
 */
export interface AutomationExecutorConfig {
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Opt-in demo: hand Claude Code Automations to the interactive parent. */
  insideClaude?: boolean;
  /** Stops a pending parent handoff during daemon shutdown. */
  shutdownSignal?: AbortSignal;
  /** Grace for a CLI that completed the run over MCP and is winding down. */
  terminalHeartbeatGraceMs?: number;
  /**
   * Agent to use when the Automation names no `agent_kind`.
   *
   * The device, not the server, owns this choice: `agent_kind` is optional on
   * the wire (`AutomationPollMetaSchema`), and which CLIs are actually
   * installed is a property of the machine. The Mac app has always resolved it
   * from the user's menubar pick; without it here, every Automation created
   * without an explicit kind fails on the device with "no local agent executor
   * configured".
   */
  defaultAgentKind?: AgentKind;
  /**
   * Explicit per-agent binary paths (else PATH lookup). Lets an operator point
   * at a non-PATH CLI install, and is the injection seam the automation tests
   * use to drive a fake binary.
   */
  binaryOverrides?: Partial<Record<AgentKind, string>>;
}

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
/** Cap on the CLI-output tail folded into `runs.error_message`. */
const DETAIL_TAIL_CHARS = 500;
const LOCAL_MAX_ROUNDS = 8;
const EXIT_REPORT_DELIVERY_ATTEMPTS = 3;
const EXIT_REPORT_RETRY_DELAY_MS = 2000;
const TERMINAL_HEARTBEAT_GRACE_MS = 15_000;
const SUPPORTS_PROCESS_GROUPS = process.platform !== 'win32';
const POSIX_TREE_TERM_GRACE_MS = 3000;
const PROCESS_REAP_GRACE_MS = 5000;

/**
 * Keep a process-group leader alive after the actual CLI exits. The daemon can
 * then clean up descendants through an identity that the kernel cannot recycle
 * underneath it. The supervisor deliberately ignores SIGTERM; the CLI and its
 * descendants still receive the group signal, while the supervisor remains the
 * ownership anchor until the daemon releases or SIGKILLs it.
 */
export const CLI_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require('node:child_process');
const [binary, ...args] = process.argv.slice(1);
let targetFinished = false;
let parentLost = false;
let target;
const keepAlive = setInterval(() => {}, 2147483647);
const send = (message) => {
  try { process.send?.(message); } catch {}
};
const finish = (code, signal, error) => {
  if (targetFinished) return;
  targetFinished = true;
  if (!parentLost) send({ type: 'target-exit', code, signal, error });
};
const stopAfterParentLoss = () => {
  if (parentLost) return;
  parentLost = true;
  clearInterval(keepAlive);

  if (process.platform === 'win32') {
    // Keep this process alive as the tree root until taskkill gets its chance.
    // The timer is deliberately ref'ed: parent loss must not let the supervisor
    // exit before the owned CLI tree has been addressed.
    try {
      const killer = spawn('taskkill', ['/PID', String(process.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {});
    } catch {}
    setTimeout(() => {
      try { target?.kill('SIGKILL'); } catch {}
      process.exit(1);
    }, 3000);
    return;
  }

  // This detached supervisor is still the live session/group leader, so its
  // own negative pid cannot have been recycled. Ignore SIGTERM here while the
  // target and descendants get a graceful window, then kill the complete group
  // including this anchor so parent loss cannot leave an immortal orphan.
  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {
    try { target?.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      try { target?.kill('SIGKILL'); } catch {}
      process.exit(1);
    }
  }, 3000);
};
process.on('SIGTERM', () => {});
process.once('disconnect', stopAfterParentLoss);
process.on('message', (message) => {
  if (message?.type !== 'release' || !targetFinished) return;
  clearInterval(keepAlive);
  process.exit(0);
});
if (!binary) {
  finish(127, null, 'automation supervisor missing target binary');
} else {
  try {
    target = spawn(binary, args, {
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
  } catch (error) {
    finish(127, null, error instanceof Error ? error.message : String(error));
  }
  target?.once('error', (error) => {
    finish(127, null, error instanceof Error ? error.message : String(error));
  });
  target?.once('exit', (code, signal) => finish(code, signal, null));
}
setImmediate(() => {
  if (!process.connected) stopAfterParentLoss();
});
`;

interface TargetExit {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  error: string | null;
}

interface SupervisedCli {
  supervisor: ChildProcess;
  targetExit: Promise<TargetExit>;
}

/** Sentinel for "binary not on PATH" so it maps to a distinct exit reason. */
class ExecutableNotFoundError extends Error {
  constructor(name: string) {
    super(`${name} binary not found on PATH`);
    this.name = 'ExecutableNotFoundError';
  }
}

/** The server has already finalized or released this claimed run. */
class AutomationRunNoLongerActiveError extends Error {
  constructor() {
    super('automation run is no longer active');
    this.name = 'AutomationRunNoLongerActiveError';
  }
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

/** Wait for the supervised CLI to exit, the timeout to lapse, or cancellation. */
function waitForTargetExit(
  targetExit: Promise<TargetExit>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<{ timedOut: boolean; aborted: boolean; target?: TargetExit }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: {
      timedOut: boolean;
      aborted: boolean;
      target?: TargetExit;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => settle({ timedOut: false, aborted: true });
    const timer = setTimeout(() => {
      settle({ timedOut: true, aborted: false });
    }, timeoutMs);
    timer.unref?.();
    targetExit.then((target) => settle({ timedOut: false, aborted: false, target }));
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wait a bounded interval for a signal sent to the child to take effect. */
function waitForSignalledExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    proc.once('exit', onExit);
  });
}

type ProcessGroupOwner = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>;

/**
 * Signal a POSIX group only while its supervisor is a live ownership anchor.
 * Once the anchor has exited, its numeric pid/pgid may refer to an unrelated
 * future process group and must never be used as a negative-pid signal target.
 * Exported only so the PID-reuse safety invariant has a direct regression test.
 */
export function signalOwnedPosixProcessGroup(
  owner: ProcessGroupOwner,
  signal: NodeJS.Signals,
  sendSignal: typeof process.kill = process.kill
): boolean {
  if (
    !SUPPORTS_PROCESS_GROUPS ||
    owner.pid == null ||
    owner.exitCode !== null ||
    owner.signalCode !== null
  ) {
    return false;
  }
  try {
    sendSignal(-owner.pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

/** Read a snapshot of one POSIX group without signalling its numeric id. */
function listPosixProcessGroupMembers(pgid: number): Promise<number[] | null> {
  const psBinary = existsSync('/bin/ps')
    ? '/bin/ps'
    : existsSync('/usr/bin/ps')
      ? '/usr/bin/ps'
      : 'ps';
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(psBinary, ['-axo', 'pid=,pgid='], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let output = '';
    const settle = (members: number[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(members);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(null);
    }, 1000);
    timer.unref?.();
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      if (output.length < 4 * 1024 * 1024) output += chunk;
    });
    proc.once('error', () => settle(null));
    proc.once('close', (code) => {
      if (code !== 0) {
        settle(null);
        return;
      }
      const members: number[] = [];
      for (const line of output.split('\n')) {
        const [pidText, pgidText] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const rowPgid = Number(pgidText);
        if (Number.isInteger(pid) && rowPgid === pgid) members.push(pid);
      }
      settle(members);
    });
  });
}

/** Ask the supervisor to release its non-reusable group identity and reap it. */
async function releaseSupervisor(proc: ChildProcess, timeoutMs = 1000): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  let sent = false;
  try {
    if (proc.connected) {
      proc.send?.({ type: 'release' });
      sent = true;
    }
  } catch {}
  if (sent && (await waitForSignalledExit(proc, timeoutMs))) return true;
  // Direct ChildProcess.kill uses the still-owned process handle; never turn a
  // failed release into a negative-pgid signal after the anchor might be gone.
  proc.kill('SIGKILL');
  await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
  return false;
}

/**
 * Wait until SIGTERM leaves only the supervisor in its group. Before releasing
 * the anchor, freeze the group and take a second snapshot so no live member can
 * fork across the observation. A process outside this new session cannot join
 * the group, so releasing the sole remaining supervisor is then race-free.
 */
async function waitForOwnedPosixTreeToQuiesce(
  proc: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  const pgid = proc.pid;
  if (pgid == null) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const members = await listPosixProcessGroupMembers(pgid);
    if (members == null) return false;
    if (members.length === 1 && members[0] === pgid) {
      if (!signalOwnedPosixProcessGroup(proc, 'SIGSTOP')) return false;
      const frozenMembers = await listPosixProcessGroupMembers(pgid);
      if (frozenMembers?.length === 1 && frozenMembers[0] === pgid) {
        if (!signalOwnedPosixProcessGroup(proc, 'SIGCONT')) return false;
        return releaseSupervisor(proc);
      }
      // The anchor is still live and stopped, so this cannot target a reused id.
      if (!signalOwnedPosixProcessGroup(proc, 'SIGCONT')) return false;
    }
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return false;
}

/** Windows has no negative-pid process groups; taskkill supplies bounded tree cleanup. */
function taskkillWindowsTree(proc: ChildProcess, force: boolean): Promise<boolean> {
  if (proc.pid == null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const killer = spawn(
      'taskkill',
      ['/PID', String(proc.pid), '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true }
    );
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      killer.kill();
      settle(false);
    }, 3000);
    timer.unref?.();
    killer.once('error', () => settle(false));
    killer.once('exit', (code) => settle(code === 0));
  });
}

/**
 * Keep the supervisor alive until Windows has had its forced tree-kill chance.
 * Killing only the supervisor after a failed graceful `taskkill /T` would
 * orphan the real CLI and make its numeric tree root unusable. Exported, with
 * its collaborators injectable, only so that ordering is testable off Windows.
 */
export async function terminateWindowsProcessTree(
  proc: ChildProcess,
  terminateTree: typeof taskkillWindowsTree = taskkillWindowsTree,
  waitForExit: typeof waitForSignalledExit = waitForSignalledExit
): Promise<'SIGTERM' | 'SIGKILL'> {
  const gracefulTreeKillSent = await terminateTree(proc, false);
  if (gracefulTreeKillSent && (await waitForExit(proc, 3000))) return 'SIGTERM';

  // If taskkill itself is unavailable, direct ChildProcess.kill remains the
  // best-effort fallback. It cannot guarantee cleanup of an already-orphaned
  // descendant, so use it only after the forced tree attempt has failed.
  if (!(await terminateTree(proc, true))) proc.kill('SIGKILL');
  await waitForExit(proc, PROCESS_REAP_GRACE_MS);
  return 'SIGKILL';
}

/**
 * Stop the complete CLI process tree, escalating to SIGKILL if any POSIX group
 * member ignores SIGTERM. Returns the signal that actually ended it, which the
 * timeout branch reports as `exit_signal`.
 */
async function terminateChild(proc: ChildProcess): Promise<'SIGTERM' | 'SIGKILL'> {
  if (SUPPORTS_PROCESS_GROUPS) {
    if (!signalOwnedPosixProcessGroup(proc, 'SIGTERM')) {
      proc.kill('SIGTERM');
      await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
      return 'SIGTERM';
    }
    if (await waitForOwnedPosixTreeToQuiesce(proc, POSIX_TREE_TERM_GRACE_MS)) {
      return 'SIGTERM';
    }
    if (!signalOwnedPosixProcessGroup(proc, 'SIGKILL')) proc.kill('SIGKILL');
    await waitForSignalledExit(proc, PROCESS_REAP_GRACE_MS);
    return 'SIGKILL';
  }

  return terminateWindowsProcessTree(proc);
}

/** Spawn the real CLI beneath a persistent process-group ownership anchor. */
function spawnSupervisedCli(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv
): SupervisedCli {
  const supervisor = spawn(
    process.execPath,
    ['-e', CLI_SUPERVISOR_SOURCE, '--', binary, ...args],
    {
      detached: SUPPORTS_PROCESS_GROUPS,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }
  );
  const targetExit = new Promise<TargetExit>((resolve) => {
    let settled = false;
    const settle = (target: TargetExit) => {
      if (settled) return;
      settled = true;
      resolve(target);
    };
    supervisor.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message == null) return;
      const value = message as Record<string, unknown>;
      if (value.type !== 'target-exit') return;
      settle({
        exitCode: typeof value.code === 'number' ? value.code : null,
        signalCode: typeof value.signal === 'string' ? (value.signal as NodeJS.Signals) : null,
        error: typeof value.error === 'string' ? value.error : null,
      });
    });
    supervisor.once('error', (error) => {
      settle({ exitCode: null, signalCode: null, error: error.message });
    });
    supervisor.once('exit', (code, signal) => {
      settle({
        exitCode: code,
        signalCode: signal,
        error: 'automation process supervisor exited before reporting the CLI outcome',
      });
    });
  });
  return { supervisor, targetExit };
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

/** The credential set one automation run's spawned CLI executes with. */
export interface AutomationRunAccess {
  /** Lobu MCP wiring for the CLI's mcp config (buildMcp). */
  wiring: { url: string; bearer?: string } | undefined;
  /** Extra env for the child process (LOBU_API_TOKEN / LOBU_MEMORY_URL). */
  env: Record<string, string>;
}

/**
 * Resolve what credential the spawned CLI runs with. When the poll envelope
 * carries a per-run `agent_session`, the CLI authenticates as the automation's
 * assigned agent for exactly this run: the session token goes into the MCP
 * wiring AND into LOBU_API_TOKEN/LOBU_MEMORY_URL, which `lobu memory` prefers
 * over the device's ambient CLI session — so an unattended run never acts as
 * the human user or the daemon. Without a session (older server, or a run with
 * no usable assigned agent) fall back to the daemon's own wiring, the
 * pre-session dispatch path.
 */
export function resolveAutomationRunAccess(
  payload: AutomationPollPayload,
  daemonWiring: { url: string; bearer?: string } | undefined
): AutomationRunAccess {
  const session = payload.context.agent_session;
  if (!session) return { wiring: daemonWiring, env: {} };
  return {
    wiring: { url: session.mcp_url, bearer: session.token },
    env: {
      LOBU_API_TOKEN: session.token,
      LOBU_MEMORY_URL: session.mcp_url,
    },
  };
}

/** Parent delivery is deliberately narrower than agent-kind advertisement. */
export function isParentClaudeEligible(
  kind: AgentKind,
  insideClaude: boolean | undefined,
  payload: AutomationPollPayload
): boolean {
  return (
    insideClaude === true &&
    kind === 'claude-code' &&
    payload.context.agent_session != null
  );
}

/** Spawn one CLI run and classify how it ended. */
async function runCli(
  spec: AgentSpec,
  prompt: string,
  config: AutomationPollPayload['automation']['execution_config'],
  access: AutomationRunAccess,
  timeoutMs: number,
  binaryPath?: string,
  abortSignal?: AbortSignal,
  terminalHeartbeatGraceMs = TERMINAL_HEARTBEAT_GRACE_MS
): Promise<ExecutorResult> {
  // One AbortController spans every finalize/resume round. If a terminal 409
  // landed while the prior exit report was in flight, do not start stale work.
  if (abortSignal?.aborted) throw new AutomationRunNoLongerActiveError();

  const binary = binaryPath ?? locateBinary(spec.binaryName);
  if (!binary || !existsSync(binary)) throw new ExecutableNotFoundError(spec.binaryName);

  const { mcpArgs, mcpEnv, cleanup } = buildMcp(spec, access.wiring);
  let supervisor: ChildProcess | undefined;
  let supervisorSettled = false;
  try {
    const args = buildArguments(spec, prompt, config, mcpArgs, timeoutMs / 1000);
    const started = Date.now();

    // Inherit the user's environment (PATH, HOME, CLI credentials) but drop
    // WORKER_API_TOKEN so the child cannot act as the worker/poll loop itself.
    // The run's bearer is wired into the child's MCP config on purpose
    // (buildMcp above) — that is how the spawned CLI reaches Lobu tools, same
    // as the Mac `AutomationDispatcher`; what we withhold is the daemon role.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.WORKER_API_TOKEN;
    for (const [key, value] of Object.entries(mcpEnv)) env[key] = value;
    for (const [key, value] of Object.entries(access.env)) env[key] = value;
    // GUI/app-launched daemons can have a stripped PATH; re-add common installs.
    const extraPath = searchDirs().join(':');
    const currentPath = env.PATH ?? '/usr/bin:/bin';
    if (!currentPath.includes('/.local/bin')) {
      env.PATH = `${extraPath}:${currentPath}`;
    }

    const supervised = spawnSupervisedCli(binary, args, env);
    const proc = supervised.supervisor;
    supervisor = proc;

    const stdoutPromise = drain(proc.stdout!, STDOUT_CAP);
    const stderrPromise = drain(proc.stderr!, STDERR_CAP);

    const initialExit = await waitForTargetExit(supervised.targetExit, timeoutMs, abortSignal);
    const { timedOut, aborted } = initialExit;
    let target = initialExit.target;
    let cancelled = false;
    let killedSignal: string | null = null;
    let cleanupSignal: string | null = null;
    if (aborted) {
      // A 409 is also the normal post-complete_window state. Let a CLI that is
      // already winding down exit and report its device-side metadata. The
      // supervisor remains the non-reusable tree owner throughout the grace,
      // so a normally exiting leader cannot orphan its remaining descendants.
      const gracefulExit = await waitForTargetExit(
        supervised.targetExit,
        terminalHeartbeatGraceMs
      );
      target = gracefulExit.target;
      // Either way the tree must go: a CLI that exited still leaves the
      // supervisor and any descendants it spawned holding the group.
      cancelled = !target;
      cleanupSignal = await terminateChild(proc);
      supervisorSettled = true;
    } else if (timedOut) {
      killedSignal = await terminateChild(proc);
      supervisorSettled = true;
      target = await supervised.targetExit;
    } else {
      await releaseSupervisor(proc);
      supervisorSettled = true;
    }

    // A SIGKILLed child gets a short flush window; a clean exit gets a long one.
    const drainDeadlineMs =
      cancelled || killedSignal === 'SIGKILL' || cleanupSignal === 'SIGKILL' ? 2000 : 60_000;
    // Both pipes must race the SAME clock. Awaiting them in sequence gave
    // stderr a fresh deadline only after stdout's had expired, so a grandchild
    // holding both ends cost 2x the deadline (measured: 120s for a child that
    // had already exited cleanly), not the one window the constant describes.
    const [
      { data: stdoutData, truncated: stdoutTruncated },
      { data: stderrData },
    ] = await Promise.all([
      awaitDrain(stdoutPromise, proc.stdout!, drainDeadlineMs),
      awaitDrain(stderrPromise, proc.stderr!, drainDeadlineMs),
    ]);

    const label = spec.binaryName;
    const exitCode = target?.exitCode ?? null;
    const targetSignal = target?.signalCode ?? null;
    const exitSignal =
      killedSignal ?? cleanupSignal ?? (targetSignal != null ? `signal:${targetSignal}` : null);

    let exitReason: WorkerExitReason;
    let errorMessage: string | null;
    // The last thing the CLI said before it stopped. Prefer stderr, but fall
    // back to stdout. `claude` prints its fatal on stdout ("Credit balance is
    // too low") and leaves stderr empty, so reading stderr alone reported the
    // most likely real failure as a bare "exited with non-zero status 1" with
    // the cause only in output_tail; `opencode` logs to stderr instead. The
    // supervisor's error is the last resort: on SIGKILL escalation the whole
    // group dies before the supervisor can report, and its synthetic message
    // must not mask what the CLI actually wrote. Bounded because this lands in
    // `runs.error_message`, and stderr is capped at 1 MiB.
    const detail = (
      stderrData.toString('utf8').trim() ||
      stdoutData.toString('utf8').trim() ||
      target?.error ||
      ''
    ).slice(-DETAIL_TAIL_CHARS);
    if (cancelled) {
      // The server owns the terminal outcome, but complete-automation remains
      // terminal-safe so it can retain device provenance and duration. Report
      // this intentional local stop as clean instead of inventing a failure.
      exitReason = 'ok';
      errorMessage = null;
    } else if (timedOut) {
      exitReason = 'timeout';
      const deadline = `${label} exited via ${killedSignal ?? 'SIGTERM'} after ${Math.trunc(timeoutMs / 1000)}s timeout`;
      // The deadline alone says nothing about WHY the CLI stalled, and a
      // stalled CLI usually wrote nothing to stdout — so `output_tail` is NULL
      // and this message is the only surviving evidence. Prod #71 failed this
      // way 39 consecutive times and left no diagnosis behind.
      errorMessage = detail === '' ? deadline : `${deadline}: ${detail}`;
    } else if (exitCode === 0) {
      exitReason = 'ok';
      errorMessage = null;
    } else if (targetSignal != null) {
      exitReason = 'crash';
      errorMessage = `${label} exited via signal (status=${targetSignal})`;
    } else {
      exitReason = 'error_message';
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
    if (
      supervisor &&
      !supervisorSettled &&
      supervisor.exitCode === null &&
      supervisor.signalCode === null
    ) {
      await terminateChild(supervisor).catch(() => {
        try {
          supervisor?.kill('SIGKILL');
        } catch {}
      });
    }
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
  cfg: AutomationExecutorConfig
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

  // The Automation's explicit kind wins; the caller's device-level default is
  // the fallback, matching how the Mac app has always resolved an unset kind.
  const kind = payload.automation.agent_kind ?? cfg.defaultAgentKind ?? null;
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

  // Eligibility already required a run-scoped `agent_session`, so capture it
  // alongside the parent session: the two are only ever used together.
  const parentDetection = isParentClaudeEligible(spec.kind, cfg.insideClaude, payload)
    ? detectParentClaudeSession()
    : null;
  const agentSession = payload.context.agent_session;
  const parentSession: ParentClaudeSession | null =
    parentDetection?.ok === true && agentSession ? parentDetection.session : null;
  let executionRoute: 'undecided' | 'parent' | 'subprocess' = parentSession
    ? 'undecided'
    : 'subprocess';

  // Heartbeat the run while the CLI executes so the server's stale-run sweeper
  // can distinguish a live turn from an abandoned one.
  const runAbort = new AbortController();
  const heartbeat = setInterval(() => {
    client.heartbeat(runId).catch((err) => {
      if (err instanceof WorkerHttpError && err.status === 409) {
        if (!runAbort.signal.aborted) {
          log.info(
            `[executor] Automation run ${runId} is no longer active; waiting for the local CLI to exit`
          );
          runAbort.abort();
          // The outcome is already settled server-side; stop beating at a run
          // that will 409 for the rest of the terminal grace.
          clearInterval(heartbeat);
        }
        return;
      }
      log.debug('[executor] Automation heartbeat failed:', err);
    });
  }, cfg.heartbeatIntervalMs ?? 30_000);

  const io: AutomationRunIo = {
    run: async (finalizeNudge) => {
      let prompt = buildDeviceAutomationPrompt(payload, runId);
      if (finalizeNudge && finalizeNudge !== '') {
        prompt += `\n\n---\nFINALIZE NUDGE (prior attempt did not complete the window):\n${finalizeNudge}\n`;
      }
      if (parentSession && agentSession && executionRoute !== 'subprocess') {
        const handoff = await handoffToParentClaude({
          session: parentSession,
          runId,
          prompt,
          token: agentSession.token,
          memoryUrl: agentSession.mcp_url,
          timeoutMs,
          ...(cfg.shutdownSignal ? { shutdownSignal: cfg.shutdownSignal } : {}),
        });
        if (handoff.kind === 'handed-off') {
          executionRoute = 'parent';
          log.info(`[executor] Automation run ${runId} handed to parent Claude session`);
          const completion = await handoff.completion;
          if (completion.kind === 'completed') {
            return {
              output: completion.output,
              error: null,
              exitCode: 0,
              exitSignal: null,
              exitReason: 'ok',
              durationMs: completion.durationMs,
            };
          }
          // No child process ran, so there is no exit code or OS signal to
          // report — `error` carries why the handoff ended.
          return {
            output: '',
            error: completion.error,
            exitCode: null,
            exitSignal: null,
            exitReason: completion.kind === 'timeout' ? 'timeout' : 'crash',
            durationMs: completion.durationMs,
          };
        }

        if (executionRoute === 'parent') {
          // A prior message reached the parent. Never mix in a subprocess,
          // even if a later finalize-nudge delivery fails before writing.
          return {
            output: '',
            error: `parent Claude delivery failed: ${handoff.reason}`,
            exitCode: null,
            exitSignal: null,
            exitReason: 'crash',
            durationMs: 0,
          };
        }
        executionRoute = 'subprocess';
        log.info(
          `[executor] Automation run ${runId}: parent Claude unavailable before delivery; using subprocess`
        );
      }
      return runCli(
        spec,
        prompt,
        payload.automation.execution_config,
        resolveAutomationRunAccess(payload, client.mcpWiring),
        timeoutMs,
        cfg.binaryOverrides?.[spec.kind],
        runAbort.signal,
        cfg.terminalHeartbeatGraceMs
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
      if (err instanceof AutomationRunNoLongerActiveError) {
        // The terminal heartbeat landed before this round spawned, so there is
        // no local process exit or device metadata to report.
        return { itemsCollected: 0 };
      }
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
