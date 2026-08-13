import { type ChildProcess, execFileSync } from "node:child_process";

/**
 * A `systemd-run --scope` that can't reach the user bus / start the scope
 * fails almost instantly — before the worker payload runs. We only treat an
 * exit as a systemd setup failure (vs. a genuine fast worker crash) when it
 * lands inside this window AND matches SYSTEMD_SETUP_ERROR_RE, so a real
 * worker bug is never masked as "fall back to plain spawn".
 */
export const SYSTEMD_FAST_FAIL_MS = 2_000;

/**
 * stderr signatures emitted by `systemd-run` itself (not the worker) when the
 * user manager / dbus / scope setup is the problem (bus unreachable, or a
 * property the host's systemd rejects on a scope). Kept tight on purpose so a
 * genuine fast worker crash is never misread as a systemd failure.
 */
export const SYSTEMD_SETUP_ERROR_RE =
  /Failed to connect to bus|No medium found|Failed to (start|create) (transient )?(scope|unit)|Unknown assignment|Interactive authentication required|Access denied|Transport endpoint is not connected/i;

/**
 * Whether the operator REQUIRES the systemd worker sandbox. Default false:
 * workers run unwrapped when no usable `systemd-run --user` manager exists
 * (matching the prod container, which ships no systemd-run; the egress proxy is
 * the network boundary). A hardened deployment that has provisioned a user
 * systemd manager can set LOBU_REQUIRE_WORKER_SANDBOX=1 to fail closed instead
 * of silently running unwrapped. Re-read each call (cold path).
 */
export function workerSandboxRequired(): boolean {
  return process.env.LOBU_REQUIRE_WORKER_SANDBOX === "1";
}

/** One-shot guard so the "running unsandboxed" notice logs once per process. */
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
export function locateSystemdRun(): string | null {
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
 * Detect once whether `nix-shell` is available. Agents declare native deps via
 * `nixConfig.packages`; connectors declare theirs via `agentTooling.nix.packages`,
 * which we fold into `nixConfig.packages` when resolving the deployment. Either
 * way we normally provision the resulting set by wrapping the worker in
 * `nix-shell -p …`. Containers/hosts without Nix (e.g. the prod app
 * image, which bakes Chromium in directly rather than via Nix) won't have it,
 * so we fall back to a plain spawn — mirroring `locateSystemdRun`'s graceful
 * degradation — instead of crashing the worker with `spawn nix-shell ENOENT`.
 * The declared packages are simply unavailable in that turn unless the image
 * already provides them; a turn that doesn't use them runs fine.
 */
let cachedNixShell: string | null | undefined;
export function locateNixShell(): string | null {
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

export function disableSystemdRunForSession(): void {
  cachedSystemdRun = null;
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
export function buildSystemdRunArgs(opts: { unitName: string }): string[] {
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

export function makeUnitName(deploymentName: string): string {
  // systemd unit names allow only [A-Za-z0-9:_.\\-]; sanitize and add a
  // short random tag so concurrent workers don't collide if a prior unit
  // is still being torn down.
  const safe = deploymentName.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  const tag = Math.random().toString(36).slice(2, 8);
  return `lobu-worker-${safe}-${tag}`;
}
