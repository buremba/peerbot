import fs from "node:fs";
import path from "node:path";
import { ErrorCode, OrchestratorError } from "@lobu/core";
import { nixPackageAttrRef as nixPackageAttrRefBase } from "@lobu/connector-sdk/nix-package";

export function buildEmbeddedWorkerPath(
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

export function buildWorkerInvocation(entryPoint: string): {
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
  // closest available lever and keeps dev semantics honest (no no-op V8 flag).
  return {
    command: getBunExecutable(),
    args: ["--smol", "run", entryPoint],
  };
}

export function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

/**
 * Validate a declared Nix package name and return a safe Nix attribute
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
