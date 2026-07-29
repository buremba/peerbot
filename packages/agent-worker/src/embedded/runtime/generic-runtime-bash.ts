import type { BashOperations } from "@mariozechner/pi-coding-agent";
import type { GatewayParams } from "@lobu/plugin-toolkit";
import { buildAgentEnv } from "../../shared/worker-env-keys";
import type { WorkerRuntimeProvider } from "./types";

type RuntimeExecResponse = {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  error?: unknown;
  /** "infrastructure" when the RUNTIME failed and the command never ran. */
  kind?: unknown;
  /** Whether re-running the same command later could plausibly succeed. */
  retryable?: unknown;
  /** "not_started" | "unknown" | "completed" — whether the command ran. */
  outcome?: unknown;
  /**
   * Provider diagnostics. Carries `packages` (a `PackageProvisionResult`)
   * whenever the turn had contributed nix packages to provision — the gateway
   * reports a failed install HERE, at HTTP 200, because a missing CLI must not
   * fail the turn.
   */
  sandbox?: unknown;
};

/** The names in a `PackageProvisionResult` list, tolerating a malformed body. */
function packageNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
}

function provisionResult(
  sandbox: unknown
): Record<string, unknown> | undefined {
  if (typeof sandbox !== "object" || sandbox === null) return undefined;
  const packages = (sandbox as { packages?: unknown }).packages;
  if (typeof packages !== "object" || packages === null) return undefined;
  return packages as Record<string, unknown>;
}

/**
 * The agent-facing half of the honest-degradation contract. The gateway already
 * degrades honestly — it logs the failure, withholds the stale package profile
 * from PATH, and reports `sandbox.packages.failed` — but the AGENT never reads
 * gateway logs. Without this notice the model sees a plain `command not found`
 * next to exit 0, concludes its own invocation was wrong, and burns the turn
 * rewriting a command that can never work.
 *
 * Same `lobu:` channel as the infrastructure notice below on purpose: one place
 * for the agent to learn its environment is degraded.
 */
function provisionNotice(sandbox: unknown): string | undefined {
  const packages = provisionResult(sandbox);
  if (!packages) return undefined;
  const failed = packageNames(packages.failed);
  if (failed.length === 0) return undefined;
  const error = typeof packages.error === "string" ? packages.error.trim() : "";
  const why = error ? ` (${error})` : "";
  return (
    `lobu: these tools could not be installed and are NOT available in this sandbox: ${failed.join(", ")}${why}. ` +
    "Commands that need them will fail — do not try to install them yourself; " +
    "an admin must fix the package configuration.\n"
  );
}

/**
 * The worker egresses through a local gateway HTTP proxy (`HTTP_PROXY=…:8118`),
 * which is meaningless inside a remote sandbox — the sandbox enforces egress
 * via its own network policy derived from `allowedDomains`. Strip them so the
 * remote command doesn't try to dial a proxy that isn't there.
 */
const REMOTE_UNSUPPORTED_ENV_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

function commandEnv(
  env: NodeJS.ProcessEnv | undefined,
  remoteEnv: Record<string, string>
): Record<string, string> {
  // Allowlist first — this env crosses the network to a third-party sandbox,
  // so it must never carry the gateway's own secrets.
  const cleanEnv = buildAgentEnv(env ?? process.env);
  for (const key of REMOTE_UNSUPPORTED_ENV_KEYS) {
    delete cleanEnv[key];
  }
  return { ...cleanEnv, ...remoteEnv };
}

/**
 * The single worker-side client for every remote runtime provider. POSTs to
 * the generic `/internal/runtime/exec` route with the worker token; the body
 * never names a provider (the gateway reads it from the signed token). No
 * streaming — the full JSON result is awaited, then emitted via `onData`.
 */
export function createGenericRuntimeBashOps(
  provider: WorkerRuntimeProvider,
  params: { gw: GatewayParams }
): BashOperations {
  const endpoint = `${params.gw.gatewayUrl.replace(/\/+$/, "")}/internal/runtime/exec`;

  return {
    async exec(command, cwd, { env, onData, signal, timeout }) {
      const timeoutMs =
        timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.gw.workerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command,
          cwd,
          workspaceDir: params.gw.workspaceDir,
          timeoutMs,
          env: commandEnv(env, provider.remoteEnv),
          // NOTE: the egress allowlist is NOT sent here — the gateway reads it
          // from the signed worker token (the worker is the sandbox-ee and must
          // not be able to widen its own sandbox network policy).
        }),
        signal,
      });

      const payload = (await response
        .json()
        .catch(() => ({}))) as RuntimeExecResponse;

      if (!response.ok) {
        const message =
          typeof payload.error === "string"
            ? payload.error
            : `Runtime exec failed with HTTP ${response.status}`;
        // The SANDBOX failed, not the command. Say so in the agent's own terms:
        // an unlabelled provider message on stdout with exit 1 is exactly what a
        // genuinely failing command produces, so the agent concluded its syntax
        // was wrong, rewrote a correct command and retried into an already
        // throttled endpoint. Naming the fault is what stops that loop.
        if (payload.kind === "infrastructure") {
          // Two independent facts: whether the command RAN (outcome) and
          // whether retrying is sensible (retryable). Deriving one from the
          // other misleads both ways — a 403 while provisioning is not
          // retryable yet definitely never ran, so telling the agent to go
          // check for side effects sends it hunting for something impossible.
          const ran =
            payload.outcome === "not_started"
              ? "your command did not run"
              : payload.outcome === "completed"
                ? "your command RAN but its output could not be retrieved"
                : "it is unknown whether your command ran";
          // Safety is decided by the OUTCOME, never by retryability. Replay is
          // only safe when the command provably never started; `retryable` then
          // just says whether it is worth trying now. A dispatch 429 is
          // retryable AND "unknown" — advising a retry there could repeat a
          // command that already took effect.
          const advice =
            payload.outcome === "not_started"
              ? payload.retryable
                ? " This is usually transient — the same command may succeed shortly."
                : ""
              : " Do NOT re-run it blindly; check whether it took effect first.";
          onData(
            Buffer.from(
              `lobu: sandbox runtime error — ${ran}.${advice}\n${message}\n`
            )
          );
          // 126 ("command found but not executable") rather than 1: the failure
          // is the runtime's, so it must not read as the command having run and
          // failed. The message above says which of the two cases this is.
          return { exitCode: 126 };
        }
        onData(Buffer.from(`${message}\n`));
        return { exitCode: 1 };
      }

      const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
      const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
      if (stdout) onData(Buffer.from(stdout));
      if (stderr) onData(Buffer.from(stderr));
      // Emitted AFTER the command's own output, and that ordering is
      // load-bearing rather than cosmetic. The bash tool feeds every `onData`
      // chunk into an OutputAccumulator and snapshots it through `truncateTail`
      // — only the LAST 2000 lines / 50KB reach the model. A preamble is
      // exactly what a long-output command drops, so the turn most likely to be
      // derailed by a missing CLI would be the one that never sees why. The
      // tail always survives.
      const notice = provisionNotice(payload.sandbox);
      if (notice) {
        // The notice must land on its own line: a command whose output has no
        // trailing newline would otherwise glue `lobu:` onto its last line.
        const emitted = `${stdout}${stderr}`;
        const separator = emitted && !emitted.endsWith("\n") ? "\n" : "";
        onData(Buffer.from(`${separator}${notice}`));
      }
      return {
        // The command's OWN exit code, untouched. A contributed CLI that failed
        // to install must not fail a turn whose real work does not need it —
        // the notice above is how the agent learns, not a synthetic non-zero
        // exit that would misreport a command which genuinely succeeded.
        exitCode:
          typeof payload.exitCode === "number" &&
          Number.isFinite(payload.exitCode)
            ? payload.exitCode
            : 1,
      };
    },
  };
}
