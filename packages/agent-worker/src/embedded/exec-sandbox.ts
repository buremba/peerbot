/**
 * Per-exec sandbox for embedded just-bash custom commands.
 *
 * just-bash's interpreter and `ReadWriteFs` already root file ops in the
 * thread workspace, but spawned binaries (gh, git, lobu, anything from
 * /nix/store) bypass that — once execFile fires, the child has the host's
 * full FS view. This module wraps every spawn in an OS sandbox so the child
 * sees only the workspace + ro system paths.
 *
 * Strategies:
 *   - "sandbox-exec" (macOS) — allow-default profile with denies for personal
 *     data paths (~/.ssh, ~/.aws, /etc, /Users, keychains, etc.) and writes
 *     restricted to the workspace.
 *   - "bwrap" (Linux) — true deny-default via bind mounts; only the workspace
 *     and ro system paths are visible. Probed at startup with a real spawn
 *     because `--unshare-user` requires `kernel.unprivileged_userns_clone=1`.
 *   - "none" — no sandbox available; commands run with host privileges. A
 *     warning is logged once at probe time.
 *
 * Override with LOBU_EXEC_SANDBOX={auto,bwrap,sandbox-exec,off}. Explicit
 * overrides fail closed: requesting `bwrap` on a host without bubblewrap is a
 * hard error, not a silent fallback to "none".
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type SandboxKind = "sandbox-exec" | "bwrap" | "none";

export interface SandboxStrategy {
  kind: SandboxKind;
  /** Absolute path to the wrapper binary. Absent for "none". */
  path?: string;
}

interface SandboxWrapOptions {
  /** Workspace dir on the host FS. Wrapped child gets rw access here only. */
  workspaceDir: string;
  /**
   * If false, the child cannot reach the network. just-bash's domain allowlist
   * still applies inside the interpreter; this controls whether spawned
   * binaries can open sockets at all. Set true when the gateway HTTP proxy is
   * the egress path (binaries respect HTTP_PROXY).
   */
  allowNet?: boolean;
  /** Absolute cwd inside the bwrap namespace. Must be /workspace or below. */
  bwrapCwd?: string;
}

/** Workspace path is interpolated into SBPL/argv unescaped. Reject anything
 * that could break out of the SBPL string literal, inject extra rules, or
 * paper over a non-canonical path. Callers must canonicalize first. */
const WORKSPACE_DIR_SAFE = /^\/[A-Za-z0-9._\-/+@:]+$/;

interface CacheEntry {
  key: string;
  strategy: SandboxStrategy;
}
let cached: CacheEntry | null = null;
let warnedNoSandbox = false;

function cacheKey(): string {
  return `${process.platform}|${process.env.LOBU_EXEC_SANDBOX ?? ""}`;
}

function which(bin: string): string | null {
  try {
    return (
      execFileSync("/usr/bin/which", [bin], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function envOverride(): SandboxKind | null {
  const v = process.env.LOBU_EXEC_SANDBOX?.toLowerCase();
  if (!v || v === "auto") return null;
  if (v === "off" || v === "none") return "none";
  if (v === "bwrap" || v === "sandbox-exec") return v;
  console.warn(
    `[exec-sandbox] Unknown LOBU_EXEC_SANDBOX=${v}, falling back to auto.`
  );
  return null;
}

/**
 * What the bwrap isolation probe observed. The reason is kept rather than
 * collapsed to a boolean because "bubblewrap is not installed" and "bubblewrap
 * is installed but the kernel/seccomp policy refuses unshare(CLONE_NEWUSER)"
 * call for opposite responses, and only the first is fixable by installing
 * anything. On the managed cluster it is always the second — see
 * charts/lobu/values.yaml, which records that no securityContext change can
 * enable it because uid_map is runtime-restricted — so telling an operator to
 * "install bubblewrap" there sends them after a package that is already
 * present and would not help if it weren't.
 */
type BwrapProbe =
  | { isolated: true }
  | { isolated: false; reason: "not_found" }
  | { isolated: false; reason: "unshare_denied"; detail: string };

/**
 * Shared by the boolean predicate and the reporting probe so the two can never
 * answer about different flag sets — a drift that would make the diagnostic
 * describe a probe the selection path never ran.
 */
const BWRAP_ISOLATION_PROBE_ARGS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-net",
  "--ro-bind",
  "/usr",
  "/usr",
  "--ro-bind-try",
  "/lib",
  "/lib",
  "--ro-bind-try",
  "/lib64",
  "/lib64",
  "--ro-bind-try",
  "/bin",
  "/bin",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--",
  "/usr/bin/true",
];

/**
 * Run bwrap with the same unshare flags we use in production but against
 * `/bin/true`. If user namespaces aren't available (kernel disabled, seccomp
 * profile blocking `unshare(CLONE_NEWUSER)`), this fails — and we should
 * surface it rather than silently degrade to "no sandbox".
 */
function bwrapDeliversIsolation(bwrapPath: string): boolean {
  try {
    execFileSync(bwrapPath, BWRAP_ISOLATION_PROBE_ARGS, {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Same probe, but keeps what it learned. `probeBwrap` is what the reporting
 * path uses; `bwrapDeliversIsolation` stays as the boolean predicate the
 * strategy selection already reads, so selection behaviour is untouched.
 */
function probeBwrap(): BwrapProbe {
  const bwrapPath = which("bwrap");
  if (!bwrapPath || !fs.existsSync(bwrapPath)) {
    return { isolated: false, reason: "not_found" };
  }
  try {
    execFileSync(bwrapPath, BWRAP_ISOLATION_PROBE_ARGS, {
      stdio: "pipe",
      timeout: 3000,
    });
    return { isolated: true };
  } catch (err) {
    // The stderr of a refused unshare is the actionable part ("No permissions
    // to creating new namespace", "setting up uid map: Permission denied").
    // Swallowing it is what left operators with a bare exit 127 and a warning
    // that named the wrong cause.
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    const detail = (stderr.trim() || e.message || "unknown error")
      .split("\n")
      .slice(0, 2)
      .join(" ")
      .slice(0, 300);
    return { isolated: false, reason: "unshare_denied", detail };
  }
}

function setCache(key: string, strategy: SandboxStrategy): SandboxStrategy {
  cached = { key, strategy };
  return strategy;
}

export function probeSandboxStrategy(): SandboxStrategy {
  const key = cacheKey();
  if (cached && cached.key === key) return cached.strategy;

  const override = envOverride();

  if (override === "none") {
    return setCache(key, { kind: "none" });
  }

  // Explicit override: try only the requested backend, fail closed.
  if (override) {
    if (override === "sandbox-exec") {
      const p = which("sandbox-exec") ?? "/usr/bin/sandbox-exec";
      if (fs.existsSync(p)) {
        return setCache(key, { kind: "sandbox-exec", path: p });
      }
      throw new Error(
        `[exec-sandbox] LOBU_EXEC_SANDBOX=sandbox-exec but ${p} not found.`
      );
    }
    if (override === "bwrap") {
      const p = which("bwrap");
      if (p && fs.existsSync(p) && bwrapDeliversIsolation(p)) {
        return setCache(key, { kind: "bwrap", path: p });
      }
      throw new Error(
        `[exec-sandbox] LOBU_EXEC_SANDBOX=bwrap but bubblewrap is unavailable ` +
          `or user namespaces are blocked. Install bubblewrap and ensure ` +
          `kernel.unprivileged_userns_clone=1 (or seccomp profile permits unshare).`
      );
    }
  }

  // Auto-detect by platform.
  if (process.platform === "darwin") {
    const p = which("sandbox-exec") ?? "/usr/bin/sandbox-exec";
    if (fs.existsSync(p)) {
      return setCache(key, { kind: "sandbox-exec", path: p });
    }
  }

  if (process.platform === "linux") {
    const p = which("bwrap");
    if (p && fs.existsSync(p) && bwrapDeliversIsolation(p)) {
      return setCache(key, { kind: "bwrap", path: p });
    }
  }

  if (!warnedNoSandbox) {
    warnedNoSandbox = true;
    console.warn(`[exec-sandbox] ${describeNoSandbox()}`);
  }
  return setCache(key, { kind: "none" });
}

/**
 * Describe what the probe actually observed, rather than prescribing a remedy.
 *
 * The previous message said "Install bubblewrap (Linux) or check sandbox-exec
 * (macOS)" for every no-sandbox outcome. On the managed cluster that is wrong
 * twice: bubblewrap may already be installed, and installing it cannot help,
 * because the refusal is the runtime's uid_map restriction rather than a
 * missing package (charts/lobu/values.yaml records the measurement). An
 * operator who follows that advice loses time and still ends up with
 * contributed CLIs exiting 127 — which is the intended, documented behaviour
 * for that environment, not a fault to chase.
 *
 * So: report the platform, what was looked for, what was found, and the
 * kernel's own refusal text when there is one. The remedy is only stated in the
 * case where a remedy exists.
 */
export function describeNoSandbox(): string {
  if (process.platform === "darwin") {
    const p = which("sandbox-exec") ?? "/usr/bin/sandbox-exec";
    return formatNoSandboxReport(process.platform, {
      sandboxExec: { path: p, present: fs.existsSync(p) },
    });
  }
  if (process.platform !== "linux") {
    return formatNoSandboxReport(process.platform, {});
  }
  return formatNoSandboxReport(process.platform, { bwrap: probeBwrap() });
}

/**
 * Pure formatter: given observed facts, produce the report. Separated from the
 * gathering so every branch is reachable in a test on any host — otherwise the
 * Linux userns wording (the case that actually matters in production) could
 * only ever be asserted on a Linux CI box that also happens to block userns,
 * and would silently go uncovered everywhere else.
 */
export function formatNoSandboxReport(
  platform: string,
  observed: {
    sandboxExec?: { path: string; present: boolean };
    bwrap?: BwrapProbe;
  }
): string {
  const head = `No sandbox available on platform=${platform}; spawned binaries run with host privileges.`;

  if (observed.sandboxExec !== undefined) {
    const { path: execPath, present } = observed.sandboxExec;
    if (present) {
      // Reaching here means selection and reporting disagree; say so rather
      // than misreport a binary that exists as missing.
      return `${head} Inconsistent probe: sandbox-exec exists at ${execPath} but was not selected. Please report this — it indicates a bug in strategy selection, not a host misconfiguration.`;
    }
    return `${head} Probed sandbox-exec at ${execPath}: not present. Expected on stock macOS — a trimmed or non-standard image is the usual cause.`;
  }

  const probe = observed.bwrap;
  if (!probe) {
    return `${head} No sandbox backend is implemented for this platform (bwrap is Linux-only, sandbox-exec macOS-only).`;
  }

  if (probe.isolated) {
    // Reaching here means selection and reporting disagree; say so rather than
    // print a confident story about a state that shouldn't exist.
    return `${head} Inconsistent probe: bubblewrap reported working isolation on re-probe but was not selected. Please report this — it indicates a bug in strategy selection, not a host misconfiguration.`;
  }
  if (probe.reason === "not_found") {
    return `${head} bubblewrap (bwrap) was not found on PATH. Installing it enables the sandbox on hosts whose kernel permits unprivileged user namespaces.`;
  }
  return (
    `${head} bubblewrap is installed but could not create a user namespace: ${probe.detail}. ` +
    `This is a host/runtime policy (unprivileged userns or uid_map restricted), not a missing package — ` +
    `installing bubblewrap again will not change it. On the managed cluster this is the expected state and ` +
    `contributed CLIs are refused by design; see charts/lobu/values.yaml.`
  );
}

/** For tests: forget the cached strategy + warning state. */
export function resetSandboxProbeForTests(): void {
  cached = null;
  warnedNoSandbox = false;
}

function assertSafeWorkspacePath(workspaceDir: string): void {
  if (!WORKSPACE_DIR_SAFE.test(workspaceDir)) {
    throw new Error(
      `[exec-sandbox] workspaceDir ${JSON.stringify(workspaceDir)} contains ` +
        `unsafe characters; only [A-Za-z0-9._\\-/+@:] is allowed.`
    );
  }
  if (
    workspaceDir === "/" ||
    workspaceDir.includes("//") ||
    workspaceDir.split("/").includes("..") ||
    workspaceDir.endsWith("/")
  ) {
    throw new Error(
      `[exec-sandbox] workspaceDir ${JSON.stringify(workspaceDir)} is not a ` +
        `canonical absolute path. Pass realpathSync(dir) at boot.`
    );
  }
}

function assertSafeBwrapCwd(bwrapCwd: string): void {
  if (bwrapCwd !== "/workspace" && !bwrapCwd.startsWith("/workspace/")) {
    throw new Error(
      `[exec-sandbox] bwrap cwd ${JSON.stringify(bwrapCwd)} must be ` +
        `/workspace or below.`
    );
  }
  if (bwrapCwd.includes("\0") || bwrapCwd.split("/").includes("..")) {
    throw new Error(
      `[exec-sandbox] bwrap cwd ${JSON.stringify(bwrapCwd)} is unsafe.`
    );
  }
}

/**
 * SBPL profile for macOS. Allow-default with targeted denies for personal-data
 * paths and a write-island scoped to the workspace. Last-match-wins lets the
 * workspace allow override the broader `/Users` deny when workspaceDir is
 * under /Users (developer dev machine).
 */
function buildSandboxExecProfile(
  workspaceDir: string,
  opts: SandboxWrapOptions
): string {
  assertSafeWorkspacePath(workspaceDir);
  return `(version 1)
(allow default)

;; personal data + system config
(deny file-read*
  (subpath "/Users")
  (subpath "/etc")
  (subpath "/private/etc")
  (subpath "/var/log")
  (subpath "/private/var/log")
  (subpath "/var/run")
  (subpath "/private/var/run")
  (subpath "/Volumes")
  (subpath "/Library/Keychains")
  (subpath "/Library/Preferences")
  (subpath "/Library/Application Support")
  (subpath "/Library/Cookies")
  (subpath "/Library/Mail")
  (subpath "/Library/Messages")
  (subpath "/Library/Safari")
  (subpath "/private/tmp")
  (subpath "/tmp"))
(allow file-read* (subpath "${workspaceDir}"))

;; writes constrained to workspace
(deny file-write*)
(allow file-write* (subpath "${workspaceDir}"))

;; network
${opts.allowNet ? "(allow network*)" : "(deny network*)"}
`;
}

function buildBwrapArgs(
  workspaceDir: string,
  opts: SandboxWrapOptions
): string[] {
  assertSafeWorkspacePath(workspaceDir);
  const bwrapCwd = opts.bwrapCwd ?? "/workspace";
  assertSafeBwrapCwd(bwrapCwd);
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    ...(opts.allowNet ? ["--share-net"] : ["--unshare-net"]),
    "--bind",
    workspaceDir,
    "/workspace",
    "--chdir",
    bwrapCwd,
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/sbin",
    "/sbin",
    "--ro-bind-try",
    "/nix",
    "/nix",
    "--ro-bind-try",
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--ro-bind-try",
    "/etc/ssl",
    "/etc/ssl",
    "--ro-bind-try",
    "/etc/ca-certificates",
    "/etc/ca-certificates",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
}

/**
 * Wrap a `(command, args)` invocation with the active sandbox strategy.
 * Pass-through for `kind: "none"`. The returned shape is what should be handed
 * to `child_process.execFile`.
 */
export function wrapInvocation(
  strategy: SandboxStrategy,
  inner: { command: string; args: string[] },
  opts: SandboxWrapOptions
): { command: string; args: string[] } {
  if (strategy.kind === "none" || !strategy.path) return inner;

  if (strategy.kind === "sandbox-exec") {
    const profile = buildSandboxExecProfile(opts.workspaceDir, opts);
    return {
      command: strategy.path,
      args: ["-p", profile, inner.command, ...inner.args],
    };
  }

  if (strategy.kind === "bwrap") {
    return {
      command: strategy.path,
      args: [
        ...buildBwrapArgs(opts.workspaceDir, opts),
        "--",
        inner.command,
        ...inner.args,
      ],
    };
  }

  return inner;
}
