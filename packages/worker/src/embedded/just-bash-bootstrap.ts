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
import type { BashOperations } from "@mariozechner/pi-coding-agent";

const EMBEDDED_BASH_LIMITS = {
  maxCommandCount: 50_000,
  maxLoopIterations: 50_000,
  maxCallDepth: 50,
} as const;

/**
 * Discover binaries to register as custom commands:
 * 1. All executables from /nix/store/ PATH directories
 * 2. Known CLI tools (owletto) from anywhere on PATH
 */
function discoverBinaries(): Map<string, string> {
  const binaries = new Map<string, string>();
  const pathDirs = (process.env.PATH || "").split(":");

  for (const dir of pathDirs) {
    if (!dir.includes("/nix/store/")) continue;
    try {
      for (const entry of fs.readdirSync(dir)) {
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
 * Create just-bash customCommands from a map of binary name → full path.
 * Each custom command delegates to the real binary via child_process.execFile.
 */
async function buildCustomCommands(
  binaries: Map<string, string>
): Promise<ReturnType<typeof import("just-bash").defineCommand>[]> {
  const { defineCommand } = await import("just-bash");
  const commands = [];

  for (const [name, binaryPath] of binaries) {
    commands.push(
      defineCommand(name, async (args: string[], ctx) => {
        // Convert ctx.env (Map-like) to a plain Record for child_process
        const envRecord: Record<string, string> = { ...process.env } as Record<
          string,
          string
        >;
        if (ctx.env && typeof ctx.env.forEach === "function") {
          ctx.env.forEach((v: string, k: string) => {
            envRecord[k] = v;
          });
        } else if (ctx.env && typeof ctx.env === "object") {
          Object.assign(envRecord, ctx.env);
        }

        return new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve) => {
          execFile(
            binaryPath,
            args,
            {
              cwd: ctx.cwd,
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

/**
 * Create a BashOperations adapter backed by a just-bash Bash instance.
 * Reads configuration from environment variables.
 */
export async function createEmbeddedBashOps(): Promise<BashOperations> {
  const { Bash, ReadWriteFs } = await import("just-bash");

  const workspaceDir = process.env.WORKSPACE_DIR || "/workspace";
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

  // Discover nix binaries and known CLI tools, register as custom commands
  const binaries = discoverBinaries();
  const customCommands =
    binaries.size > 0 ? await buildCustomCommands(binaries) : [];

  if (binaries.size > 0) {
    const names = [...binaries.keys()].slice(0, 20).join(", ");
    const suffix = binaries.size > 20 ? `, ... (${binaries.size} total)` : "";
    console.log(
      `[embedded] Registered ${binaries.size} custom commands: ${names}${suffix}`
    );
  }

  const bashInstance = new Bash({
    fs: bashFs,
    cwd: "/",
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
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
