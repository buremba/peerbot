import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	AGENT_ERRORS,
	AgentErrorCode,
	ConversationOwnedElsewhereError,
	createLogger,
	ErrorCode,
	extractTraceId,
	generateWorkerToken,
	generateWorkerTokenPair,
	getErrorMessage,
	type MessagePayload,
	normalizeDomainPattern,
	OrchestratorError,
	retryWithBackoff,
} from "@lobu/core";
import { nixPackageAttrRef as nixPackageAttrRefBase } from "@lobu/connector-sdk/nix-package";
import { intervals } from "../../config/intervals.js";
import { getDb } from "../../db/client.js";
import type { ProviderCredentialContext } from "../embedded.js";
import type { ModelProviderModule } from "../modules/module-system.js";
import type { GrantStore } from "../permissions/grant-store.js";
import {
  egressGuardrailsToPolicyBundle,
  type PolicyStore,
} from "../permissions/policy-store.js";
import {
  deleteSecretMappings,
  generatePlaceholder,
} from "../proxy/secret-proxy.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
  type WritableSecretStore,
} from "../secrets/index.js";
import {
  buildDeploymentInfoSummary,
  runInBatches,
} from "./deployment-utils.js";
import {
  failTurnsForDeployment,
  hasLiveTurnForDeployment,
} from "./turn-liveness.js";
import { buildWorkerTokenClaims } from "./worker-token-claims.js";
import { withDeploymentTurnLock } from "../infrastructure/deployment-turn-lock.js";
import { CredentialLeaseRegistry } from "../agent-tooling/credential-lease.js";
import {
  isReservedAgentToolingEnvName,
  resolveAgentTooling,
  resolveAgentToolingDeclaration,
  type ResolvedAgentTooling,
} from "../agent-tooling/resolver.js";
import { resolvePinnedSelection } from "../../lobu/stores/sandbox-store.js";
import { getInternalGatewayUrl } from "../config/index.js";

const logger = createLogger("orchestrator");


/**
 * A `systemd-run --scope` that can't reach the user bus / start the scope
 * fails almost instantly — before the worker payload runs. We only treat an
 * exit as a systemd setup failure (vs. a genuine fast worker crash) when it
 * lands inside this window AND matches SYSTEMD_SETUP_ERROR_RE, so a real
 * worker bug is never masked as "fall back to plain spawn".
 */
const SYSTEMD_FAST_FAIL_MS = 2_000;

/**
 * stderr signatures emitted by `systemd-run` itself (not the worker) when the
 * user manager / dbus / scope setup is the problem (bus unreachable, or a
 * property the host's systemd rejects on a scope). Kept tight on purpose so a
 * genuine fast worker crash is never misread as a systemd failure.
 */
const SYSTEMD_SETUP_ERROR_RE =
  /Failed to connect to bus|No medium found|Failed to (start|create) (transient )?(scope|unit)|Unknown assignment|Interactive authentication required|Access denied|Transport endpoint is not connected/i;

/**
 * Whether the operator REQUIRES the systemd worker sandbox. Default false:
 * workers run unwrapped when no usable `systemd-run --user` manager exists
 * (matching the prod container, which ships no systemd-run; the egress proxy is
 * the network boundary). A hardened deployment that has provisioned a user
 * systemd manager can set LOBU_REQUIRE_WORKER_SANDBOX=1 to fail closed instead
 * of silently running unwrapped. Re-read each call (cold path).
 */
function workerSandboxRequired(): boolean {
  return process.env.LOBU_REQUIRE_WORKER_SANDBOX === "1";
}

/** One-shot guard so the "running unsandboxed" notice logs once per process. */
let warnedUnsandboxedWorkers = false;

// The SIGTERM→SIGKILL grace window lives in config/intervals.ts
// (`workerKillTimeoutMs`), env-overridable.

/**
 * Signal a worker's entire process group. Workers are spawned `detached`, so
 * `child.pid` is the process-group leader; on Linux the direct child is a
 * wrapper (`systemd-run --scope` / `nix-shell --run`) with the real worker as a
 * descendant in the same group. `process.kill(-pid, …)` reaches the wrapper AND
 * the worker, where `child.kill()` would hit only the wrapper and orphan the
 * worker. Falls back to the single child if the group send fails (e.g. the
 * leader already exited, or the platform doesn't support group signals).
 * Returns true if a signal was delivered.
 */
export function signalWorkerGroup(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals
): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

/**
 * Detect once whether `systemd-run --user` is available. On Linux hosts with
 * a usable user manager this lets us spawn each worker as a transient scope
 * with cgroup limits + IPAddressDeny (a `--scope` cannot apply exec-context
 * hardening — see buildSystemdRunArgs). macOS dev hosts and Linux hosts
 * without a user systemd fall back to plain `child_process.spawn`.
 */
let cachedSystemdRun: string | null | undefined;
function locateSystemdRun(): string | null {
  if (cachedSystemdRun !== undefined) return cachedSystemdRun;
  if (process.platform !== "linux") {
    cachedSystemdRun = null;
    return cachedSystemdRun;
  }
  if (process.env.LOBU_DISABLE_SYSTEMD_RUN === "1") {
    cachedSystemdRun = null;
    return cachedSystemdRun;
  }
  try {
    // Probe the EXACT path the worker spawn uses: a `--scope` unit with the
    // same `-p` props, running `/bin/true`. The old probe was a `--no-block`
    // transient *service* with no props — it could succeed while the real
    // `--scope` spawn fails, because a scope rejects properties a service
    // accepts (strict systemd answers "Unknown assignment" and the whole scope
    // dies). Matching the real argv here means a host whose systemd refuses one
    // of these props is detected now and degrades to a plain spawn, instead of
    // killing every worker at first request. Bus reachability also matches: the
    // probe inherits the gateway's process.env (incl. XDG_RUNTIME_DIR), the
    // same coordinates the wrapped spawn forwards. `--scope` runs synchronously,
    // so this returns as soon as `/bin/true` exits.
    const probeArgs = [
      ...buildSystemdRunArgs({ unitName: makeUnitName("probe") }),
      "--",
      "/bin/true",
    ];
    execFileSync("systemd-run", probeArgs, {
      stdio: "ignore",
      timeout: 3_000,
    });
    cachedSystemdRun = "systemd-run";
  } catch {
    cachedSystemdRun = null;
  }
  return cachedSystemdRun;
}

/**
 * Detect once whether `nix-shell` is available. Skills/agents declare native
 * deps via `nixConfig.packages`, which we normally provision by wrapping the
 * worker in `nix-shell -p …`. Containers/hosts without Nix (e.g. the prod app
 * image, which bakes Chromium in directly rather than via Nix) won't have it,
 * so we fall back to a plain spawn — mirroring `locateSystemdRun`'s graceful
 * degradation — instead of crashing the worker with `spawn nix-shell ENOENT`.
 * The declared packages are simply unavailable in that turn unless the image
 * already provides them; a turn that doesn't use them runs fine.
 */
let cachedNixShell: string | null | undefined;
function locateNixShell(): string | null {
  // Operator kill-switch always wins, even if an earlier probe cached a hit
  // (tests set LOBU_DISABLE_NIX_SHELL=1 mid-process; a sticky "nix-shell"
  // cache would ignore the flag and wrap workers that should run plain).
  if (process.env.LOBU_DISABLE_NIX_SHELL === "1") {
    return null;
  }
  if (cachedNixShell !== undefined) return cachedNixShell;
  try {
    execFileSync("nix-shell", ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    cachedNixShell = "nix-shell";
  } catch {
    cachedNixShell = null;
  }
  return cachedNixShell;
}

/**
 * Test-only: clear the memoized systemd/nix capability probes so a test can
 * exercise a different host capability (e.g. force a re-probe after toggling
 * LOBU_DISABLE_SYSTEMD_RUN). Not used by production code paths.
 */
export function __resetCapabilityProbesForTests(): void {
  cachedSystemdRun = undefined;
  cachedNixShell = undefined;
}

/**
 * Build the systemd-run argv prefix for a transient worker scope. Defaults are
 * tuned for a single Lobu worker; operators can override via
 * LOBU_WORKER_MEMORY_MAX / LOBU_WORKER_CPU_QUOTA / LOBU_WORKER_TASKS_MAX.
 *
 * ONLY cgroup/network properties are emitted. A `--scope` adopts a process the
 * caller forked, so systemd never execs it and CANNOT apply exec-context
 * hardening — NoNewPrivileges, PrivateTmp, ProtectSystem/Home, ReadWritePaths,
 * LimitNOFILE, CapabilityBoundingSet, RestrictAddressFamilies. Strict systemd
 * (observed on 255) rejects each with "Unknown assignment" and the whole scope
 * fails (the worker dies before it starts). Those would require a `--service`,
 * which would detach the worker from the gateway's process tree and break
 * stdout/stderr piping + group-signal teardown. The cgroup limits (Memory/CPU/
 * Tasks) and the network boundary (IPAddressDeny) DO apply to scopes; network
 * egress is additionally constrained by the worker HTTP proxy allowlist.
 */
function buildSystemdRunArgs(opts: { unitName: string }): string[] {
  const memMax = process.env.LOBU_WORKER_MEMORY_MAX || "512M";
  const cpuQuota = process.env.LOBU_WORKER_CPU_QUOTA || "200%";
  const tasksMax = process.env.LOBU_WORKER_TASKS_MAX || "64";
  return [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${opts.unitName}`,
    "-p",
    `MemoryMax=${memMax}`,
    "-p",
    `CPUQuota=${cpuQuota}`,
    "-p",
    `TasksMax=${tasksMax}`,
    "-p",
    "IPAddressDeny=any",
    "-p",
    "IPAddressAllow=127.0.0.1",
    "-p",
    "IPAddressAllow=::1",
  ];
}

function makeUnitName(deploymentName: string): string {
  // systemd unit names allow only [A-Za-z0-9:_.\\-]; sanitize and add a
  // short random tag so concurrent workers don't collide if a prior unit
  // is still being torn down.
  const safe = deploymentName.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  const tag = Math.random().toString(36).slice(2, 8);
  return `lobu-worker-${safe}-${tag}`;
}

interface EmbeddedWorkerEntry {
  process: ChildProcess;
  env: Record<string, string>;
  lastActivity: Date;
  workspaceDir: string;
  /**
   * Release the cross-pod advisory lock held for this conversation while the
   * worker is alive. Called from the `exit` handler so the lock survives the
   * entire subprocess lifetime, not just the spawn transaction.
   */
  releaseConvLock?: () => Promise<void>;
}

/** Stable namespace id for `pg_advisory_lock(key1, key2)` per-conversation locks. */
const CONV_LOCK_KEY1 = 0x6c6f6275; // "lobu" in ASCII, signed int32-safe.

/** Reserve this many connections in the postgres-js pool for non-locked
 *  query traffic (health probes, runs-queue claim, secret-proxy lookups,
 *  every gateway tagged-template query). Sustained pressure here is small
 *  and shorter-lived than the per-worker locks, but the queries can't be
 *  starved entirely or the gateway stops responding. */
const POOL_HEADROOM = 5;

/** Default cap for reserved Postgres connections held by
 *  acquireConversationLock. Derived from `DB_POOL_MAX` so the cap CAN'T
 *  exceed available connections — otherwise callers above the pool size
 *  would block inside `sql.reserve()` instead of returning null at this
 *  cap, defeating the cap's whole purpose. Operators can still raise the
 *  cap with `LOBU_MAX_RESERVED_LOCKS` if they've bumped DB_POOL_MAX
 *  accordingly. Codex round 2 P1#2 on PR #870. */
function getDefaultMaxReservedLocks(): number {
  const poolMax = Number.parseInt(process.env.DB_POOL_MAX || "20", 10);
  if (!Number.isFinite(poolMax) || poolMax <= 0) {
    return Math.max(1, 20 - POOL_HEADROOM);
  }
  return Math.max(1, poolMax - POOL_HEADROOM);
}

export function getMaxReservedLocks(): number {
  const raw = process.env.LOBU_MAX_RESERVED_LOCKS;
  if (!raw) return getDefaultMaxReservedLocks();
  const n = Number.parseInt(raw, 10);
  // Unparseable / negative / non-finite → fall back to default. `0` is
  // honored as an explicit "block all reservations" value (useful for
  // failover drains and load tests; the runs queue will retry).
  if (!Number.isFinite(n) || n < 0) return getDefaultMaxReservedLocks();
  return n;
}

/**
 * In-process counter of currently-held reserved connections from
 * `acquireConversationLock`. Single-process JS is single-threaded so a plain
 * mutable number is "atomic enough" for increment/decrement against this
 * counter — there's no true parallelism inside the gateway event loop. The
 * functions below are exported so tests can assert the counter without
 * reaching into module internals.
 *
 * The counter is incremented BEFORE the `await sql.reserve()` call so the
 * cap check accounts for in-flight acquisitions; decremented in the release
 * path so the slot becomes available the moment the worker exits.
 */
let reservedLockCount = 0;
/** Tracks whether we've already emitted the 80% warning so we don't spam
 *  every acquisition once we're operating near the ceiling. Reset when the
 *  count drops back below the threshold. */
let warnedNearCap = false;

export function getReservedLockCount(): number {
  return reservedLockCount;
}

export function resetReservedLockCountForTests(): void {
  reservedLockCount = 0;
  warnedNearCap = false;
}

/**
 * Force the internal counter to a specific value. Test-only — production
 * code MUST go through `acquireConversationLock` so increment+decrement
 * pair via the canonical path. Used by the cap-enforcement test which
 * needs to stage the counter without actually consuming PG connections.
 */
export function setReservedLockCountForTests(value: number): void {
  reservedLockCount = Math.max(0, value);
}

/**
 * Acquire a session-level (NOT transaction-level) advisory lock on
 * `(org, agent, conversationId)`. Returns a release function that drops the
 * lock and the underlying reserved connection. Returns `null` if the lock is
 * held by another pod — caller should bail and let the runs queue re-deliver.
 *
 * Why session-level (`pg_try_advisory_lock`) over transaction-level: the
 * lock has to outlive any single query — it spans the entire worker
 * subprocess lifetime, which can be tens of minutes. A transaction-scoped
 * lock would release at the next commit/rollback and let a sibling pod
 * steal the conversation mid-run. The `sql.reserve()` connection is
 * dedicated and lock state survives until we explicitly release.
 *
 * The local embedded backend takes this same real path now that it runs on a
 * real multi-connection Postgres (no single-connection pin). In a single
 * process the lock is uncontended and the in-process `workers` Map (see
 * `spawnDeployment` above) is the primary per-conversation gate; the advisory
 * lock is the cross-pod gate that matters in clustered deployments.
 */
export async function acquireConversationLock(
  organizationId: string,
  agentId: string,
  conversationId: string
): Promise<{ release: () => Promise<void> } | null> {
  // Hard cap on reserved connections held across all live workers. Each lock
  // pins one postgres-js pool slot for the worker's lifetime; without a cap
  // multi-pod × multi-conversation pressure exhausts the pool and stalls
  // every gateway query. Returning `null` here surfaces as a re-queueable
  // failure in `spawnDeployment` (same code path as a contended advisory
  // lock), so the runs queue retries with a delay on this pod or another.
  const max = getMaxReservedLocks();
  if (reservedLockCount >= max) {
    logger.warn(
      `Reserved-lock cap reached (${reservedLockCount}/${max}); deferring spawn for ${organizationId}/${agentId}/${conversationId}`
    );
    return null;
  }

  // Reserve the slot up-front so concurrent acquirers can see the increment
  // before this one's `await sql.reserve()` settles. Without this an
  // unbounded number of concurrent callers could each observe
  // `reservedLockCount < max` and pile through.
  reservedLockCount += 1;
  // 80% threshold one-shot warn. Re-armed once the count drops back below.
  if (!warnedNearCap && reservedLockCount >= Math.ceil(max * 0.8)) {
    logger.warn(
      `Reserved-lock count near cap: ${reservedLockCount}/${max}. Tune via LOBU_MAX_RESERVED_LOCKS or scale pods.`
    );
    warnedNearCap = true;
  }

  let decremented = false;
  const decrementOnce = (): void => {
    if (decremented) return;
    decremented = true;
    reservedLockCount = Math.max(0, reservedLockCount - 1);
    if (warnedNearCap && reservedLockCount < Math.ceil(max * 0.8)) {
      warnedNearCap = false;
    }
  };

  // `getDb()` returns the wrapped tagged-template client; `.reserve()` is on
  // the raw `postgres()` client. We access it via the shared singleton —
  // same pattern better-auth uses for its dedicated connection (see
  // `getAuthDialect()` in db/client.ts).
  const sql = getDb() as unknown as {
    reserve: () => Promise<
      ((
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown[]>) & {
        release: () => void;
      }
    >;
  };
  let reserved: Awaited<ReturnType<typeof sql.reserve>>;
  try {
    reserved = await sql.reserve();
  } catch (err) {
    decrementOnce();
    throw err;
  }
  const key2 = hashConvKey2(organizationId, agentId, conversationId);
  try {
    const rows = (await reserved`SELECT pg_try_advisory_lock(${CONV_LOCK_KEY1}, ${key2}) AS acquired`) as Array<{ acquired: boolean }>;
    if (!rows[0]?.acquired) {
      reserved.release();
      decrementOnce();
      return null;
    }
  } catch (err) {
    reserved.release();
    decrementOnce();
    throw err;
  }
  return {
    async release() {
      // Retry the unlock query up to 3× with linear backoff (100ms, 200ms).
      // A transient DB hiccup mid-release would otherwise leave the
      // conversation locked until the gateway recycles — every
      // subsequent dispatch for that conv would `pg_try_advisory_lock`
      // → false → DEPLOYMENT_CREATE_FAILED → runs-queue retry → repeat.
      // Codex round 2 quality win E on PR #865.
      const MAX_ATTEMPTS = 3;
      const BACKOFF_MS = 100;
      try {
        await retryWithBackoff(
          async () => {
            await reserved`SELECT pg_advisory_unlock(${CONV_LOCK_KEY1}, ${key2})`;
          },
          {
            maxRetries: MAX_ATTEMPTS - 1,
            baseDelay: BACKOFF_MS,
            strategy: "linear",
            // Intermediate failures stay silent (matches the prior
            // hand-rolled loop); only the terminal failure is logged below.
            onRetry: () => {},
          }
        );
      } catch (lastErr) {
        // Log loudly so an operator notices — a stuck lock blocks every
        // subsequent dispatch for the conversation. Includes the lock
        // key triple so the operator can target a manual
        // pg_advisory_unlock from psql if needed.
        logger.error(
          `Failed to release advisory lock after ${MAX_ATTEMPTS} attempts for ${organizationId}/${agentId}/${conversationId}: ${getErrorMessage(lastErr)}`
        );
      }
      // ALWAYS return the reserved connection to the pool — keeping it
      // pinned would starve the pool faster than the stuck lock starves
      // any one conversation.
      try {
        reserved.release();
      } catch {
        /* postgres.js release is sync best-effort */
      }
      // Decrement after release so a metric snapshot taken mid-release
      // never undercounts. Idempotent — the helper guards against
      // double-decrement if the release path runs twice.
      decrementOnce();
    },
  };
}

/**
 * Derive a 32-bit signed integer from `(org, agent, conv)` for the second
 * advisory-lock key. Postgres takes (int32, int32); we want a stable hash
 * over a string triple. Same shape as the existing
 * `hashtext('lobu:autowire', ${userId}:${connectorKey})` pattern in
 * worker-api/device-reconcile.ts but computed in Node so we don't pay a
 * round-trip just to feed the lock.
 */
function hashConvKey2(
  organizationId: string,
  agentId: string,
  conversationId: string
): number {
  // FNV-1a 32-bit. Cheap, no extra deps, stable across Node versions.
  const input = `${organizationId}:${agentId}:${conversationId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) | 0;
  }
  // pg_advisory_lock takes a signed int32; |0 already brings the value into
  // that range. Return as-is.
  return hash;
}

function buildEmbeddedWorkerPath(
  binPathEntries: readonly string[] | undefined,
  existingPath?: string
): string | undefined {
  const segments = (existingPath || "").split(":").filter(Boolean);

  for (const candidate of [...(binPathEntries ?? [])].reverse()) {
    if (!fs.existsSync(candidate)) continue;
    if (segments.includes(candidate)) continue;
    segments.unshift(candidate);
  }

  return segments.length > 0 ? segments.join(":") : existingPath;
}

function getBunExecutable(): string {
  return path.basename(process.execPath).startsWith("bun")
    ? process.execPath
    : "bun";
}

function getNodeExecutable(): string {
  return path.basename(process.execPath).startsWith("node")
    ? process.execPath
    : "node";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildWorkerInvocation(entryPoint: string): {
  command: string;
  args: string[];
} {
  // Cap each worker child's V8 heap so one runaway turn (a huge transcript,
  // pathological allocation) OOMs *itself* with a clean V8 error, instead of
  // ballooning the process RSS until the pod's cgroup memory limit trips and the
  // kernel OOM-kills the whole app pod — taking every other in-flight turn with
  // it. N uncapped children sharing the pod ceiling is how the pod OOM-kills
  // today; a per-child cap contains the blast radius to the offending turn.
  // Env-tunable; default sized so a few concurrent workers fit under the pod
  // limit with headroom for the parent + proxies.
  const maxOldSpaceMb = Number.parseInt(
    process.env.LOBU_WORKER_MAX_OLD_SPACE_MB || "512",
    10
  );
  const ext = path.extname(entryPoint);
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    // Prod path: agent-worker ships as dist/index.js, run under Node, where
    // --max-old-space-size caps the V8 old-space (a hard, effective heap limit).
    return {
      command: getNodeExecutable(),
      args: [`--max-old-space-size=${maxOldSpaceMb}`, entryPoint],
    };
  }

  // Dev path: a .ts entrypoint runs under Bun (JavaScriptCore, not V8), which
  // ignores --max-old-space-size. Bun's memory knob is --smol; it trades CPU for
  // a smaller footprint rather than enforcing a hard ceiling, but it's the
  // closest available lever and keeps dev behaviour honest (no no-op V8 flag).
  return {
    command: getBunExecutable(),
    args: ["--smol", "run", entryPoint],
  };
}

function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

/**
 * Validate a skill-declared Nix package name and return a safe Nix attribute
 * reference (`pkgs.<name>`). Delegates to the canonical sanitizer in
 * @lobu/connector-sdk (shared with the connector-worker executor so the two
 * paths can't drift), wrapping failures in an `OrchestratorError` for the
 * deployment surface.
 */
export function nixPackageAttrRef(pkg: string): string {
  return nixPackageAttrRefBase(
    pkg,
    (message) =>
      new OrchestratorError(ErrorCode.DEPLOYMENT_CREATE_FAILED, message)
  );
}

/**
 * Detect base-URL env keys claimed by more than one provider with CONFLICTING
 * values. When agents merge every installed provider's proxy base-URL mappings,
 * two providers sharing a key (e.g. the old bug where every sdkCompat provider
 * emitted OPENAI_BASE_URL) means the later-merged one silently clobbers the
 * earlier and a request egresses to the wrong slug. Pure + exported so the guard
 * is testable independently of a full deploy. Order matches the merge:
 * last-write-wins, so `incoming` is what survives.
 */
export function detectProviderBaseUrlCollisions(
  perProvider: Array<{ providerId: string; mappings: Record<string, string> }>
): Array<{ key: string; providerId: string; existing: string; incoming: string }> {
  const seen: Record<string, string> = {};
  const collisions: Array<{
    key: string;
    providerId: string;
    existing: string;
    incoming: string;
  }> = [];
  for (const { providerId, mappings } of perProvider) {
    for (const [key, value] of Object.entries(mappings)) {
      const existing = seen[key];
      if (existing !== undefined && existing !== value) {
        collisions.push({ key, providerId, existing, incoming: value });
      }
      seen[key] = value;
    }
  }
  return collisions;
}

/**
 * Mint the deployment-lifetime WORKER_TOKEN. This is the FALLBACK gateway auth
 * the worker uses when no per-run runJobToken was minted (`session-runner`:
 * `runJobToken || WORKER_TOKEN`). Extracted (mirrors message-consumer's
 * `buildRunJobToken`) so both primary-auth mints share a tested claim-parity
 * surface — the #1274 P0 was an omitted-claim divergence between exactly these
 * two mints. Every claim a downstream consumer reads off the verified worker
 * token MUST be set on BOTH mints, or a worker that lands on this fallback path
 * loses it (e.g. headless `source` → owner-gated card dead-letters).
 */
export function buildDeploymentWorkerToken(args: {
  userId: string;
  conversationId: string;
  deploymentName: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
  platform?: string;
  platformMetadata?: Record<string, unknown>;
  traceId?: string;
  /** Resolved runtime provider + sandbox, so the deployment-lifetime token
   *  also carries the claim the runtime route reads (parity with the per-run mint). */
  runtimeProviderId?: string;
  sandboxId?: string;
  /** Resolved egress allowlist for a remote runtime sandbox (signed claim). */
  allowedDomains?: string[];
  /** Resolved egress denylist for a remote runtime sandbox (signed claim). */
  deniedDomains?: string[];
  /** Resolved nix package set for a remote runtime sandbox (signed claim). */
  nixPackages?: string[];
}): string {
  return generateWorkerToken(
    args.userId,
    args.conversationId,
    args.deploymentName,
    buildDeploymentTokenOptions(args)
  );
}

function buildDeploymentTokenOptions(
  args: Parameters<typeof buildDeploymentWorkerToken>[0]
) {
  return {
    // Shared routing claims — kept in lockstep with the per-run mint via
    // `buildWorkerTokenClaims` so a worker that falls back to this
    // deployment-lifetime token carries the same connectionId/source and
    // doesn't dead-letter its interaction cards (#1274).
    ...buildWorkerTokenClaims(args),
    // Deployment-token-specific claim.
    traceId: args.traceId,
  };
}

function buildDeploymentTokenPair(
  args: Parameters<typeof buildDeploymentWorkerToken>[0]
): { workerToken: string; egressProxyToken: string } {
  return generateWorkerTokenPair(
    args.userId,
    args.conversationId,
    args.deploymentName,
    buildDeploymentTokenOptions(args)
  );
}

/**
 * TTL applied to non-provider secret env var placeholders. Mappings are
 * cascade-deleted on deployment teardown; this only bounds how long an
 * orphaned mapping (pod crash, agent deleted mid-day) survives. 24h default,
 * overridable via `SECRET_PLACEHOLDER_TTL_MS`.
 */
const SECRET_PLACEHOLDER_TTL_SECONDS = (() => {
  const raw = process.env.SECRET_PLACEHOLDER_TTL_MS;
  if (raw) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return 24 * 60 * 60;
})();

/**
 * Maximum number of agents tracked in the grant-sync LRU. Oldest entry is
 * evicted when the cache grows past this bound, which prevents unbounded
 * memory growth for long-running gateways that see a large agent churn.
 */
const GRANT_SYNC_CACHE_MAX = 1000;

/**
 * Stand-in used when no lease registry is wired. Registering nothing means
 * `mintFor` always returns null, so agent tooling still contributes its
 * packages and domains while every lease var is omitted.
 */
const EMPTY_LEASE_REGISTRY = new CredentialLeaseRegistry();

/**
 * Marks a tooling resolution that did not happen (missing ids, or a thrown
 * lookup). Never compared as a real digest — see `hasToolingChanged`.
 */
const UNKNOWN_TOOLING_FINGERPRINT = "";

/**
 * Nix binary-cache hosts auto-allowed while an agent has a Nix environment
 * configured. Config-derived like `networkConfig` domains: granted by the
 * sync while `nixConfig` is present, reconciled away when it is removed.
 */
const NIX_CACHE_DOMAINS = [
  "cache.nixos.org",
  "channels.nixos.org",
  "releases.nixos.org",
];

/**
 * npm registry hosts auto-granted at deploy time when CLI-backend providers
 * are configured (see `generateEnvironmentVariables`). Not derivable from
 * the message payload, so the domain reconcile must never revoke them.
 */
const NPM_REGISTRY_DOMAINS = ["registry.npmjs.org", "registry.npmmirror.com"];

interface DeploymentIdentity {
  conversationId: string;
  channelId?: string;
  platform?: string;
  userId?: string;
  agentId: string;
  organizationId: string;
}

/**
 * Build a canonical conversation identity key for runtime routing.
 * Preferred format: organizationId:agentId:platform:channelId:conversationId
 */
export function buildCanonicalConversationKey(
  identity: DeploymentIdentity
): string {
  const { organizationId, agentId, conversationId, channelId, platform } =
    identity;
  const scope = `${organizationId}:${agentId}`;
  if (platform && channelId) {
    return `${scope}:${platform}:${channelId}:${conversationId}`;
  }
  if (channelId) {
    return `${scope}:${channelId}:${conversationId}`;
  }
  return `${scope}:${conversationId}`;
}

/**
 * Generate a consistent worker runtime ID from canonical conversation identity.
 * Runtime IDs stay lowercase alphanumeric with hyphens for filesystem and
 * process-manager compatibility.
 */
export function generateDeploymentName(identity: DeploymentIdentity): string {
  const canonicalKey = buildCanonicalConversationKey(identity);
  const rawHint = (identity.platform || identity.userId || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const hint = (rawHint.slice(0, 8) || "ctx").toLowerCase();
  const hash = createHash("sha256")
    .update(canonicalKey)
    .digest("hex")
    .slice(0, 12);
  return `lobu-worker-${hint}-${hash}`;
}

// Type for module environment variable builder function
export type ModuleEnvVarsBuilder = (
  agentId: string,
  envVars: Record<string, string>,
  context?: ProviderCredentialContext
) => Promise<Record<string, string>>;

// Orchestrator configuration
export interface OrchestratorConfig {
  queues: {
    retryLimit: number;
    retryDelay: number;
    expireInSeconds: number;
  };
  worker: {
    /**
     * Absolute path to the worker TypeScript entrypoint. Callers compute
     * this once at boot — the gateway never probes cwd or reads env at
     * deployment time.
     */
    entryPoint?: string;
    /**
     * Extra PATH entries prepended when spawning worker processes (e.g.
     * workspace-local `.bin` directories for `tsx`, `bun`). Callers supply
     * absolute paths; the manager uses them verbatim.
     */
    binPathEntries?: string[];
    startupTimeoutSeconds?: number;
    idleCleanupMinutes: number;
    maxDeployments: number;
    env?: Record<string, string | number | boolean>;
  };
  cleanup: {
    initialDelayMs: number;
    intervalMs: number;
    veryOldDays: number;
  };
}

export interface DeploymentInfo {
  deploymentName: string;
  lastActivity: Date;
  minutesIdle: number;
  daysSinceActivity: number;
  replicas: number;
  isIdle: boolean;
  isVeryOld: boolean;
}

/** Check if an env var name looks like a secret (API key / token / secret / password). */
function isSecretEnvVar(
  name: string,
  providerModules: ModelProviderModule[]
): boolean {
  for (const provider of providerModules) {
    if (provider.getSecretEnvVarNames().includes(name)) return true;
  }
  const upper = name.toUpperCase();
  return (
    upper.includes("_KEY") ||
    upper.includes("_TOKEN") ||
    upper.includes("_SECRET") ||
    upper.includes("_PASSWORD")
  );
}

/**
 * Manages worker deployments for the embedded gateway: spawns each worker as a
 * `child_process` subprocess (wrapped in `systemd-run --scope` + `nix-shell`
 * when available), assembles the worker environment, syncs per-agent grants and
 * egress policy, and reaps idle/old workers.
 */
export class DeploymentManager {
  protected config: OrchestratorConfig;
  protected moduleEnvVarsBuilder?: ModuleEnvVarsBuilder;
  protected providerModules: ModelProviderModule[];
  protected providerCatalogService?: import("../auth/provider-catalog.js").ProviderCatalogService;
  /**
   * Set by `setSecretStore` during `Orchestrator.injectCoreServices`.
   * `generateEnvironmentVariables` asserts this is present before use.
   */
  protected secretStore?: WritableSecretStore;
  protected grantStore?: GrantStore;
  protected policyStore?: PolicyStore;
  /**
   * Mints credential leases for connector-contributed agent tooling.
   * Unset (tests, or a gateway with no lease providers wired) means connections
   * contribute their packages and domains but no credentials.
   */
  protected leaseRegistry?: CredentialLeaseRegistry;
  /**
   * Per-(org, agent) cache of the last-synced `preApprovedTools` patterns,
   * used to diff tool grants/revokes (domains reconcile against Postgres
   * instead — see syncNetworkConfigGrants). Keyed by `org|agent` — agent
   * ids are only unique within an organization, and grants are org-scoped
   * rows, so an agent-id-only key would let org A's sync suppress org B's
   * writes.
   */
  private grantSyncCache = new Map<string, Set<string>>();

  /**
   * Earliest connector-lease expiry per deployment, recorded at env-build time.
   *
   * Pod-local by design, and NOT the multi-replica trap: the entry describes a
   * worker THIS pod spawned and only this pod can recycle. A different replica
   * serving the same conversation spawns its own worker and mints its own
   * lease, so it has no need to read this one — nothing is shared state.
   */
  private leaseExpiryByDeployment = new Map<string, Date>();

  /**
   * How long before a lease's stated expiry the deployment stops being
   * reusable. A turn that starts inside this window could still be running when
   * the credential dies, so recycle early rather than hand the sandbox a token
   * that expires mid-command.
   */
  private static readonly LEASE_RECYCLE_MARGIN_MS = 5 * 60 * 1000;

  /**
   * Normal minimum age for a newly built deployment. The effective floor is
   * capped at the lease's actual expiry: a short-lived credential gets its full
   * usable life without causing per-turn rebuilds, then renews when it expires
   * instead of leaving the sandbox unauthenticated until this whole interval
   * elapses.
   */
  private static readonly MIN_DEPLOYMENT_AGE_BEFORE_RECYCLE_MS = 10 * 60 * 1000;

  /**
   * Tooling fingerprint each deployment was BORN with, so a warm turn can tell
   * that the org's connections changed underneath it.
   */
  private toolingFingerprintByDeployment = new Map<string, string>();

  /** When each deployment's lease was minted — see the recycle age floor. */
  private leaseMintedAtByDeployment = new Map<string, Date>();

  /**
   * Consecutive reconcile cycles a stale deployment has skipped its reap
   * because a turn was in flight. Pod-local like the rest of the recycle state:
   * only the pod that spawned a worker can reap it.
   */
  private recycleDeferralsByDeployment = new Map<string, number>();

  /**
   * Reconcile cycles a stale deployment may defer its reap before it is forced.
   *
   * The deferral alone does not terminate. A turn ends, but the NEXT turn arms
   * its own marker, and at N>1 replicas most messages are claimed by a pod that
   * does not own the worker — so it evaluates no recycle, arms, and enqueues.
   * Under a steady arrival rate the owner's reconcile then sees an unbroken run
   * of live turns and never reaps, while every one of those turns executes on a
   * credential that is expiring or on a connection that was repointed or
   * revoked. At the default 60s cadence this bounds that at ~4 minutes, inside
   * the 5-minute lease-recycle margin, so the interrupted turn was about to lose
   * its credential regardless — and the forced delete explicitly terminalizes
   * its turn marker rather than leaving the client hanging.
   *
   * This also bounds the probe's fail-safe: {@link isServingLiveTurn} reports
   * "busy" when it cannot reach Postgres, and a probe that has been failing for
   * the whole window is not evidence of a live turn. The alternative is never
   * reaping an expiring credential for as long as the database is unhealthy.
   */
  private static readonly MAX_RECYCLE_DEFERRALS = 4;

  /**
   * Org each deployment was built for. The deployment name is a hash of the
   * conversation identity, so the org is not recoverable from it — but the
   * reconcile loop needs it to re-resolve the CURRENT tooling fingerprint.
   */
  private organizationByDeployment = new Map<string, string>();

  /**
   * True when a warm deployment holds a connector lease that has expired or is
   * about to. The caller tears the deployment down so the normal create path
   * re-mints — a worker reads its env once at process start, so refreshing the
   * credential in place is not possible.
   */
  hasExpiringLease(deploymentName: string, now: Date = new Date()): boolean {
    const expiresAt = this.leaseExpiryByDeployment.get(deploymentName);
    if (!expiresAt) return false;

    // A deployment built moments ago holds the freshest credential the provider
    // will give us. If that is ALREADY inside the margin, rebuilding on every
    // turn cannot improve it. Suppress recycling until the earlier of the
    // normal age floor and the credential's own expiry: this prevents per-turn
    // churn without keeping an already-expired token for the remainder of a
    // ten-minute floor.
    const builtAt = this.leaseMintedAtByDeployment.get(deploymentName);
    if (
      builtAt &&
      now.getTime() <
        Math.min(
          builtAt.getTime() +
            DeploymentManager.MIN_DEPLOYMENT_AGE_BEFORE_RECYCLE_MS,
          expiresAt.getTime()
        )
    ) {
      return false;
    }

    return (
      expiresAt.getTime() - now.getTime() <=
      DeploymentManager.LEASE_RECYCLE_MARGIN_MS
    );
  }

  /**
   * True when the org's connector tooling no longer matches what this
   * deployment was built with — a connection was added, removed, or repointed
   * at a different installation.
   *
   * Same root cause as {@link hasExpiringLease}: env is read once at process
   * start. Without this, connecting GitHub mid-conversation leaves the agent
   * with no `gh` and no GH_TOKEN until something else recycles it, and
   * switching installations keeps it acting as the previous identity.
   *
   * Unknown deployment → false. A deployment this pod did not build is not
   * evidence of a change, and recycling on every unknown name would tear down
   * healthy workers after a pod restart.
   */
  hasToolingChanged(deploymentName: string, fingerprint: string): boolean {
    const known = this.toolingFingerprintByDeployment.get(deploymentName);
    if (known === undefined) return false;
    return known !== fingerprint;
  }

  /** Drop connector-tooling state for a deployment that no longer exists. */
  protected forgetDeploymentTooling(deploymentName: string): void {
    this.leaseExpiryByDeployment.delete(deploymentName);
    this.leaseMintedAtByDeployment.delete(deploymentName);
    this.toolingFingerprintByDeployment.delete(deploymentName);
    this.organizationByDeployment.delete(deploymentName);
    this.recycleDeferralsByDeployment.delete(deploymentName);
  }

  private trackConversationLockRelease(
    deploymentName: string,
    release: Promise<void>
  ): void {
    this.conversationLockReleases.set(deploymentName, release);
    const clear = () => {
      if (this.conversationLockReleases.get(deploymentName) === release) {
        this.conversationLockReleases.delete(deploymentName);
      }
    };
    // Handle both outcomes on the derived promise. `finally()` would mirror a
    // release rejection into an unobserved promise on crash/exit paths that
    // have nobody awaiting `conversationLockReleases`.
    void release.then(clear, (error) => {
      clear();
      logger.error(
        { deploymentName, error: getErrorMessage(error) },
        "Failed to release the conversation lock after worker exit"
      );
    });
  }

  /**
   * In-flight `ensureDeployment` promises keyed by deploymentName. Coalesces
   * concurrent calls within a single gateway process so the orchestrator-
   * specific `spawnDeployment` only runs once per deployment slot. Cross-
   * process concurrency (multi-replica gateway) is handled by the underlying
   * orchestrator's atomic name-uniqueness guarantee — each subclass catches
   * the resulting AlreadyExists error and treats it as benign success.
   */
  private inFlightCreates = new Map<string, Promise<void>>();

  private workers: Map<string, EmbeddedWorkerEntry> = new Map();
  /** Conversation-lock releases started by child exit handlers. */
  private conversationLockReleases = new Map<string, Promise<void>>();
  /** Deployments currently being torn down deliberately (scale-to-0, idle
   *  reap, delete) via {@link killWorker}. The exit handler consumes the entry
   *  so a deliberate stop is NOT surfaced to the user as a worker crash; any
   *  OTHER exit/spawn-error fails the deployment's in-flight turns. Pod-local
   *  and pod-exclusive (this pod owns its own worker children). */
  private intentionalExits: Set<string> = new Set();

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder,
    providerModules: ModelProviderModule[] = []
  ) {
    this.config = config;
    this.moduleEnvVarsBuilder = moduleEnvVarsBuilder;
    this.providerModules = providerModules;
  }

  setSecretStore(secretStore: WritableSecretStore): void {
    this.secretStore = secretStore;
  }

  /**
   * Refresh provider modules after module registry initialization.
   */
  setProviderModules(providerModules: ModelProviderModule[]): void {
    this.providerModules = providerModules;
  }

  setProviderCatalogService(
    service: import("../auth/provider-catalog.js").ProviderCatalogService
  ): void {
    this.providerCatalogService = service;
  }

  /**
   * The provider-catalog service, when wired. Exposed so the message consumer
   * can enforce the exact-model allow-list at ENQUEUE time (before the payload
   * is persisted to the queue) — the deployment-time enforcement is too late
   * for warm/resumed workers that never re-run createWorkerDeployment.
   */
  getProviderCatalogService():
    | import("../auth/provider-catalog.js").ProviderCatalogService
    | undefined {
    return this.providerCatalogService;
  }

  /**
   * Inject grant store for auto-adding domain grants at deployment time.
   */
  setGrantStore(store: GrantStore): void {
    this.grantStore = store;
  }

  /**
   * Inject policy store for syncing per-agent egress judge rules.
   */
  setPolicyStore(store: PolicyStore): void {
    this.policyStore = store;
  }

  /**
   * Inject the credential-lease registry used to mint credentials for
   * connector-contributed agent tooling.
   */
  setCredentialLeaseRegistry(registry: CredentialLeaseRegistry): void {
    this.leaseRegistry = registry;
  }

  protected getDispatcherHost(): string {
    // Match the systemd-run scope's IPAddressAllow=127.0.0.1 — IPv6 ::1
    // resolution would be blocked under the hardened scope.
    return "127.0.0.1";
  }

  /**
   * Embedded gateway is served by `@lobu/server` at the `/lobu`
   * mount on the configured PORT (default 8787). The worker needs the
   * mounted URL or it would 404 on every dispatch and provider-proxy call.
   */
  protected getDispatcherUrl(): string {
    return getInternalGatewayUrl();
  }

  /**
   * Idempotent deployment ensure: returns the existing deployment if one is
   * already being (or has been) created with this name, otherwise delegates
   * to the orchestrator-specific `spawnDeployment`. Concurrent callers for
   * the same name share a single in-flight promise.
   */
  async ensureDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload
  ): Promise<void> {
    const inFlight = this.inFlightCreates.get(deploymentName);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.spawnDeployment(
      deploymentName,
      username,
      userId,
      messageData
    ).finally(() => {
      this.inFlightCreates.delete(deploymentName);
    });
    this.inFlightCreates.set(deploymentName, promise);
    return promise;
  }

  /**
   * Create worker deployment for handling messages.
   * @param existingDeployments - Optional pre-fetched deployment list to avoid redundant API calls
   */
  async createWorkerDeployment(
    userId: string,
    conversationId: string,
    messageData?: MessagePayload,
    existingDeployments?: DeploymentInfo[]
  ): Promise<void> {
    const agentId = messageData?.agentId;
    const organizationId = messageData?.organizationId;
    if (!agentId || !organizationId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Missing agentId or organizationId in message payload"
      );
    }
    const deploymentIdentity: DeploymentIdentity = {
      userId,
      conversationId,
      channelId: messageData?.channelId,
      platform: messageData?.platform,
      agentId,
      organizationId,
    };
    const deploymentName = generateDeploymentName(deploymentIdentity);
    const canonicalConversationKey =
      buildCanonicalConversationKey(deploymentIdentity);

    logger.info(
      `Worker deployment - conversationId: ${conversationId}, canonicalKey: ${canonicalConversationKey}, deploymentName: ${deploymentName}`
    );

    try {
      // Use pre-fetched list or fetch fresh
      const deployments = existingDeployments ?? (await this.listDeployments());
      const existingDeployment = deployments.find(
        (d) => d.deploymentName === deploymentName
      );

      if (existingDeployment) {
        // Scale up the existing deployment. Provider config is now delivered
        // dynamically via session context, so no need to recreate.
        try {
          await this.scaleDeployment(deploymentName, 1);
          return;
        } catch (scaleErr) {
          // The "existing" deployment is actually dead (stale snapshot / just
          // exited) — fall through to spawn a fresh one instead of returning.
          logger.warn(
            `scaleDeployment(${deploymentName}, 1) failed (${getErrorMessage(scaleErr)}); re-spawning`
          );
        }
      }

      // Check if we would exceed max deployments limit
      const maxDeployments = this.config.worker.maxDeployments;
      if (maxDeployments > 0 && deployments.length >= maxDeployments) {
        logger.warn(
          `⚠️  Maximum deployments limit reached (${deployments.length}/${maxDeployments}). Running cleanup before creating new deployment.`
        );
        await this.reconcileDeployments();

        // Check again after cleanup
        const deploymentsAfterCleanup = await this.listDeployments();
        if (deploymentsAfterCleanup.length >= maxDeployments) {
          throw new OrchestratorError(
            ErrorCode.DEPLOYMENT_CREATE_FAILED,
            `Cannot create new deployment: Maximum deployments limit (${maxDeployments}) reached. Current active deployments: ${deploymentsAfterCleanup.length}`,
            {
              maxDeployments,
              currentCount: deploymentsAfterCleanup.length,
            },
            true
          );
        }
      }

      await this.ensureDeployment(deploymentName, userId, userId, messageData);
    } catch (error) {
      // "Owned by another replica" is not a failure — it's the cross-pod
      // handled-elsewhere signal. Re-throw it UNCHANGED so the orchestrator can
      // distinguish it from a genuine startup failure and drop silently;
      // wrapping it in DEPLOYMENT_CREATE_FAILED here would erase that
      // distinction and resurface the user-facing "Worker startup failed".
      if (error instanceof ConversationOwnedElsewhereError) {
        throw error;
      }
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to create worker deployment: ${getErrorMessage(error)}`,
        { userId, conversationId, error },
        true
      );
    }
  }

  /**
   * Validate that messageData has all required fields for deployment.
   */
  private validateMessageData(
    deploymentName: string,
    messageData?: MessagePayload
  ): MessagePayload {
    if (!messageData) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Message data is required for worker deployment",
        { deploymentName },
        true
      );
    }

    const { conversationId, channelId } = messageData;
    if (!conversationId || !channelId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "conversationId and channelId are required in message data",
        {
          deploymentName,
          hasConversationId: !!conversationId,
          hasChannelId: !!channelId,
        },
        true
      );
    }

    return messageData;
  }

  /**
   * Sync per-agent egress judge policies into the policy store so the HTTP
   * proxy can resolve them at request time. The source is the agent's
   * `egress`-stage inline guardrails — each contributes a named judge (its
   * `policy` + optional `model`) and routes its `domains` through it.
   */
  private syncEgressPolicy(
    messageData: MessagePayload,
    deploymentName?: string
  ): void {
    const agentId = messageData.agentId;
    const organizationId = messageData.organizationId;
    // PolicyStore is keyed by `(orgId, agentId)` to prevent cross-tenant
    // policy clobbering — refuse to sync without an org id rather than
    // collapsing into a shared bucket.
    if (!this.policyStore || !agentId || !organizationId) {
      if (!organizationId && agentId) {
        logger.warn(
          { agentId, deploymentName },
          "Skipping egress policy sync — message has no organizationId"
        );
      }
      return;
    }

    const egressGuardrails = (messageData.guardrailsInline ?? []).filter(
      (g) => g.stage === "egress" && g.enabled
    );
    const bundle = egressGuardrailsToPolicyBundle(egressGuardrails);
    if (bundle) {
      this.policyStore.set(organizationId, agentId, bundle);
      if (deploymentName) {
        logger.info(
          `Synced egress judge policy for ${deploymentName}: ${bundle.judgedDomains.length} rule(s), ${Object.keys(bundle.judges).length} judge(s)`
        );
      } else {
        logger.debug("Synced egress judge policy", {
          organizationId,
          agentId,
          rules: bundle.judgedDomains.length,
          judges: Object.keys(bundle.judges).length,
        });
      }
    } else {
      this.policyStore.clear(organizationId, agentId);
    }
  }

  /**
   * Sync per-agent grants (network domains + Nix cache domains +
   * pre-approved MCP tool patterns) to the grant store. Called on worker
   * create AND on every message so config changes pick up without
   * redeploying. Also refreshes the in-memory egress judge policy store,
   * which is read by the shared HTTP proxy rather than by the worker
   * process.
   *
   * Domains reconcile against Postgres UNCONDITIONALLY — the pod-local
   * cache is never trusted for them. Non-expiring domain rows are written
   * only by this sync (allow, deny, nix), so the active rows ARE the
   * previous state: rows outside the current config are revoked, expected
   * domains whose row is missing or has a flipped allow/deny flag are
   * (re-)granted. A cache-based skip is multi-replica-unsafe here (an
   * X→Y→X config sequence across two replicas leaves Y's rows active on
   * the replica whose warm cache still says X).
   *
   * MCP tool patterns stay cache-diffed: user "always" tool approvals share
   * the store and are indistinguishable from operator `preApprovedTools`,
   * so a durable reconcile would wrongly revoke them.
   */
  async syncNetworkConfigGrants(messageData: MessagePayload): Promise<void> {
    const agentId = messageData.agentId;
    if (!agentId) return;

    this.syncEgressPolicy(messageData);

    if (!this.grantStore) return;

    const orgId = messageData.organizationId;

    // ── Domains: PG-reconciled ──────────────────────────────────────────
    // pattern → denied flag, keyed in NORMALIZED form so alias spellings
    // ("*.example.com" vs ".example.com") collapse to the single grant row
    // they share. Denies are added last so a domain listed on both sides
    // collapses to deny (matching the proxy's deny precedence).
    const expectedDomains = new Map<string, boolean>();
    for (const domain of messageData.networkConfig?.allowedDomains ?? []) {
      expectedDomains.set(normalizeDomainPattern(domain), false);
    }
    if (
      messageData.nixConfig?.packages?.length ||
      messageData.nixConfig?.flakeUrl
    ) {
      for (const domain of NIX_CACHE_DOMAINS) {
        expectedDomains.set(domain, false);
      }
    }
    for (const domain of messageData.networkConfig?.deniedDomains ?? []) {
      expectedDomains.set(normalizeDomainPattern(domain), true);
    }

    const activeDomains = new Map<string, boolean>();
    for (const row of await this.grantStore.listGrants(agentId, orgId)) {
      if (row.kind !== "domain" || row.expiresAt !== null) continue;
      activeDomains.set(row.pattern, row.denied === true);
    }

    for (const [pattern, denied] of activeDomains) {
      if (expectedDomains.has(pattern)) continue;
      // Deploy-time infra ALLOW grants (npm registries for CLI backends) are
      // not derivable from the payload — exempt them. A denied row is never
      // exempt: a config-removed deny must be reconciled away or it becomes
      // unremovable (the deploy-time grant skips denied domains).
      if (!denied && NPM_REGISTRY_DOMAINS.includes(pattern)) continue;
      await this.grantStore.revoke(agentId, pattern, orgId);
    }
    for (const [pattern, denied] of expectedDomains) {
      if (activeDomains.get(pattern) !== denied) {
        await this.grantStore.grant(agentId, pattern, null, denied, orgId);
      }
    }

    // ── MCP tool patterns: cache-diffed ─────────────────────────────────
    const nextTools = new Set(messageData.preApprovedTools ?? []);
    const cacheKey = `${orgId ?? ""}|${agentId}`;
    const previousTools = this.grantSyncCache.get(cacheKey);

    for (const pattern of previousTools ?? []) {
      if (!nextTools.has(pattern)) {
        await this.grantStore.revoke(agentId, pattern, orgId);
      }
    }
    for (const pattern of nextTools) {
      if (!previousTools?.has(pattern)) {
        await this.grantStore.grant(agentId, pattern, null, undefined, orgId);
      }
    }

    // LRU touch: delete + re-insert so the agent becomes the newest key.
    this.grantSyncCache.delete(cacheKey);
    this.grantSyncCache.set(cacheKey, nextTools);

    // Evict the oldest entry if we've exceeded the cap.
    if (this.grantSyncCache.size > GRANT_SYNC_CACHE_MAX) {
      const oldest = this.grantSyncCache.keys().next().value;
      if (oldest !== undefined) {
        this.grantSyncCache.delete(oldest);
      }
    }
  }

  /**
   * Clear the grant sync cache for an agent. Call this when the agent's
   * networkConfig or preApprovedTools change (deployment teardown, config
   * reload) so the next message re-syncs grants.
   */
  invalidateGrantSyncCache(agentId: string): void {
    // Keys are `org|agent`; drop the agent's entry across every org.
    const suffix = `|${agentId}`;
    for (const key of this.grantSyncCache.keys()) {
      if (key.endsWith(suffix)) {
        this.grantSyncCache.delete(key);
      }
    }
  }

  /** Clear the entire grant sync cache. Call on whole-config reload. */
  clearAllGrantSyncCaches(): void {
    this.grantSyncCache.clear();
  }

  /**
   * Build proxy URL with deployment identification via Basic auth.
   */
  private buildProxyUrl(
    deploymentName: string,
    workerToken: string,
    dispatcherHost: string
  ): string {
    const parsedProxyPort = Number.parseInt(
      process.env.WORKER_PROXY_PORT || "8118",
      10
    );
    const proxyPort = Number.isFinite(parsedProxyPort) ? parsedProxyPort : 8118;
    return `http://${deploymentName}:${workerToken}@${dispatcherHost}:${proxyPort}`;
  }

  /**
   * Assemble the base environment variables map for a worker deployment.
   */
  private assembleBaseEnv(
    username: string,
    userId: string,
    deploymentName: string,
    workerToken: string,
    messageData: MessagePayload,
    traceId: string | undefined,
    proxyUrl: string,
    dispatcherHost: string
  ): Record<string, string> {
    const { conversationId, channelId, platformMetadata } = messageData;

    const envVars: Record<string, string> = {
      USER_ID: userId,
      USERNAME: username,
      DEPLOYMENT_NAME: deploymentName,
      CHANNEL_ID: channelId,
      ORIGINAL_MESSAGE_TS:
        (typeof platformMetadata?.originalMessageTs === "string"
          ? platformMetadata.originalMessageTs
          : "") ||
        messageData.messageId ||
        "",
      LOG_LEVEL: "info",
      WORKSPACE_DIR: "/workspace",
      CONVERSATION_ID: conversationId,
      WORKER_TOKEN: workerToken,
      DISPATCHER_URL: this.getDispatcherUrl(),
      NODE_ENV: process.env.NODE_ENV || "production",
      DEBUG: "1",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: `${dispatcherHost},gateway,localhost,127.0.0.1`,
      // Pin HOME inside the persistent workspace so per-tool caches
      // (~/.npm, ~/.cache, ~/.config, ~/.local/share) survive worker restarts
      // without leaking into the gateway host home directory.
      HOME: "/workspace",
      // Route temporary files and cache to persistent workspace storage.
      TMPDIR: "/workspace/.tmp",
      TMP: "/workspace/.tmp",
      TEMP: "/workspace/.tmp",
      XDG_CACHE_HOME: "/workspace/.cache",
    };

    if (typeof platformMetadata?.botResponseTs === "string") {
      envVars.BOT_RESPONSE_TS = platformMetadata.botResponseTs;
    }

    if (traceId) {
      envVars.TRACE_ID = traceId;
    }

    // Forward Sentry config so the worker subprocess can report provider/model
    // failures to Sentry Issues (core/sentry.ts initSentry() is DSN-gated and
    // no-ops without SENTRY_DSN). The app process owns the DSN via envFrom in
    // prod; without this forwarding the worker is entirely unmonitored.
    //
    // EGRESS: the worker reaches Sentry THROUGH the gateway proxy (HTTP_PROXY),
    // NOT directly. We deliberately do NOT add the Sentry host to NO_PROXY:
    // under Linux prod the worker runs in a systemd scope with
    // `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1/::1`, so a direct
    // connection to Sentry's public IP would be dropped by the kernel. Routing
    // via the proxy (loopback, allowed) works in both prod and dev. The proxy's
    // allowlist is widened to admit the Sentry ingest host in
    // network-allowlist.ts (loadAllowedDomains), gated on SENTRY_DSN.
    if (process.env.SENTRY_DSN) {
      envVars.SENTRY_DSN = process.env.SENTRY_DSN;
    }
    if (process.env.ENVIRONMENT) {
      envVars.ENVIRONMENT = process.env.ENVIRONMENT;
    }
    if (process.env.SENTRY_RELEASE) {
      envVars.SENTRY_RELEASE = process.env.SENTRY_RELEASE;
    }
    // APP_GIT_SHA is baked into the prod image and used as the Sentry `release`
    // fallback (core/sentry.ts) when SENTRY_RELEASE is unset.
    if (process.env.APP_GIT_SHA) {
      envVars.APP_GIT_SHA = process.env.APP_GIT_SHA;
    }

    // Add OTLP endpoint for distributed tracing
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (otlpEndpoint) {
      envVars.OTEL_EXPORTER_OTLP_ENDPOINT = otlpEndpoint;
      try {
        const otlpUrl = new URL(otlpEndpoint);
        envVars.NO_PROXY = `${envVars.NO_PROXY},${otlpUrl.hostname}`;
      } catch {
        envVars.NO_PROXY = `${envVars.NO_PROXY},tempo`;
      }
    }

    // Forward WORKER_ENV_* vars to workers with prefix stripped
    const WORKER_ENV_PREFIX = "WORKER_ENV_";
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(WORKER_ENV_PREFIX)) {
        const stripped = key.slice(WORKER_ENV_PREFIX.length);
        const value = process.env[key];
        if (stripped && value !== undefined) {
          envVars[stripped] = value;
        }
      }
    }

    // Nix config
    if (messageData.nixConfig) {
      const { flakeUrl, packages } = messageData.nixConfig;
      if (flakeUrl) envVars.NIX_FLAKE_URL = flakeUrl;
      if (packages && packages.length > 0)
        envVars.NIX_PACKAGES = packages.join(",");
      logger.debug(
        `Nix config for ${deploymentName}: flakeUrl=${flakeUrl || "none"}, packages=${packages?.length || 0}`
      );
    }

    return envVars;
  }

  /**
   * Replace secret env var values with opaque placeholders before passing to workers.
   *
   * Provider credential env vars are set to `"lobu-proxy"` — the proxy resolves
   * the real credential at request time using agentId from the URL path
   * (`/a/{agentId}`) and the provider slug.
   *
   * Non-provider secrets use UUID placeholders stored in the secret-proxy.
   *
   * `preMaterializedSecrets` contains connector-tooling values that are already
   * safe for the worker: short-lived credential leases that expire on their own.
   * The value comparison matters because an operator override with the same env
   * name is still a durable secret and must go through normal placeholder
   * injection.
   */
  private async injectSecretPlaceholders(
    envVars: Record<string, string>,
    agentId: string,
    deploymentName: string,
    context?: ProviderCredentialContext,
    preMaterializedSecrets?: Readonly<Record<string, string>>
  ): Promise<Record<string, string>> {
    // Tests that exercise deployment lifecycle without a secret store can
    // skip placeholder injection (no secrets to swap).
    if (!this.secretStore) return envVars;
    const secretStore = this.secretStore;

    // Collect credential env var names from all providers
    const providerCredentialVars = new Set<string>();
    for (const provider of this.providerModules) {
      providerCredentialVars.add(provider.getCredentialEnvVarName());
    }

    let hasSecrets = false;
    const workerToken = envVars.WORKER_TOKEN;
    for (const [key, value] of Object.entries(envVars)) {
      if (!value || !isSecretEnvVar(key, this.providerModules)) continue;
      if (key === "WORKER_TOKEN") continue;
      if (preMaterializedSecrets?.[key] === value) continue;
      // Some providers (e.g. Bedrock) authenticate workers by JWT and
      // legitimately put the worker's own WORKER_TOKEN into the credential
      // env var — the gateway verifies it on the incoming request. In that
      // case we must not swap the value for a placeholder; the worker needs
      // the real JWT to call the gateway route.
      if (workerToken && value === workerToken) continue;

      if (providerCredentialVars.has(key)) {
        // Provider credentials use a proxy placeholder. The worker never
        // sees real credentials. The proxy resolves the real credential
        // using agentId from the URL path (/a/{agentId}) and the provider
        // slug, then overrides the Authorization header before forwarding.
        const ownerProvider = this.providerModules.find(
          (p) => p.getCredentialEnvVarName() === key
        );
        if (ownerProvider?.buildCredentialPlaceholder) {
          envVars[key] = await ownerProvider.buildCredentialPlaceholder(
            agentId,
            context
          );
        } else {
          envVars[key] = "lobu-proxy";
        }
        hasSecrets = true;
      } else {
        // Custom env var secrets (non-provider): move the value into the
        // secret store and hand the worker an opaque UUID placeholder.
        try {
          const secretRef = await persistSecretValue(
            secretStore,
            `deployments/${deploymentName}/${agentId}/${key}`,
            value,
            { ttlSeconds: SECRET_PLACEHOLDER_TTL_SECONDS }
          );
          if (!secretRef) continue;
          const placeholder = generatePlaceholder(
            agentId,
            key,
            secretRef,
            deploymentName,
            {
              ttlSeconds: SECRET_PLACEHOLDER_TTL_SECONDS,
              organizationId: context?.organizationId,
            }
          );
          envVars[key] = placeholder;
          hasSecrets = true;
        } catch (error) {
          logger.warn(`Failed to generate placeholder for ${key}:`, error);
        }
      }
    }

    if (hasSecrets) {
      logger.info(
        `🔐 Generated secret placeholders for ${deploymentName}, routing through proxy`
      );
    }

    return envVars;
  }

  /**
   * Resolve what the org's connections contribute to this agent's sandbox.
   *
   * Fails soft by design: connector tooling is an enhancement, so a resolution
   * error (DB blip, malformed declaration, provider outage) must degrade to "no
   * contribution" rather than block the deployment. The agent then runs without
   * the CLI and says so, instead of the user seeing a worker that never starts.
   */
  private async resolveConnectorAgentTooling(
    messageData: MessagePayload,
    deploymentName: string
  ): Promise<ResolvedAgentTooling> {
    const empty: ResolvedAgentTooling = {
      packages: [],
      env: {},
      domains: [],
      leaseExpiresAt: null,
      // Sentinel: resolution did not run or failed. Recorded as "unknown"
      // rather than as a real digest, so the next turn does not read a
      // transient failure as "tooling changed" and recycle a healthy worker.
      fingerprint: UNKNOWN_TOOLING_FINGERPRINT,
    };
    const { agentId, organizationId } = messageData;
    if (!agentId || !organizationId) return empty;

    try {
      return await resolveAgentTooling({
        agentId,
        organizationId,
        deploymentName,
        // No registry wired (tests, or a gateway with no lease providers) still
        // contributes packages and domains — an empty registry mints nothing,
        // so lease vars are simply absent rather than the whole contribution.
        leaseRegistry: this.leaseRegistry ?? EMPTY_LEASE_REGISTRY,
        runId: messageData.runId,
      });
    } catch (error) {
      logger.warn(
        { agentId, organizationId, deploymentName, error },
        "Failed to resolve connector-contributed agent tooling — deploying without it"
      );
      return empty;
    }
  }

  /**
   * Generate environment variables common to all deployment types.
   * Orchestrates the focused helpers above.
   */
  protected async generateEnvironmentVariables(
    username: string,
    userId: string,
    deploymentName: string,
    messageData?: MessagePayload,
    includeSecrets: boolean = true
  ): Promise<Record<string, string>> {
    const validated = this.validateMessageData(deploymentName, messageData);
    const { conversationId, channelId, platformMetadata, agentId, platform } =
      validated;
    const teamId =
      validated.teamId ||
      (typeof platformMetadata?.teamId === "string"
        ? platformMetadata.teamId
        : undefined);
    const traceId = extractTraceId(validated);
    const providerContext: ProviderCredentialContext = {
      userId,
      conversationId,
      channelId,
      deploymentName,
      platform,
      connectionId:
        typeof platformMetadata?.connectionId === "string"
          ? platformMetadata.connectionId
          : undefined,
      organizationId: validated.organizationId,
    };

    // Resolve THIS CONVERSATION's pinned runtime provider (frozen on its first
    // turn) for the deployment token claim, so the generic runtime route picks
    // the provider. Reading the pin (not the agent's current env) is what makes
    // an agent repoint never move an existing conversation's sandbox. Undefined →
    // local just-bash.
    const runtimeSelection =
      agentId && validated.organizationId
        ? await resolvePinnedSelection({
            organizationId: validated.organizationId,
            agentId,
            platform,
            conversationId,
          })
        : {};

    const dispatcherHost = this.getDispatcherHost();

    // Connector-contributed agent tooling: an active connection whose connector
    // declares `agentTooling` puts its CLI on PATH, its credential in the env,
    // and its hosts on the egress allowlist. Resolved BEFORE the grant sync and
    // folded into `networkConfig.allowedDomains` — that sync reconciles domains
    // against Postgres and revokes anything outside the expected set, so a
    // domain granted after it would be revoked on the very next message.
    const agentTooling = await this.resolveConnectorAgentTooling(
      validated,
      deploymentName
    );
    if (agentTooling.domains.length > 0) {
      validated.networkConfig = {
        ...validated.networkConfig,
        allowedDomains: [
          ...new Set([
            ...(validated.networkConfig?.allowedDomains ?? []),
            ...agentTooling.domains,
          ]),
        ],
      };
    }
    if (agentTooling.packages.length > 0) {
      // Union, never replace: the agent's own packages and its enabled skills'
      // are hard requirements of code that will run in the same sandbox.
      validated.nixConfig = {
        ...validated.nixConfig,
        packages: [
          ...new Set([
            ...(validated.nixConfig?.packages ?? []),
            ...agentTooling.packages,
          ]),
        ],
      };
    }

    const deploymentTokenArgs = {
      userId,
      conversationId,
      deploymentName,
      channelId,
      teamId,
      platform,
      agentId,
      organizationId: validated.organizationId,
      platformMetadata,
      traceId,
      runtimeProviderId: runtimeSelection.runtimeProviderId,
      sandboxId: runtimeSelection.sandboxId,
      // Same allowlist synced to the grant store / JUST_BASH_ALLOWED_DOMAINS — so
      // the runtime route reads it off the signed token, not the worker's body.
      allowedDomains: validated.networkConfig?.allowedDomains,
      deniedDomains: validated.networkConfig?.deniedDomains,
      // Same package union the local nix-shell spawn uses below — signed here so
      // a REMOTE runtime provisions the same set instead of running without it.
      nixPackages: validated.nixConfig?.packages,
    };
    const { workerToken, egressProxyToken } =
      buildDeploymentTokenPair(deploymentTokenArgs);
    // Agent subprocesses can read HTTP_PROXY. Give the proxy a separately
    // typed credential that carries the same egress-policy claims but is
    // rejected by every worker-facing gateway auth path.

    // Sync network domains (allow + deny + nix caches), pre-approved MCP
    // tool patterns, and the egress judge policy — single-sourced with the
    // per-message refresh path so create and update can never diverge.
    await this.syncNetworkConfigGrants(validated);

    const proxyUrl = this.buildProxyUrl(
      deploymentName,
      egressProxyToken,
      dispatcherHost
    );

    let envVars = this.assembleBaseEnv(
      username,
      userId,
      deploymentName,
      workerToken,
      validated,
      traceId,
      proxyUrl,
      dispatcherHost
    );

    // Connector-contributed credentials. Set before the module/config layers so
    // an operator-configured value for the same name still wins — an explicit
    // override must beat an implicit contribution.
    //
    // The reserved-name check is defense in depth: the resolver already drops
    // these, but this merge writes over an ALREADY-BUILT base env, so a name
    // that slipped through would replace gateway-owned runtime state
    // (WORKER_TOKEN, the proxy vars, PATH…) rather than merely add to it.
    for (const [key, value] of Object.entries(agentTooling.env)) {
      if (isReservedAgentToolingEnvName(key)) {
        logger.error(
          { agentId, deploymentName, env_name: key },
          "Refusing to overwrite a reserved worker env var with connector-contributed tooling"
        );
        delete agentTooling.env[key];
        continue;
      }
      envVars[key] = value;
    }

    // Remember when this deployment's credential dies. A worker reads its env
    // once at process start, so the only way to hand it a fresh token is to
    // recycle it — `hasExpiringLease` lets the warm path do that on the turn
    // BEFORE the credential lapses instead of serving a sandbox whose `gh`
    // has started 401ing.
    if (agentTooling.leaseExpiresAt) {
      this.leaseExpiryByDeployment.set(
        deploymentName,
        agentTooling.leaseExpiresAt
      );
      this.leaseMintedAtByDeployment.set(deploymentName, new Date());
    } else {
      this.leaseExpiryByDeployment.delete(deploymentName);
      this.leaseMintedAtByDeployment.delete(deploymentName);
    }
    // Remember WHICH connections built this sandbox, so a later turn can tell
    // that one was added, removed, or repointed at a different installation.
    // A failed resolution records nothing: absent means "no evidence", which
    // keeps the worker rather than recycling it on a transient DB error.
    if (agentTooling.fingerprint === UNKNOWN_TOOLING_FINGERPRINT) {
      this.toolingFingerprintByDeployment.delete(deploymentName);
      this.organizationByDeployment.delete(deploymentName);
    } else {
      this.toolingFingerprintByDeployment.set(
        deploymentName,
        agentTooling.fingerprint
      );
      if (validated.organizationId) {
        this.organizationByDeployment.set(
          deploymentName,
          validated.organizationId
        );
      }
    }

    // Include host-provided secret references when requested.
    if (includeSecrets && this.moduleEnvVarsBuilder) {
      try {
        envVars = await this.moduleEnvVarsBuilder(
          agentId,
          envVars,
          providerContext
        );
      } catch (error) {
        logger.warn("Failed to build module environment variables:", error);
      }
    }

    // Add worker environment variables from configuration
    if (this.config.worker.env) {
      for (const [key, value] of Object.entries(this.config.worker.env)) {
        envVars[key] = String(value);
      }
    }

    // EXACT-MODEL GATE + module resolution (defense-in-depth backstop for the
    // COLD path — the authoritative gate is at enqueue time in the message
    // consumer, which the warm path also passes). Use the SHARED
    // `resolveDispatchModel` so this backstop agrees with the enqueue gate and
    // session-context on the effective (allow-listed, non-sentinel, ROUTABLE)
    // model. A sentinel-only / nothing-routable list yields undefined → fail
    // closed. Modules come from the same policy resolution.
    const requestedModel = validated.agentOptions?.model as string | undefined;
    let effectiveProviders: ModelProviderModule[];
    let allowedRefs: string[] | null = null;
    let agentModel: string | undefined = requestedModel;
    if (this.providerCatalogService) {
      const resolved = await this.providerCatalogService.resolveDispatchModel(
        agentId,
        validated.organizationId,
        requestedModel,
        userId
      );
      effectiveProviders = resolved.modules;
      allowedRefs = resolved.allowedRefs;
      agentModel = resolved.model;
      if (resolved.replaced && validated.agentOptions) {
        logger.warn(
          {
            agentId,
            organizationId: validated.organizationId,
            requestedModel,
            allowedRefs,
            effectiveModel: agentModel ?? null,
          },
          "Deployment backstop: requested model not routable under the agent's models list — enforcing fail-closed gate"
        );
        if (agentModel) validated.agentOptions.model = agentModel;
        else delete validated.agentOptions.model;
      }
    } else {
      effectiveProviders = this.providerModules;
    }

    for (const provider of effectiveProviders) {
      envVars = provider.injectSystemKeyFallback(envVars);
    }

    envVars = await this.injectSecretPlaceholders(
      envVars,
      agentId,
      deploymentName,
      providerContext,
      agentTooling.env
    );

    // Inject provider metadata into agentOptions so the worker can configure
    // the SDK generically without hardcoded provider checks.
    // Determine primary provider from the (now gate-checked) model.
    let primaryProvider: ModelProviderModule | undefined;

    if (
      agentModel &&
      effectiveProviders.length > 0 &&
      this.providerCatalogService
    ) {
      primaryProvider = await this.providerCatalogService.findProviderForModel(
        agentModel,
        effectiveProviders
      );
    }

    // When no explicit model is set (auto mode), detect the primary provider
    // from installed providers order (first with credentials = primary).
    if (!primaryProvider && effectiveProviders.length > 0) {
      for (const candidate of effectiveProviders) {
        if (
          candidate.hasSystemKey() ||
          (await candidate.hasCredentials(agentId, providerContext))
        ) {
          primaryProvider = candidate;
          break;
        }
      }
    }

    if (primaryProvider) {
      logger.info(
        {
          agentId,
          primaryProviderId: primaryProvider.providerId,
          slug: primaryProvider.getUpstreamConfig?.()?.slug,
        },
        "Selected primary provider"
      );

      const proxyBaseUrl = `${this.getDispatcherUrl()}/api/proxy`;
      const mappings = primaryProvider.getProxyBaseUrlMappings(
        proxyBaseUrl,
        agentId,
        providerContext
      );
      const providerBaseUrl = Object.values(mappings)[0];
      if (providerBaseUrl) {
        validated.agentOptions = {
          ...validated.agentOptions,
          providerBaseUrl,
        };
      }

      // CREDENTIAL_ENV_VAR_NAME and AGENT_DEFAULT_PROVIDER are now
      // delivered dynamically via the session context endpoint instead of
      // static process environment.
    }

    // Build full provider base URL mappings for all installed providers
    const proxyBaseUrl = `${this.getDispatcherUrl()}/api/proxy`;
    const perProvider = effectiveProviders.map((provider) => ({
      providerId: provider.providerId,
      mappings: provider.getProxyBaseUrlMappings(
        proxyBaseUrl,
        agentId,
        providerContext
      ),
    }));
    // Guard against two providers claiming the same base-URL env key with
    // different values: the later one silently clobbers the earlier and
    // mis-routes (this is exactly how an `openai/<model>` call once egressed to
    // the codex backend). Surface it loudly instead of hiding it.
    for (const c of detectProviderBaseUrlCollisions(perProvider)) {
      logger.warn(
        { agentId, ...c },
        "[deployment-manager] provider base-URL env key collision — two providers map the same key to different URLs; the later one wins and may mis-route. Each provider must use a distinct baseUrlEnvVarName."
      );
    }
    const providerBaseUrlMappings: Record<string, string> = {};
    for (const { mappings } of perProvider) {
      Object.assign(providerBaseUrlMappings, mappings);
    }
    if (Object.keys(providerBaseUrlMappings).length > 0) {
      validated.agentOptions = {
        ...validated.agentOptions,
        providerBaseUrlMappings,
      };
    }

    // CLI_BACKENDS is now delivered dynamically via session context.
    // Still need to auto-add npm registry domains for npx at deploy time.
    const hasCliBackendProviders = effectiveProviders.some((p) =>
      p.getCliBackendConfig?.()
    );
    if (hasCliBackendProviders && this.grantStore && agentId) {
      const orgId = validated.organizationId;
      for (const domain of NPM_REGISTRY_DOMAINS) {
        // An explicit deny (config deniedDomains) wins over the infra
        // convenience grant — the upsert would otherwise flip the row to
        // allowed and the warm sync cache would never restore the deny.
        if (await this.grantStore.isDenied(agentId, domain, orgId)) continue;
        await this.grantStore.grant(agentId, domain, null, undefined, orgId);
      }
      logger.info(
        `Added npm registry domains as grants for ${deploymentName}: ${NPM_REGISTRY_DOMAINS.join(", ")}`
      );
    }

    return envVars;
  }

  /**
   * Delete a worker deployment and associated resources
   */
  async deleteWorkerDeployment(
    deploymentName: string,
    options?: { failInFlightTurns?: boolean }
  ): Promise<void> {
    try {
      // Clean up secret placeholder mappings
      deleteSecretMappings(deploymentName);

      // Cascade-delete the underlying non-provider secrets written by
      // `injectSecretPlaceholders` under `deployments/{deploymentName}/`.
      // Without this, the placeholder mappings are gone but the backing
      // secret entries linger until their TTL expires (and AWS SM
      // entries would leak forever).
      if (this.secretStore) {
        try {
          const cleared = await deleteSecretsByPrefix(
            this.secretStore,
            `deployments/${deploymentName}/`
          );
          if (cleared > 0) {
            logger.debug(
              `Cleared ${cleared} deployment secret(s) for ${deploymentName}`
            );
          }
        } catch (error) {
          logger.warn(
            `Failed to clear deployment secrets for ${deploymentName}:`,
            error
          );
        }
      }

      await this.deleteDeployment(deploymentName);
      // Deliberate exits normally suppress the worker-crash fast path. A
      // bounded stale-credential recycle is the exception: once its deferral
      // budget is exhausted it may intentionally interrupt a live turn, which
      // must receive a terminal error now rather than hang until the deadline
      // sweep.
      if (options?.failInFlightTurns) {
        await failTurnsForDeployment(
          deploymentName,
          AgentErrorCode.WORKER_DIED
        );
      }
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_DELETE_FAILED,
        `Failed to delete deployment for ${deploymentName}: ${getErrorMessage(error)}`,
        { deploymentName, error },
        true
      );
    }
  }

  /**
   * Whether the org's connector tooling has changed since `deploymentName` was
   * built — a connection added, removed, or repointed at a different
   * installation, or an installation revoked or transferred.
   *
   * The message path catches this only when the pod handling the message also
   * owns the worker; with N replicas that is the minority case, so a revoked
   * connection could otherwise keep executing with the old credential. That is
   * a security-relevant staleness, not merely a missing capability, which is
   * why the reconcile reaps for it and not only for expiry.
   *
   * Fails SAFE (reports "unchanged"): a lookup error must not reap a healthy
   * worker, and the next cycle re-checks.
   */
  protected async hasStaleTooling(deploymentName: string): Promise<boolean> {
    const organizationId = this.organizationByDeployment.get(deploymentName);
    if (!organizationId) return false;
    try {
      const { fingerprint } = await resolveAgentToolingDeclaration({
        organizationId,
      });
      return this.hasToolingChanged(deploymentName, fingerprint);
    } catch (error) {
      logger.warn(
        { deploymentName, error: getErrorMessage(error) },
        "Tooling-fingerprint refresh failed; leaving the deployment in place"
      );
      return false;
    }
  }

  /**
   * Whether a turn is currently running on `deploymentName`, for teardown
   * decisions. Same rule as the message path: never SIGTERM a worker mid-turn.
   *
   * Fails SAFE (reports "busy") and never propagates: a probe error must not
   * abort `reconcileDeployments`, which also drives idle cleanup and the
   * max-deployment cap. Deferring costs one reconcile cycle; aborting the loop
   * would stall unrelated cleanup fleet-wide.
   */
  protected async isServingLiveTurn(deploymentName: string): Promise<boolean> {
    try {
      return await hasLiveTurnForDeployment(deploymentName);
    } catch (error) {
      logger.warn(
        { deploymentName, error: getErrorMessage(error) },
        "Turn-liveness probe failed; treating the deployment as busy"
      );
      return true;
    }
  }

  protected runWithDeploymentTurnLock<T>(
    deploymentName: string,
    action: () => Promise<T>
  ): Promise<T> {
    return withDeploymentTurnLock(deploymentName, action);
  }

  /**
   * Reconcile deployments: unified method for cleanup and resource management.
   */
  async reconcileDeployments(): Promise<void> {
    try {
      const maxDeployments = this.config.worker.maxDeployments;

      logger.debug("Running deployment cleanup...");

      // Get all worker deployments from the backend
      const activeDeployments = await this.listDeployments();

      if (activeDeployments.length === 0) {
        return;
      }

      // Sort deployments by last activity (oldest first)
      const sortedDeployments = [...activeDeployments].sort(
        (a, b) => a.lastActivity.getTime() - b.lastActivity.getTime()
      );

      let processedCount = 0;
      const BATCH_SIZE = 10; // Process up to 10 deletions in parallel

      // Collect actions to perform
      const toDelete: string[] = [];
      const toScaleDown: string[] = [];
      const toRecycle: string[] = [];

      for (const analysis of sortedDeployments) {
        const { deploymentName, replicas, isIdle, isVeryOld } = analysis;

        if (isVeryOld) {
          toDelete.push(deploymentName);
        } else if (isIdle && replicas > 0) {
          toScaleDown.push(deploymentName);
        } else if (
          this.hasExpiringLease(deploymentName) ||
          (await this.hasStaleTooling(deploymentName))
        ) {
          toRecycle.push(deploymentName);
        }
      }

      // Check if we exceed max deployments
      const remainingDeployments = sortedDeployments.filter(
        (d) => !d.isVeryOld
      );
      if (remainingDeployments.length > maxDeployments) {
        const excessCount = remainingDeployments.length - maxDeployments;
        const deploymentsToDelete = remainingDeployments.slice(0, excessCount);
        for (const { deploymentName } of deploymentsToDelete) {
          if (
            !toDelete.includes(deploymentName) &&
            !toRecycle.includes(deploymentName)
          ) {
            toDelete.push(deploymentName);
          }
        }
      }

      // Process deletions in parallel batches
      processedCount += await runInBatches(
        toDelete,
        BATCH_SIZE,
        (name) => this.deleteWorkerDeployment(name),
        (name, reason) => {
          logger.error(`❌ Failed to delete deployment ${name}:`, reason);
        }
      );

      let recycledCount = 0;
      await runInBatches(
        toRecycle,
        BATCH_SIZE,
        async (name) => {
          await this.runWithDeploymentTurnLock(name, async () => {
            // Turn-marker inserts take this same advisory lock. A concurrent
            // turn either lands first and blocks this teardown, or waits until
            // the old worker is gone and then causes a replacement to spawn.
            if (
              !this.hasExpiringLease(name) &&
              !(await this.hasStaleTooling(name))
            ) {
              // Another owner rebuilt it, or the tooling matches again. Clear
              // the run of deferrals so a later, unrelated staleness gets the
              // full budget rather than an inherited one.
              this.recycleDeferralsByDeployment.delete(name);
              return;
            }
            // Bounded deferral: a live turn buys the worker a few cycles, not
            // an indefinite reprieve. See MAX_RECYCLE_DEFERRALS.
            const deferrals = this.recycleDeferralsByDeployment.get(name) ?? 0;
            const forceRecycle =
              deferrals >= DeploymentManager.MAX_RECYCLE_DEFERRALS;
            if (
              !forceRecycle &&
              (await this.isServingLiveTurn(name))
            ) {
              this.recycleDeferralsByDeployment.set(name, deferrals + 1);
              logger.info(
                {
                  deploymentName: name,
                  deferrals: deferrals + 1,
                  maxDeferrals: DeploymentManager.MAX_RECYCLE_DEFERRALS,
                },
                "Deferring stale-deployment reap: a turn is still in flight"
              );
              return;
            }
            logger.info(
              { deploymentName: name },
              "Reaping a deployment whose connector tooling or lease is stale"
            );
            await this.deleteWorkerDeployment(name, {
              failInFlightTurns: forceRecycle,
            });
            recycledCount += 1;
          });
        },
        (name, reason) => {
          logger.error(`❌ Failed to recycle deployment ${name}:`, reason);
        }
      );
      processedCount += recycledCount;

      // Process scale-downs in parallel batches
      processedCount += await runInBatches(
        toScaleDown,
        BATCH_SIZE,
        (name) => this.scaleDeployment(name, 0),
        (name, reason) => {
          logger.error(`❌ Failed to scale down deployment ${name}:`, reason);
        }
      );

      if (processedCount > 0) {
        logger.info(
          `✅ Cleanup completed: processed ${processedCount} deployment(s)`
        );
      }
    } catch (error) {
      logger.error(
        "Error during deployment reconciliation:",
        getErrorMessage(error)
      );
    }
  }

  private getWorkerEntryPoint(): string {
    const entryPoint = this.config.worker.entryPoint;
    if (!entryPoint) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "OrchestratorConfig.worker.entryPoint is required for embedded mode. " +
          "Callers must supply an absolute path to the worker source file."
      );
    }
    return entryPoint;
  }

  async validateWorkerImage(): Promise<void> {
    const entryPoint = this.getWorkerEntryPoint();
    if (!fs.existsSync(entryPoint)) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Worker entry point not found: ${entryPoint}`
      );
    }
    logger.debug(`Worker entry point verified: ${entryPoint}`);
  }

  protected async spawnDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload
  ): Promise<void> {
    // Embedded mode is single-process by definition, so there is no cross-
    // process orchestrator to enforce uniqueness. The in-flight cache
    // catches concurrent calls; this guards the rare case where a
    // fully-completed worker is still in the map and a fresh create slips
    // past the upstream `listDeployments()` check (e.g. stale snapshot).
    if (this.workers.has(deploymentName)) {
      return;
    }

    const agentId = messageData?.agentId;
    if (!agentId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Missing agentId in message payload"
      );
    }
    // agentId is interpolated into a filesystem path and into the systemd
    // unit name; reject anything that could escape the workspaces tree or
    // smuggle shell metacharacters into nix-shell / systemd-run argv below.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Invalid agentId: must be 1-64 chars of [A-Za-z0-9_-]`
      );
    }
    const workspaceDir = path.resolve(`workspaces/${agentId}`);
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

    // Cross-pod gate for snapshot mode: only one pod at a time may run a
    // worker for a given (org, agent, conversationId). Without this two
    // pods that both claim chat_message runs for the same conversation
    // would hydrate from the same `completed` snapshot, run independently,
    // and produce divergent next snapshots — one reply silently wins.
    //
    // The lock is held by a reserved Postgres connection for the lifetime
    // of the worker subprocess (released in the `exit` handler below). If
    // another pod has the lock, that pod legitimately OWNS this turn and is
    // running it to completion — we throw `ConversationOwnedElsewhereError`
    // so this pod drops the spawn silently (no retry, no user-facing error).
    // Retrying could never win: the holder keeps the lock for the whole
    // worker lifetime.
    const conversationId =
      typeof messageData?.conversationId === "string"
        ? messageData.conversationId
        : null;
    const organizationId =
      typeof messageData?.organizationId === "string"
        ? messageData.organizationId
        : null;
    // A turn writes a SHARED snapshot only when it carries a `runId` (the
    // worker's `writeSnapshot` bails otherwise — see the runId comment in
    // MessageConsumer.handleMessage). Legacy direct-enqueue / unit-test
    // turns leave `runId` undefined, never write a shared snapshot, and so
    // can never produce the divergent-snapshot race the cross-pod lock
    // guards against — they are safe to spawn without the lock even with no
    // org/conversationId.
    const writesSharedSnapshot = typeof messageData?.runId === "number";
    // A snapshot-writing turn with org OR conversationId missing CANNOT take
    // the cross-pod lock (the lock key is (org, agent, conversationId)). The
    // old code silently SKIPPED the lock in that case, so two pods could
    // both hydrate the same `completed` snapshot and write divergent next
    // snapshots — one reply silently wins. Refuse to spawn instead: a
    // re-queueable failure (mirrors the lock-busy throw below) so the runs
    // queue retries rather than running an unguarded, divergence-prone
    // worker. This is a misconfiguration in practice (snapshot turns always
    // carry org + conversationId), so surfacing it beats silently diverging.
    if (writesSharedSnapshot && (!organizationId || !conversationId)) {
      logger.error(
        `Refusing to spawn worker ${deploymentName}: ` +
          `cross-pod conversation lock requires both organizationId and ` +
          `conversationId (org=${organizationId ?? "<missing>"}, ` +
          `conv=${conversationId ?? "<missing>"})`
      );
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Cannot acquire per-conversation lock: turn is missing organizationId or conversationId"
      );
    }
    let convLock: { release: () => Promise<void> } | null = null;
    if (organizationId && conversationId) {
      try {
        convLock = await acquireConversationLock(
          organizationId,
          agentId,
          conversationId
        );
      } catch (err) {
        logger.error(
          `Failed to acquire conversation lock: ${getErrorMessage(err)}`
        );
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          "Could not acquire per-conversation lock"
        );
      }
      if (!convLock) {
        // Another pod legitimately OWNS this conversation turn and is running
        // the worker to completion. This is NOT a failure — it is the cross-pod
        // "handled elsewhere" signal. Throw the typed
        // `ConversationOwnedElsewhereError` so the orchestrator drops THIS pod's
        // spawn silently (no retry, no user-facing "Worker startup failed", no
        // Critical log). The winning pod discharges the shared turn-liveness
        // marker on its successful reply, so the user still gets the answer.
        // Retrying here can never win: the winner holds the session-level
        // advisory lock for the entire worker subprocess lifetime.
        logger.info(
          `Conversation lock owned by another pod for ${organizationId}/${agentId}/${conversationId}; dropping this pod's spawn (handled elsewhere)`
        );
        throw new ConversationOwnedElsewhereError(
          "Conversation owned by another replica"
        );
      }
    }

    // The conversation lock is held for the worker subprocess lifetime and
    // released in the child's exit handler (wired in spawnWorkerChild). Until a
    // child exists, any throw in the spawn-prep block must release it (and the
    // underlying reserved pg connection) to avoid leaking a per-conversation
    // lock until the gateway recycles. Codex P1#2 on PR #865. Defined before
    // the try so the catch and the spawn handlers share one idempotent release.
    let lockReleasePromise: Promise<void> | null = null;
    const releaseLockOnce = (): Promise<void> => {
      lockReleasePromise ??= convLock?.release() ?? Promise.resolve();
      return lockReleasePromise;
    };

    let commonEnvVars: Record<string, string>;
    let baseCommand: string;
    let baseArgs: string[];
    try {
      commonEnvVars = await this.generateEnvironmentVariables(
        username,
        userId,
        deploymentName,
        messageData,
        true
      );

      commonEnvVars.WORKSPACE_DIR = workspaceDir;
      const embeddedPath = buildEmbeddedWorkerPath(
        this.config.worker.binPathEntries,
        commonEnvVars.PATH || process.env.PATH
      );
      if (embeddedPath) {
        commonEnvVars.PATH = embeddedPath;
      }

      // Serialize allowed domains for worker-side just-bash bootstrap
      const allowedDomains = messageData?.networkConfig?.allowedDomains ?? [];
      if (allowedDomains.length > 0) {
        commonEnvVars.JUST_BASH_ALLOWED_DOMAINS =
          JSON.stringify(allowedDomains);
      }

      // Determine spawn command based on nix packages. Monorepo development
      // runs the TypeScript worker via Bun; published CLI installs resolve the
      // compiled @lobu/worker dist entry and can run it with Node.
      const nixPackages = messageData?.nixConfig?.packages ?? [];
      const workerEntryPoint = this.getWorkerEntryPoint();
      const workerInvocation = buildWorkerInvocation(workerEntryPoint);

      // ALWAYS validate declared nix package names, even when we end up falling
      // back to a plain spawn below. `nix-shell -p <arg>` evaluates each <arg>
      // as a Nix *expression*, so a bare string like `pkgs.fetchurl;
      // builtins.exec …` or `import ./evil.nix` would run code at evaluation
      // time. Never forward the raw skill string: validate it to a strict leaf
      // (or known `<namespace>.<leaf>`) identifier and re-emit an explicit
      // `pkgs.<name>` attribute reference instead. Done before the nix-shell
      // presence check so a malicious package name is rejected regardless.
      const packageRefs = nixPackages.map(nixPackageAttrRef);

      // Only wrap in nix-shell when nix packages are declared AND nix-shell is
      // actually present. Without it (e.g. the prod app image, which bakes
      // Chromium in directly), fall back to a plain spawn rather than crashing
      // the worker with `spawn nix-shell ENOENT` — the same graceful
      // degradation as the systemd-run wrap below.
      const nixShell = nixPackages.length > 0 ? locateNixShell() : null;
      if (nixPackages.length > 0 && nixShell) {
        // Wrap in nix-shell so nix binaries are on PATH. `-E` takes a single
        // expression that resolves to the build inputs; `pkgs` is bound to the
        // nixpkgs set via a `let` and every ref was validated above.
        baseCommand = nixShell;
        baseArgs = [
          "-E",
          `let pkgs = import <nixpkgs> {}; in pkgs.mkShell { buildInputs = [ ${packageRefs.join(" ")} ]; }`,
          "--run",
          buildShellCommand(workerInvocation.command, workerInvocation.args),
        ];
        logger.info(
          `Spawning embedded worker ${deploymentName} with nix packages: ${nixPackages.join(", ")}`
        );
      } else {
        if (nixPackages.length > 0) {
          logger.warn(
            `nix-shell not available — spawning worker ${deploymentName} WITHOUT nix packages [${nixPackages.join(", ")}]. Declared native deps are unavailable unless baked into the runtime image; set LOBU_DISABLE_NIX_SHELL=1 to silence this probe.`
          );
        }
        baseCommand = workerInvocation.command;
        baseArgs = workerInvocation.args;
      }

      // Wrap in a hardened systemd-run scope when available, spawn the worker,
      // and wire its lifecycle handlers. Throws (re-queueable) only if the host
      // cannot sandbox AND LOBU_REQUIRE_WORKER_SANDBOX=1. On success, ownership
      // of `convLock` transfers into the child's exit handler.
      this.spawnWorkerChild({
        deploymentName,
        workspaceDir,
        commonEnvVars,
        baseCommand,
        baseArgs,
        allowSystemd: true,
        convLock,
        releaseLockOnce,
        isRetry: false,
      });
    } catch (err) {
      // Pre-spawn throw (generateEnvironmentVariables, nix package validation,
      // getWorkerEntryPoint, the cloud sandbox gate, or a synchronous spawn()
      // failure). No child exists yet, so no exit handler will fire to release
      // the lock or clear the tooling state recorded during env assembly.
      this.forgetDeploymentTooling(deploymentName);
      await releaseLockOnce();
      throw err;
    }
  }

  /**
   * Wrap the worker command in a `systemd-run --user --scope` (cgroup limits +
   * IPAddressDeny — the only properties a scope honors) when available, spawn
   * it, and wire stdout/stderr/error/exit handlers + the worker-map entry.
   *
   * Graceful degradation: on a host with no usable systemd user manager the
   * worker runs unwrapped (self-host / dev / the prod container, which ships no
   * systemd-run) — UNLESS LOBU_REQUIRE_WORKER_SANDBOX=1, where it throws a
   * re-queueable error rather than silently run unwrapped.
   *
   * Self-heal: locateSystemdRun() is a point-in-time probe. If the user bus /
   * manager disappears after boot, the `--scope` wrapper exits ~instantly with
   * a bus/setup error BEFORE the worker runs. We detect that exact signature,
   * demote the process-wide systemd cache, and transparently re-spawn the
   * worker unwrapped (re-applying the sandbox-required gate) — reusing the
   * still-held conversation lock so no sibling pod can claim the turn mid-swap.
   */
  private spawnWorkerChild(params: {
    deploymentName: string;
    workspaceDir: string;
    commonEnvVars: Record<string, string>;
    baseCommand: string;
    baseArgs: string[];
    allowSystemd: boolean;
    convLock: { release: () => Promise<void> } | null;
    releaseLockOnce: () => Promise<void>;
    isRetry: boolean;
  }): void {
    const {
      deploymentName,
      workspaceDir,
      commonEnvVars,
      baseCommand,
      baseArgs,
      convLock,
      releaseLockOnce,
    } = params;

    let command = baseCommand;
    let spawnArgs = baseArgs;
    let systemdWrapped = false;

    // On Linux hosts with a usable systemd user manager, wrap the worker in a
    // transient scope (cgroup limits + IPAddressDeny). Degrades to a plain
    // spawn on macOS / hosts without one (e.g. the prod container, which ships
    // no systemd-run).
    const systemdRun = params.allowSystemd ? locateSystemdRun() : null;
    if (systemdRun) {
      const unitName = makeUnitName(deploymentName);
      command = systemdRun;
      spawnArgs = [
        ...buildSystemdRunArgs({ unitName }),
        "--",
        baseCommand,
        ...baseArgs,
      ];
      systemdWrapped = true;
      // `systemd-run --user` reaches the caller's user bus via these two vars.
      // The worker spawn env is otherwise sanitized (no gateway env carried
      // over), so without forwarding them the --user scope fails with "Failed
      // to connect to bus: No medium found" even though the gateway process
      // itself can reach the bus. Forwarded only for the wrapped spawn; benign
      // to the worker running inside the scope.
      for (const key of [
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
      ] as const) {
        const value = process.env[key];
        if (value) commonEnvVars[key] = value;
      }
      logger.info(
        `Spawning embedded worker ${deploymentName} under systemd-run scope ${unitName}`
      );
    } else if (workerSandboxRequired()) {
      // Operator requires the sandbox (LOBU_REQUIRE_WORKER_SANDBOX=1) but it is
      // unavailable: fail closed rather than silently run unwrapped.
      if (params.isRetry) {
        // Reached from the async exit handler's self-heal — can't throw to a
        // caller, so fail the in-flight turn(s) with the clear message and
        // release the lock we were holding across the swap. No replacement
        // child exists, so the env-build state no longer describes a worker.
        this.forgetDeploymentTooling(deploymentName);
        const lockRelease = releaseLockOnce();
        this.trackConversationLockRelease(deploymentName, lockRelease);
        failTurnsForDeployment(
          deploymentName,
          AgentErrorCode.WORKER_SANDBOX_REQUIRED
        ).catch((failErr) => {
          logger.error(
            `Failed to fail in-flight turns after refusing un-sandboxed worker ${deploymentName}: ${getErrorMessage(failErr)}`
          );
        });
        return;
      }
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        AGENT_ERRORS[AgentErrorCode.WORKER_SANDBOX_REQUIRED].message ?? ""
      );
    } else if (
      params.allowSystemd &&
      process.platform === "linux" &&
      process.env.LOBU_DISABLE_SYSTEMD_RUN !== "1" &&
      !warnedUnsandboxedWorkers
    ) {
      // On Linux without an explicit opt-out, surface ONCE that workers run
      // without the cgroup/IPAddressDeny sandbox (network egress is still
      // constrained by the proxy allowlist). Silent on macOS / when explicitly
      // disabled, where running unwrapped is the normal, intended path.
      warnedUnsandboxedWorkers = true;
      logger.warn(
        "systemd worker sandbox unavailable — workers run WITHOUT cgroup limits / IPAddressDeny on this host. Network egress is still constrained by the proxy allowlist. (Logged once; set LOBU_DISABLE_SYSTEMD_RUN=1 to acknowledge, or LOBU_REQUIRE_WORKER_SANDBOX=1 to fail closed instead.)"
      );
    }

    const spawnStart = Date.now();
    let recentStderr = "";

    const child = spawn(command, spawnArgs, {
      // Workers must not inherit gateway-only secrets (DATABASE_URL, OAuth
      // secrets, etc.). Everything a worker needs is assembled explicitly in
      // assembleBaseEnv, with optional operator-provided values forwarded only
      // via WORKER_ENV_*. SENTRY_DSN (+ ENVIRONMENT/SENTRY_RELEASE/APP_GIT_SHA)
      // IS forwarded there now so the worker can report provider/model
      // failures to Sentry Issues — it reaches Sentry via the gateway proxy
      // (the Sentry host is added to the proxy allowlist), not directly, so
      // the Linux IPAddressDeny scope doesn't drop the capture POST.
      env: commonEnvVars,
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      // Run the worker in its OWN process group (child.pid == pgid). The
      // direct child is usually a wrapper — `systemd-run --scope` on Linux,
      // `nix-shell --run` for native-dep connectors — so a plain
      // `child.kill()` signals only the wrapper and reparents the real worker
      // to init (the orphan `make clean-workers` exists to reap). With a
      // dedicated group we can signal the wrapper AND the worker together via
      // the negative pid in killWorker(). See signalWorkerGroup().
      detached: true,
    });

    // Spawn errors (binary missing, EACCES, fork failure) fire on the child
    // *after* spawn() returns, so without an "error" listener Node would
    // throw an unhandled exception and crash the gateway. Drop the entry
    // and log so the next ensureDeployment can retry cleanly.
    child.once("error", (err) => {
      logger.error(
        `Embedded worker ${deploymentName} spawn error: ${err.message}`
      );
      this.workers.delete(deploymentName);
      // The worker never existed, so its recorded lease/fingerprint state is
      // stale the moment the entry goes. Leaving it would let the next create
      // for this name see a "known" fingerprint it was never built with.
      this.forgetDeploymentTooling(deploymentName);
      const lockRelease = releaseLockOnce();
      this.trackConversationLockRelease(deploymentName, lockRelease);
      // A spawn error is never a deliberate stop. Fail any in-flight turn(s)
      // for this deployment so the client gets a terminal error instead of a
      // hang. No-op if nothing is in flight (markers already discharged).
      // Fire-and-forget, but never silently: a rejection here means the
      // in-flight turn(s) were NOT failed and the client may hang until the
      // sweep backstop catches the lapsed marker — log it loudly.
      this.intentionalExits.delete(deploymentName);
      failTurnsForDeployment(deploymentName, AgentErrorCode.WORKER_DIED).catch(
        (failErr) => {
          logger.error(
            `Failed to fail in-flight turns after spawn error for ${deploymentName} (client may hang until the turn-liveness sweep): ${getErrorMessage(failErr)}`
          );
        }
      );
    });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().trimEnd().split("\n")) {
        logger.info({ worker: deploymentName }, line);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      // Keep a small tail only for a systemd-wrapped spawn, so the exit
      // handler can classify an instant `--scope` setup failure.
      if (systemdWrapped) {
        recentStderr = (recentStderr + text).slice(-4096);
      }
      for (const line of text.trimEnd().split("\n")) {
        logger.warn({ worker: deploymentName }, line);
      }
    });

    child.once("exit", (code, signal) => {
      // Always drop the map entry. The killWorker path may have already done
      // so (to short-circuit duplicate deletes), but consuming the
      // intentional-exit flag here is the single authoritative point — codex
      // P1#3. Read it before the self-heal branch so a deliberate kill never
      // resurrects the worker.
      this.workers.delete(deploymentName);
      const wasIntentional = this.intentionalExits.delete(deploymentName);

      // Self-heal: a systemd-wrapped worker that died ~instantly with a bus /
      // scope-setup signature means the user manager went away after the boot
      // probe. Demote systemd for the rest of this process and re-spawn the
      // worker unwrapped, REUSING the still-held conversation lock (do NOT
      // release it — a sibling pod must not claim the turn between attempts).
      if (
        !wasIntentional &&
        systemdWrapped &&
        code === 1 &&
        Date.now() - spawnStart < SYSTEMD_FAST_FAIL_MS &&
        SYSTEMD_SETUP_ERROR_RE.test(recentStderr)
      ) {
        const firstLine =
          recentStderr.trim().split("\n")[0] ?? "systemd setup error";
        logger.warn(
          `systemd-run scope for ${deploymentName} failed to start (${firstLine}); demoting systemd for this session and re-spawning the worker unsandboxed.`
        );
        cachedSystemdRun = null;
        // No reap needed: a `--scope` that can't reach the bus exits before
        // creating the scope or the worker, so there is no half-started unit
        // or process group to clean up. Re-spawn unwrapped, reusing the lock.
        this.spawnWorkerChild({
          ...params,
          allowSystemd: false,
          isRetry: true,
        });
        return;
      }

      // Past the self-heal branch the worker is gone for good, so drop its
      // lease/fingerprint state here — the single authoritative point, same as
      // the intentional-exit flag above. deleteDeployment() already clears it,
      // but a crash and an idle scale-to-0 (which calls killWorker directly)
      // do not, and a stale expiry would arm a recycle for a worker that no
      // longer exists. Safe against a rebuild: killWorker awaits the child's
      // exit, and this runs synchronously after workers.delete().
      this.forgetDeploymentTooling(deploymentName);
      const lockRelease = releaseLockOnce();
      this.trackConversationLockRelease(deploymentName, lockRelease);
      if (signal) {
        logger.info(
          `Embedded worker ${deploymentName} exited with signal ${signal}`
        );
      } else if (code !== 0) {
        logger.error(
          `Embedded worker ${deploymentName} exited with code ${code}`
        );
      } else {
        logger.info(`Embedded worker ${deploymentName} exited cleanly`);
      }
      // Any exit that wasn't a deliberate teardown fails the deployment's
      // in-flight turn(s) — gating on exit code is wrong: a clean `exit 0` that
      // leaves a turn un-answered is still a failure (GPT-5.5 edge #3). The
      // marker's presence is the source of truth, so this is a no-op when the
      // worker had already replied (markers discharged) or was idle.
      // Fire-and-forget with a logging .catch — same rationale as the spawn
      // error handler above.
      if (!wasIntentional) {
        failTurnsForDeployment(deploymentName, AgentErrorCode.WORKER_DIED).catch(
          (failErr) => {
            logger.error(
              `Failed to fail in-flight turns after unexpected exit of ${deploymentName} (client may hang until the turn-liveness sweep): ${getErrorMessage(failErr)}`
            );
          }
        );
      }
    });

    this.workers.set(deploymentName, {
      process: child,
      env: commonEnvVars,
      lastActivity: new Date(),
      workspaceDir,
      // Expose the idempotent release on the entry for introspection /
      // tests. The exit handler is the authoritative release site;
      // killWorker no longer touches this field.
      ...(convLock ? { releaseConvLock: releaseLockOnce } : {}),
    });

    logger.info(
      `Started embedded worker subprocess for ${deploymentName} (pid=${child.pid})`
    );
  }

  async scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void> {
    const entry = this.workers.get(deploymentName);

    if (replicas === 0 && entry) {
      await this.killWorker(entry, deploymentName);
      logger.info(`Stopped embedded worker ${deploymentName}`);
    } else if (replicas === 1 && !entry) {
      // The worker process is gone (crashed, or exited between a stale
      // listDeployments() snapshot and this call). Throwing here lets the
      // MessageConsumer's catch path re-create the deployment so the message
      // already queued for it actually gets drained — silently no-op'ing would
      // strand that message forever (no worker, no error, no retry).
      throw new Error(
        `Embedded worker ${deploymentName} is not running — must re-create`
      );
    }
  }

  async deleteDeployment(deploymentName: string): Promise<void> {
    this.forgetDeploymentTooling(deploymentName);
    const entry = this.workers.get(deploymentName);
    if (entry) {
      await this.killWorker(entry, deploymentName);
      await this.conversationLockReleases.get(deploymentName);
      logger.info(`Stopped embedded worker: ${deploymentName}`);
    }
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    const now = Date.now();
    const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;
    const veryOldDays = this.config.cleanup?.veryOldDays ?? 7;

    const results: DeploymentInfo[] = [];
    for (const [deploymentName, entry] of this.workers) {
      results.push(
        buildDeploymentInfoSummary({
          deploymentName,
          lastActivity: entry.lastActivity,
          now,
          idleThresholdMinutes,
          veryOldDays,
          replicas: 1,
        })
      );
    }
    return results;
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    const entry = this.workers.get(deploymentName);
    if (entry) {
      entry.lastActivity = new Date();
    }
  }

  /** Send SIGTERM, then SIGKILL after timeout. Resolves on child exit.
   *
   * Does NOT release the conversation lock — the child's exit handler is
   * the authoritative release site, and the release call there is
   * idempotent. Releasing here before `await exited` (as a prior version
   * did) lets a sibling pod claim the conversation while this worker is
   * still flushing its cleanup() snapshot. Codex P1#3 on PR #865.
   */
  private async killWorker(
    entry: EmbeddedWorkerEntry,
    deploymentName: string
  ): Promise<void> {
    const child = entry.process;

    // Mark this as a deliberate teardown so the spawnDeployment exit handler
    // does NOT surface it to the user as a worker crash. The exit handler
    // consumes (deletes) the flag.
    this.intentionalExits.add(deploymentName);

    // Delete from the map up front so callers see an empty
    // listDeployments() the moment kill returns — the public contract
    // hasn't changed. The lock release is deliberately NOT touched here
    // (codex P1#3): the exit handler in spawnDeployment is the
    // authoritative release site, and the release helper is idempotent
    // so a duplicate `workers.delete()` is harmless.
    this.workers.delete(deploymentName);

    // Already exited — `exitCode`/`signalCode` are the only reliable
    // indicators here. `child.killed` is set the moment we *send* a signal,
    // so checking it would mis-treat "we just sent SIGTERM" as "already
    // exited" and skip the SIGKILL escalation below.
    if (child.exitCode !== null || child.signalCode !== null) {
      // It exited on its own before we asked — the exit handler already ran
      // (and, since the flag wasn't set then, correctly treated it as a crash
      // and failed any in-flight turns). Drop the flag we just added so it
      // can't suppress a future exit for a re-used deployment name.
      this.intentionalExits.delete(deploymentName);
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    // A false return means we couldn't deliver the signal at all (no pid, or
    // both the group send and the child.kill fallback threw). Surface it — the
    // old child.kill() would have thrown, so silence here would otherwise hide
    // a worker we failed to stop. (process.kill itself returns void on success,
    // so a true return is not proof of reaping — see signalWorkerGroup.)
    if (!signalWorkerGroup(child, "SIGTERM")) {
      logger.warn(
        `Embedded worker ${deploymentName} (pid=${child.pid}) could not be signalled with SIGTERM`
      );
    }

    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(
          `Embedded worker ${deploymentName} did not exit after SIGTERM, sending SIGKILL`
        );
        if (!signalWorkerGroup(child, "SIGKILL")) {
          logger.warn(
            `Embedded worker ${deploymentName} (pid=${child.pid}) could not be signalled with SIGKILL`
          );
        }
      }
    }, intervals.workerKillTimeoutMs);

    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  }
}
