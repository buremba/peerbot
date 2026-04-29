/**
 * Per-exec sandbox for embedded just-bash custom commands.
 *
 * just-bash's interpreter and `ReadWriteFs` already root file ops in the
 * thread workspace, but spawned binaries (gh, git, owletto, anything from
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
 * Override with OWLETTO_EXEC_SANDBOX={auto,bwrap,sandbox-exec,off}. Explicit
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

export interface SandboxWrapOptions {
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
  return `${process.platform}|${process.env.OWLETTO_EXEC_SANDBOX ?? ""}`;
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
  const v = process.env.OWLETTO_EXEC_SANDBOX?.toLowerCase();
  if (!v || v === "auto") return null;
  if (v === "off" || v === "none") return "none";
  if (v === "bwrap" || v === "sandbox-exec") return v;
  console.warn(
    `[exec-sandbox] Unknown OWLETTO_EXEC_SANDBOX=${v}, falling back to auto.`
  );
  return null;
}

/**
 * Run bwrap with the same unshare flags we use in production but against
 * `/bin/true`. If user namespaces aren't available (kernel disabled, seccomp
 * profile blocking `unshare(CLONE_NEWUSER)`), this fails — and we should
 * surface it rather than silently degrade to "no sandbox".
 */
function bwrapDeliversIsolation(bwrapPath: string): boolean {
  try {
    execFileSync(
      bwrapPath,
      [
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
      ],
      { stdio: "ignore", timeout: 3000 }
    );
    return true;
  } catch {
    return false;
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
        `[exec-sandbox] OWLETTO_EXEC_SANDBOX=sandbox-exec but ${p} not found.`
      );
    }
    if (override === "bwrap") {
      const p = which("bwrap");
      if (p && fs.existsSync(p) && bwrapDeliversIsolation(p)) {
        return setCache(key, { kind: "bwrap", path: p });
      }
      throw new Error(
        `[exec-sandbox] OWLETTO_EXEC_SANDBOX=bwrap but bubblewrap is unavailable ` +
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
    console.warn(
      `[exec-sandbox] No sandbox available on platform=${process.platform}. ` +
        `Spawned binaries will run with host privileges. ` +
        `Install bubblewrap (Linux) or check sandbox-exec (macOS).`
    );
  }
  return setCache(key, { kind: "none" });
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
