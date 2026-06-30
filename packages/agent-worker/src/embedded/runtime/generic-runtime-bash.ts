import { stripEnv } from "@lobu/core";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import type { GatewayParams } from "../../shared/tool-implementations";
import { SENSITIVE_WORKER_ENV_KEYS } from "../../shared/worker-env-keys";
import type { WorkerRuntimeProvider } from "./types";

type RuntimeExecResponse = {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  error?: unknown;
};

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
  const cleanEnv = stripEnv(env ?? process.env, [
    ...SENSITIVE_WORKER_ENV_KEYS,
    ...REMOTE_UNSUPPORTED_ENV_KEYS,
  ]);
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
        onData(Buffer.from(`${message}\n`));
        return { exitCode: 1 };
      }

      const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
      const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
      if (stdout) onData(Buffer.from(stdout));
      if (stderr) onData(Buffer.from(stderr));
      return {
        exitCode:
          typeof payload.exitCode === "number" &&
          Number.isFinite(payload.exitCode)
            ? payload.exitCode
            : 1,
      };
    },
  };
}
