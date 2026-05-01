/**
 * Worker-side just-bash bootstrap for embedded deployment mode.
 *
 * Creates a just-bash Bash instance from environment variables and wraps it
 * as a BashOperations interface for pi-coding-agent's bash tool.
 *
 * When nix binaries are detected on PATH (via nix-shell wrapper from gateway)
 * or known CLI tools (e.g. owletto) are found, they are registered as
 * just-bash customCommands that delegate to real exec.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stripEnv } from "@lobu/core";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { SENSITIVE_WORKER_ENV_KEYS } from "../shared/worker-env-keys";
import type { GatewayParams } from "../shared/tool-implementations";
import {
  type SandboxStrategy,
  probeSandboxStrategy,
  wrapInvocation,
} from "./exec-sandbox";
import type { McpCliCommand, McpRuntimeRef } from "./mcp-cli-commands";
import { buildMcpCliCommands } from "./mcp-cli-commands";

const EMBEDDED_BASH_LIMITS = {
  maxCommandCount: 50_000,
  maxLoopIterations: 50_000,
  maxCallDepth: 50,
} as const;

export interface SandboxContext {
  strategy: SandboxStrategy;
  workspaceDir: string;
  /** Whether the spawned binary may open sockets. just-bash's domain allowlist
   * still gates the interpreter; this controls the OS network namespace. */
  allowNet?: boolean;
  /** Per-invocation cwd inside bwrap's /workspace namespace. */
  bwrapCwd?: string;
}

export function buildBinaryInvocation(
  binaryPath: string,
  args: string[],
  sandbox?: SandboxContext
): { command: string; args: string[] } {
  let inner: { command: string; args: string[] } = {
    command: binaryPath,
    args,
  };
  try {
    const firstLine =
      fs.readFileSync(binaryPath, "utf8").split("\n", 1)[0] || "";
    if (firstLine === "#!/usr/bin/env node" || firstLine.endsWith("/node")) {
      inner = { command: "node", args: [binaryPath, ...args] };
    }
  } catch {
    // Fall back to executing the binary directly.
  }

  if (!sandbox) return inner;
  return wrapInvocation(sandbox.strategy, inner, {
    workspaceDir: sandbox.workspaceDir,
    allowNet: sandbox.allowNet ?? true,
    bwrapCwd: sandbox.bwrapCwd,
  });
}

/**
 * Binaries that are full code-execution capabilities. If they land on the
 * just-bash allowlist, the depth/loop caps are moot — the agent can run
 * arbitrary code through them. They are excluded by default; an agent that
 * genuinely needs them must opt in via
 * `LOBU_ALLOW_UNSANDBOXED_EXEC=1` (set per-agent in lobu.toml).
 */
const UNSANDBOXED_INTERPRETERS = new Set<string>([
  "node",
  "nodejs",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "perl",
  "lua",
  "bash",
  "sh",
  "zsh",
  "fish",
  "ash",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "curl",
  "wget",
  "git",
  "ssh",
  "scp",
  "rsync",
  "nc",
  "ncat",
  "socat",
  "telnet",
  "nix",
  "nix-build",
  "nix-shell",
  "nix-env",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "poetry",
  "gem",
  "cargo",
  "go",
]);

/**
 * Discover binaries to register as custom commands:
 * 1. All executables from /nix/store/ PATH directories
 * 2. Known CLI tools (owletto) from anywhere on PATH
 *
 * UNSANDBOXED_INTERPRETERS are filtered out unless the spawned worker has
 * LOBU_ALLOW_UNSANDBOXED_EXEC=1 in its env (set explicitly per-agent for
 * cases that genuinely need a full interpreter).
 */
function discoverBinaries(): Map<string, string> {
  const binaries = new Map<string, string>();
  const pathDirs = (process.env.PATH || "").split(":");
  const allowUnsandboxed =
    process.env.LOBU_ALLOW_UNSANDBOXED_EXEC === "1" ||
    process.env.LOBU_ALLOW_UNSANDBOXED_EXEC === "true";

  const isAllowed = (name: string): boolean =>
    allowUnsandboxed || !UNSANDBOXED_INTERPRETERS.has(name);

  for (const dir of pathDirs) {
    if (!dir.includes("/nix/store/")) continue;
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!isAllowed(entry)) continue;
        const fullPath = path.join(dir, entry);
        try {
          fs.accessSync(fullPath, fs.constants.X_OK);
          if (!binaries.has(entry)) binaries.set(entry, fullPath);
        } catch {
          // not executable
        }
      }
    } catch {
      // directory not readable
    }
  }

  // Discover known CLI tools from full PATH
  for (const name of ["owletto"]) {
    if (binaries.has(name)) continue;
    if (!isAllowed(name)) continue;
    for (const dir of pathDirs) {
      const fullPath = path.join(dir, name);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        binaries.set(name, fullPath);
        break;
      } catch {
        // not found
      }
    }
  }

  return binaries;
}

/**
 * Resolve a just-bash virtual cwd to a real on-disk path. just-bash's
 * `CommandContext.cwd` is rooted at the `ReadWriteFs` root, but `child_process`
 * needs a host path. We realpath both sides and verify the resolved cwd stays
 * inside the workspace — defense in depth against a symlink that slipped past
 * `ReadWriteFs` (e.g. if `allowSymlinks` is ever enabled upstream).
 */
function resolveHostCwd(workspaceDir: string, virtualCwd: string): string {
  const trimmed = virtualCwd.startsWith("/") ? virtualCwd.slice(1) : virtualCwd;
  const candidate = trimmed ? path.join(workspaceDir, trimmed) : workspaceDir;
  let realCwd: string;
  let realWs: string;
  try {
    realCwd = fs.realpathSync(candidate);
    realWs = fs.realpathSync(workspaceDir);
  } catch {
    return workspaceDir;
  }
  if (realCwd !== realWs && !realCwd.startsWith(realWs + path.sep)) {
    throw new Error(
      `[embedded] cwd ${JSON.stringify(virtualCwd)} resolves outside workspace`
    );
  }
  return realCwd;
}

function ensureSandboxDir(workspaceDir: string, name: string): string {
  const dir = path.join(workspaceDir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; sandbox profile will surface real errors if it can't create
  }
  return dir;
}

function bwrapCwdForHostCwd(workspaceDir: string, hostCwd: string): string {
  const rel = path.relative(workspaceDir, hostCwd);
  if (!rel) return "/workspace";
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `[embedded] cwd ${JSON.stringify(hostCwd)} resolves outside workspace`
    );
  }
  return path.posix.join("/workspace", ...rel.split(path.sep));
}

/**
 * Create just-bash customCommands from a map of binary name → full path.
 * Each custom command delegates to the real binary via child_process.execFile,
 * wrapped in the active per-exec sandbox so spawned binaries cannot read
 * outside the workspace or write outside it.
 */
async function buildCustomCommands(
  binaries: Map<string, string>,
  sandbox: SandboxContext
): Promise<ReturnType<typeof import("just-bash").defineCommand>[]> {
  const { defineCommand } = await import("just-bash");
  const commands = [];

  for (const [name, binaryPath] of binaries) {
    commands.push(
      defineCommand(name, async (args: string[], ctx) => {
        const envRecord = stripEnv(process.env, SENSITIVE_WORKER_ENV_KEYS);
        if (ctx.env && typeof ctx.env.forEach === "function") {
          ctx.env.forEach((v: string, k: string) => {
            envRecord[k] = v;
          });
        } else if (ctx.env && typeof ctx.env === "object") {
          Object.assign(envRecord, ctx.env);
        }

        // Pin HOME / TMPDIR to dedicated subdirs so tool dotfiles (~/.gitconfig,
        // ~/.cache, ~/.config) and temp files don't collide with workspace
        // contents. Sandbox profiles already deny outside-workspace writes;
        // these keep agent-visible files clean.
        //
        // bwrap binds the host workspace at `/workspace` inside the namespace,
        // so the in-namespace HOME/TMPDIR must use the bound path. sandbox-exec
        // doesn't remap paths, so HOME/TMPDIR stay as host paths.
        ensureSandboxDir(sandbox.workspaceDir, ".sandbox-home");
        ensureSandboxDir(sandbox.workspaceDir, ".sandbox-tmp");
        if (sandbox.strategy.kind === "bwrap") {
          envRecord.HOME = "/workspace/.sandbox-home";
          envRecord.TMPDIR = "/workspace/.sandbox-tmp";
        } else {
          envRecord.HOME = path.join(sandbox.workspaceDir, ".sandbox-home");
          envRecord.TMPDIR = path.join(sandbox.workspaceDir, ".sandbox-tmp");
        }

        // Force gateway proxy env so a malicious agent can't override it via
        // `export HTTP_PROXY=` to bypass the egress allowlist. NO_PROXY is
        // stripped for the same reason.
        if (process.env.HTTP_PROXY)
          envRecord.HTTP_PROXY = process.env.HTTP_PROXY;
        if (process.env.HTTPS_PROXY)
          envRecord.HTTPS_PROXY = process.env.HTTPS_PROXY;
        if (process.env.http_proxy)
          envRecord.http_proxy = process.env.http_proxy;
        if (process.env.https_proxy)
          envRecord.https_proxy = process.env.https_proxy;
        delete envRecord.NO_PROXY;
        delete envRecord.no_proxy;

        let hostCwd: string;
        let bwrapCwd: string | undefined;
        try {
          hostCwd = resolveHostCwd(sandbox.workspaceDir, ctx.cwd ?? "/");
          bwrapCwd =
            sandbox.strategy.kind === "bwrap"
              ? bwrapCwdForHostCwd(sandbox.workspaceDir, hostCwd)
              : undefined;
        } catch (e) {
          return {
            stdout: "",
            stderr: e instanceof Error ? e.message : String(e),
            exitCode: 1,
          };
        }

        const invocation = buildBinaryInvocation(binaryPath, args, {
          ...sandbox,
          bwrapCwd,
        });

        return new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve) => {
          execFile(
            invocation.command,
            invocation.args,
            {
              cwd: hostCwd,
              env: envRecord,
              maxBuffer: 10 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              resolve({
                stdout: stdout || "",
                stderr: stderr || (error?.message ?? ""),
                exitCode: error?.code ? Number(error.code) || 1 : 0,
              });
            }
          );
        });
      })
    );
  }

  return commands;
}

interface EmbeddedBashOpsOptions {
  /** Thread-specific workspace directory used as the sandbox filesystem root. */
  workspaceDir?: string;
  /**
   * When provided together with `gw`, MCP servers are exposed as one
   * `just-bash` custom command per server (e.g. `owletto search_knowledge
   * <<<'{...}'`). Only applied when `mcpExposure === "cli"`. The ref's
   * optional `refresh()` is invoked after successful auth operations so
   * CLI handlers pick up freshly-discovered MCP tools without rebuilding Bash.
   */
  mcpRuntimeRef?: McpRuntimeRef;
  gw?: GatewayParams;
  /** `"tools"` (default) keeps today's first-class MCP tools. `"cli"` swaps to sandboxed bash CLIs. */
  mcpExposure?: "tools" | "cli";
}

/**
 * Convert an in-process MCP CLI handler into a just-bash `defineCommand` entry.
 */
async function adaptMcpCliCommand(
  cmd: McpCliCommand
): Promise<ReturnType<typeof import("just-bash").defineCommand>> {
  const { defineCommand } = await import("just-bash");
  return defineCommand(cmd.name, async (args: string[], ctx) => {
    const stdin = typeof ctx.stdin === "string" ? ctx.stdin : "";
    const signal = ctx.signal as AbortSignal | undefined;
    return cmd.execute(args, { stdin, signal });
  });
}

/**
 * Create a BashOperations adapter backed by a just-bash Bash instance.
 * Reads configuration from environment variables.
 */
export async function createEmbeddedBashOps(
  options: EmbeddedBashOpsOptions = {}
): Promise<BashOperations> {
  const { Bash, ReadWriteFs } = await import("just-bash");

  const rawWorkspaceDir =
    options.workspaceDir || process.env.WORKSPACE_DIR || "/workspace";
  // Canonicalize so the sandbox profile, ReadWriteFs root, bind mounts, and
  // realpath checks all see the same resolved path. macOS TMPDIR routes through
  // /var → /private/var symlinks; without realpath, the SBPL allow rule and
  // execFile cwd disagree.
  let workspaceDir = rawWorkspaceDir;
  try {
    fs.mkdirSync(rawWorkspaceDir, { recursive: true });
    workspaceDir = fs.realpathSync(rawWorkspaceDir);
  } catch {
    // Fall through with the raw value; downstream calls surface real errors.
  }
  const bashFs = new ReadWriteFs({ root: workspaceDir });

  // Parse allowed domains from env var (set by gateway)
  let allowedDomains: string[] = [];
  if (process.env.JUST_BASH_ALLOWED_DOMAINS) {
    try {
      allowedDomains = JSON.parse(process.env.JUST_BASH_ALLOWED_DOMAINS);
    } catch {
      console.error(
        `[embedded] Failed to parse JUST_BASH_ALLOWED_DOMAINS: ${process.env.JUST_BASH_ALLOWED_DOMAINS}`
      );
    }
  }

  const network =
    allowedDomains.length > 0
      ? {
          allowedUrlPrefixes: allowedDomains.flatMap((domain: string) => [
            `https://${domain}/`,
            `http://${domain}/`,
          ]),
          allowedMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as (
            | "GET"
            | "HEAD"
            | "POST"
            | "PUT"
            | "PATCH"
            | "DELETE"
          )[],
        }
      : undefined;

  // Build MCP CLI commands first so that explicit MCP registrations win over
  // any PATH-discovered binary with the same name (e.g. `owletto` is both an
  // installed nix binary and an MCP server).
  let mcpCliCommands: McpCliCommand[] = [];
  if (options.mcpExposure === "cli" && options.mcpRuntimeRef && options.gw) {
    mcpCliCommands = buildMcpCliCommands(options.mcpRuntimeRef, options.gw);
  }
  const mcpCliNames = new Set(mcpCliCommands.map((c) => c.name));

  const sandboxStrategy = probeSandboxStrategy();
  const allowUnsandboxedExec =
    process.env.LOBU_ALLOW_UNSANDBOXED_EXEC === "1" ||
    process.env.LOBU_ALLOW_UNSANDBOXED_EXEC === "true";

  const registerSpawnedBinaries =
    sandboxStrategy.kind !== "none" || allowUnsandboxedExec;

  // Discover nix binaries and known CLI tools, register as custom commands.
  // Strip names claimed by MCP CLIs so the MCP-backed handler takes precedence.
  const binaries = registerSpawnedBinaries
    ? discoverBinaries()
    : new Map<string, string>();
  for (const name of mcpCliNames) {
    binaries.delete(name);
  }
  const sandboxCtx: SandboxContext = {
    strategy: sandboxStrategy,
    workspaceDir,
    // Spawned binaries reach the network through HTTP_PROXY → gateway, which
    // already enforces the per-agent domain allowlist. Letting the OS network
    // namespace stay open lets curl/git/gh respect HTTP_PROXY normally.
    allowNet: true,
  };
  const binaryCommands =
    binaries.size > 0 ? await buildCustomCommands(binaries, sandboxCtx) : [];

  if (sandboxStrategy.kind !== "none") {
    console.log(`[embedded] exec sandbox active: kind=${sandboxStrategy.kind}`);
  } else if (!allowUnsandboxedExec) {
    console.warn(
      `[embedded] Exec sandbox unavailable; not registering spawned binary ` +
        `commands. Set LOBU_ALLOW_UNSANDBOXED_EXEC=1 to allow host-privileged ` +
        `spawned binaries.`
    );
  }

  const mcpCommandEntries = await Promise.all(
    mcpCliCommands.map((c) => adaptMcpCliCommand(c))
  );

  const customCommands = [...mcpCommandEntries, ...binaryCommands];

  if (binaries.size > 0) {
    const names = [...binaries.keys()].slice(0, 20).join(", ");
    const suffix = binaries.size > 20 ? `, ... (${binaries.size} total)` : "";
    console.log(
      `[embedded] Registered ${binaries.size} binary commands: ${names}${suffix}`
    );
  }
  if (mcpCliCommands.length > 0) {
    console.log(
      `[embedded] Registered ${
        mcpCliCommands.length
      } MCP CLI commands: ${mcpCliCommands.map((c) => c.name).join(", ")}`
    );
  }

  const bashInstance = new Bash({
    fs: bashFs,
    cwd: "/",
    env: stripEnv(process.env, SENSITIVE_WORKER_ENV_KEYS),
    executionLimits: EMBEDDED_BASH_LIMITS,
    ...(network && { network }),
    ...(customCommands.length > 0 && { customCommands }),
  });

  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const timeoutMs =
        timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;

      const result = await bashInstance.exec(command, {
        cwd,
        signal,
        env: { TIMEOUT_MS: timeoutMs ? String(timeoutMs) : "" },
      });

      if (result.stdout) {
        onData(Buffer.from(result.stdout));
      }
      if (result.stderr) {
        onData(Buffer.from(result.stderr));
      }

      return { exitCode: result.exitCode };
    },
  };
}
