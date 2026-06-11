import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createLogger,
  ErrorCode,
  type MessagePayload,
  OrchestratorError,
} from "@lobu/core";
import { getDb } from "../../../db/client.js";
import type { ModelProviderModule } from "../../modules/module-system.js";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
  type ModuleEnvVarsBuilder,
  type OrchestratorConfig,
} from "../base-deployment-manager.js";
import { buildDeploymentInfoSummary } from "../deployment-utils.js";
import { failTurnsForDeployment } from "../turn-liveness.js";

/** Surfaced to the client when a worker dies before producing a reply. */
const WORKER_DIED_MESSAGE =
  "The worker handling your request stopped unexpectedly before it could reply. Please retry in a moment.";

const logger = createLogger("orchestrator");

/** Timeout (ms) to wait for graceful shutdown before SIGKILL. */
const KILL_TIMEOUT_MS = 5_000;

/**
 * Detect once whether `systemd-run --user` is available. On Linux production
 * hosts this lets us spawn each worker as a transient systemd unit with
 * cgroup limits + IPAddressDeny + capability drops. macOS dev hosts and
 * Linux hosts without user systemd fall back to plain `child_process.spawn`.
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
    // Probe by dispatching a real transient unit: `--version` only prints the
    // package version and does not exercise dbus. Some Linux hosts ship the
    // binary with no user manager attached; we have to exercise the
    // user-bus path that the worker spawn will later use, or workers fail
    // at first request instead of falling back to plain spawn here.
    //
    //   --no-block  → return as soon as the request is queued (no waiting on
    //                 the dispatched command); still requires a reachable bus
    //   --collect   → auto-remove the transient unit when it exits, so the
    //                 probe leaves no residue in the user manager
    //   timeout     → guard against a hung dbus connection (rare, but cheap)
    execFileSync(
      "systemd-run",
      ["--user", "--quiet", "--collect", "--no-block", "/bin/true"],
      { stdio: "ignore", timeout: 3_000 }
    );
    cachedSystemdRun = "systemd-run";
  } catch {
    cachedSystemdRun = null;
  }
  return cachedSystemdRun;
}

/**
 * Build the systemd-run argv prefix for a hardened transient scope. Defaults
 * are tuned for a single Lobu worker; operators can override via
 * LOBU_WORKER_MEMORY_MAX / LOBU_WORKER_CPU_QUOTA / LOBU_WORKER_TASKS_MAX.
 */
function buildSystemdRunArgs(opts: {
  unitName: string;
  workspaceDir: string;
}): string[] {
  const memMax = process.env.LOBU_WORKER_MEMORY_MAX || "512M";
  const cpuQuota = process.env.LOBU_WORKER_CPU_QUOTA || "200%";
  const tasksMax = process.env.LOBU_WORKER_TASKS_MAX || "64";
  const fileMax = process.env.LOBU_WORKER_LIMIT_NOFILE || "1024";
  return [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${opts.unitName}`,
    "-p",
    "NoNewPrivileges=yes",
    "-p",
    "PrivateTmp=yes",
    "-p",
    "ProtectSystem=strict",
    "-p",
    "ProtectHome=yes",
    "-p",
    `ReadWritePaths=${opts.workspaceDir}`,
    "-p",
    `MemoryMax=${memMax}`,
    "-p",
    `CPUQuota=${cpuQuota}`,
    "-p",
    `TasksMax=${tasksMax}`,
    "-p",
    `LimitNOFILE=${fileMax}`,
    "-p",
    "IPAddressDeny=any",
    "-p",
    "IPAddressAllow=127.0.0.1",
    "-p",
    "IPAddressAllow=::1",
    "-p",
    "CapabilityBoundingSet=",
    "-p",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
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
      // Retry the unlock query up to 3× with linear-ish backoff. A
      // transient DB hiccup mid-release would otherwise leave the
      // conversation locked until the gateway recycles — every
      // subsequent dispatch for that conv would `pg_try_advisory_lock`
      // → false → DEPLOYMENT_CREATE_FAILED → runs-queue retry → repeat.
      // Codex round 2 quality win E on PR #865.
      const MAX_ATTEMPTS = 3;
      const BACKOFF_MS = 100;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await reserved`SELECT pg_advisory_unlock(${CONV_LOCK_KEY1}, ${key2})`;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
          }
        }
      }
      if (lastErr) {
        // Log loudly so an operator notices — a stuck lock blocks every
        // subsequent dispatch for the conversation. Includes the lock
        // key triple so the operator can target a manual
        // pg_advisory_unlock from psql if needed.
        logger.error(
          `Failed to release advisory lock after ${MAX_ATTEMPTS} attempts for ${organizationId}/${agentId}/${conversationId}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
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
  const ext = path.extname(entryPoint);
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    return { command: getNodeExecutable(), args: [entryPoint] };
  }

  return { command: getBunExecutable(), args: ["run", entryPoint] };
}

function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

/**
 * Nix attribute namespaces that hold per-language package sets. A skill may
 * reference a leaf inside one of these (e.g. `python3Packages.requests`); both
 * the namespace and the leaf are validated and the result is re-emitted as an
 * explicit `pkgs.<...>` reference — the raw string is never handed to nix.
 */
const NIX_PACKAGE_NAMESPACES = new Set([
  "python3Packages",
  "python311Packages",
  "python312Packages",
  "nodePackages",
  "perlPackages",
  "rubyPackages",
  "haskellPackages",
  "rPackages",
  "ocamlPackages",
  "luaPackages",
]);

const NIX_LEAF_RE = /^[a-z0-9_][a-z0-9_-]*$/;
const NIX_ATTR_LEAF_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/**
 * Validate a skill-declared Nix package name and return a safe Nix attribute
 * reference (`pkgs.<name>`). `nix-shell -p` evaluates each argument as a Nix
 * *expression*, so a bare string like `pkgs.fetchurl; builtins.exec ...` or
 * `import ./evil.nix` would run code at evaluation time. We never forward the
 * raw string: it must be a strict leaf identifier (`^[a-z0-9_][a-z0-9_-]*$`) or a
 * `<known-namespace>.<leaf>` attr path, and it is re-emitted as an explicit
 * `pkgs.<...>` attribute reference.
 */
export function nixPackageAttrRef(pkg: string): string {
  // Defence in depth: reject obvious shell/Nix metacharacters up front.
  if (/[\s;&|`$(){}<>'"\\!*?#]/.test(pkg)) {
    throw new OrchestratorError(
      ErrorCode.DEPLOYMENT_CREATE_FAILED,
      `Invalid nix package name: ${pkg}`
    );
  }
  const dot = pkg.indexOf(".");
  if (dot === -1) {
    if (!NIX_LEAF_RE.test(pkg)) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Invalid nix package name: ${pkg}`
      );
    }
    return `pkgs.${pkg}`;
  }
  const namespace = pkg.slice(0, dot);
  const leaf = pkg.slice(dot + 1);
  if (
    !NIX_PACKAGE_NAMESPACES.has(namespace) ||
    leaf.includes(".") ||
    !NIX_ATTR_LEAF_RE.test(leaf)
  ) {
    throw new OrchestratorError(
      ErrorCode.DEPLOYMENT_CREATE_FAILED,
      `Invalid nix package name: ${pkg}`
    );
  }
  return `pkgs.${namespace}.${leaf}`;
}

export class EmbeddedDeploymentManager extends BaseDeploymentManager {
  private workers: Map<string, EmbeddedWorkerEntry> = new Map();
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
    super(config, moduleEnvVarsBuilder, providerModules);
  }

  protected getDispatcherHost(): string {
    // Match the systemd-run scope's IPAddressAllow=127.0.0.1 — IPv6 ::1
    // resolution would be blocked under the hardened scope.
    return "127.0.0.1";
  }

  /**
   * Embedded gateway is served by `@lobu/server` at the `/lobu`
   * mount on the configured PORT (default 8787). Without overriding here,
   * `BaseDeploymentManager` would hand workers the standalone gateway default
   * port with no mount prefix, so the worker would 404 on every dispatch and
   * provider-proxy call.
   */
  protected getDispatcherUrl(): string {
    const port = process.env.PORT || process.env.GATEWAY_PORT || "8787";
    return `http://${this.getDispatcherHost()}:${port}/lobu`;
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
    // process orchestrator to enforce uniqueness. The base class's in-flight
    // cache catches concurrent calls; this guards the rare case where a
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
    // another pod has the lock we surface a re-queueable failure so the
    // runs queue retries on a different pod or after the current holder
    // releases.
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
          `Failed to acquire conversation lock: ${err instanceof Error ? err.message : String(err)}`
        );
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          "Could not acquire per-conversation lock"
        );
      }
      if (!convLock) {
        // Another pod is running this conversation. Surface as a
        // re-queueable failure — the runs queue's standard retry path
        // re-delivers with a delay (`retry_delay_seconds` set per
        // run_type). No need to special-case here.
        logger.info(
          `Conversation lock busy for ${organizationId}/${agentId}/${conversationId}; deferring spawn`
        );
        throw new OrchestratorError(
          ErrorCode.DEPLOYMENT_CREATE_FAILED,
          "Conversation lock busy on another pod"
        );
      }
    }

    // Ownership of `convLock` transfers from this local scope to the
    // child's exit handler closure ONLY after `spawn()` returns and the
    // exit handler is wired. Until then, any throw in the spawn-prep
    // block must release the lock (and the underlying reserved pg
    // connection) to avoid leaking a per-conversation lock until the
    // gateway recycles. Codex P1#2 on PR #865.
    let child: ChildProcess;
    let commonEnvVars: Record<string, string>;
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

      let command: string;
      let spawnArgs: string[];

      if (nixPackages.length > 0) {
        // `nix-shell -p <arg>` evaluates each <arg> as a Nix *expression*, so a
        // bare package string like `pkgs.fetchurl; builtins.exec …` or
        // `import ./evil.nix` would run code at evaluation time. Never forward
        // the raw skill string: validate it to a strict leaf (or known
        // `<namespace>.<leaf>`) identifier and re-emit an explicit `pkgs.<name>`
        // attribute reference instead.
        const packageRefs = nixPackages.map(nixPackageAttrRef);
        // Wrap in nix-shell so nix binaries are on PATH. `-E` takes a single
        // expression that resolves to the build inputs; `pkgs` is bound to the
        // nixpkgs set via a `let` and every ref was validated above.
        command = "nix-shell";
        spawnArgs = [
          "-E",
          `let pkgs = import <nixpkgs> {}; in pkgs.mkShell { buildInputs = [ ${packageRefs.join(" ")} ]; }`,
          "--run",
          buildShellCommand(workerInvocation.command, workerInvocation.args),
        ];
        logger.info(
          `Spawning embedded worker ${deploymentName} with nix packages: ${nixPackages.join(", ")}`
        );
      } else {
        command = workerInvocation.command;
        spawnArgs = workerInvocation.args;
      }

      // On Linux production hosts, wrap the worker in a transient systemd
      // user scope: cgroup limits + IPAddressDeny + capability drops. Falls
      // back transparently on macOS / Linux hosts without user systemd.
      const systemdRun = locateSystemdRun();
      if (systemdRun) {
        const unitName = makeUnitName(deploymentName);
        const innerCommand = command;
        const innerArgs = spawnArgs;
        command = systemdRun;
        spawnArgs = [
          ...buildSystemdRunArgs({ unitName, workspaceDir }),
          "--",
          innerCommand,
          ...innerArgs,
        ];
        logger.info(
          `Spawning embedded worker ${deploymentName} under systemd-run scope ${unitName}`
        );
      }

      child = spawn(command, spawnArgs, {
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
      });
    } catch (err) {
      // Pre-spawn throw (generateEnvironmentVariables, nix package
      // validation, getWorkerEntryPoint, synchronous spawn() failure).
      // No child process exists, so no exit handler will fire to release
      // the lock — release it here before re-throwing.
      if (convLock) {
        void convLock.release();
      }
      throw err;
    }

    // Idempotent lock release. Captured by both the error and exit
    // handlers below; killWorker no longer touches the lock directly so
    // the lock survives until the child actually exits (codex P1#3 on
    // PR #865 — the prior killWorker released BEFORE SIGTERM, letting a
    // sibling pod claim the conversation while the dying worker was
    // still flushing its snapshot).
    let lockReleased = false;
    const releaseLockOnce = async (): Promise<void> => {
      if (lockReleased) return;
      lockReleased = true;
      if (convLock) {
        await convLock.release();
      }
    };

    // Spawn errors (binary missing, EACCES, fork failure) fire on the child
    // *after* spawn() returns, so without an "error" listener Node would
    // throw an unhandled exception and crash the gateway. Drop the entry
    // and log so the next ensureDeployment can retry cleanly.
    child.once("error", (err) => {
      logger.error(
        `Embedded worker ${deploymentName} spawn error: ${err.message}`
      );
      this.workers.delete(deploymentName);
      releaseLockOnce();
      // A spawn error is never a deliberate stop. Fail any in-flight turn(s)
      // for this deployment so the client gets a terminal error instead of a
      // hang. No-op if nothing is in flight (markers already discharged).
      this.intentionalExits.delete(deploymentName);
      void failTurnsForDeployment(deploymentName, WORKER_DIED_MESSAGE);
    });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().trimEnd().split("\n")) {
        logger.info({ worker: deploymentName }, line);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().trimEnd().split("\n")) {
        logger.warn({ worker: deploymentName }, line);
      }
    });

    child.once("exit", (code, signal) => {
      // Always release the lock here. The killWorker path may have
      // already deleted the map entry (to short-circuit duplicate
      // deletes), but the lock release is gated on its own idempotency
      // flag and is the authoritative release point — codex P1#3.
      this.workers.delete(deploymentName);
      releaseLockOnce();
      // `delete` returns true iff killWorker marked this exit as deliberate.
      // Consume the flag here (the exit is the single authoritative point).
      const wasIntentional = this.intentionalExits.delete(deploymentName);
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
      // in-flight turn(s) — gated on exit code is wrong: a clean `exit 0` that
      // leaves a turn un-answered is still a failure (GPT-5.5 edge #3). The
      // marker's presence is the source of truth, so this is a no-op when the
      // worker had already replied (markers discharged) or was idle.
      if (!wasIntentional) {
        void failTurnsForDeployment(deploymentName, WORKER_DIED_MESSAGE);
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
    const entry = this.workers.get(deploymentName);
    if (entry) {
      await this.killWorker(entry, deploymentName);
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

    child.kill("SIGTERM");

    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(
          `Embedded worker ${deploymentName} did not exit after SIGTERM, sending SIGKILL`
        );
        child.kill("SIGKILL");
      }
    }, KILL_TIMEOUT_MS);

    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  }
}
