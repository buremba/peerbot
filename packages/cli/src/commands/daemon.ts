import { startDaemonCommand } from "@lobu/connector-worker/daemon";
import { apiUrlToGatewayOrigin, resolveContext } from "../internal/context.js";

export interface DaemonOptions {
  apiUrl?: string;
  workerId?: string;
  platform?: string;
  capabilities?: string;
  label?: string;
  debug?: boolean;
}

/**
 * `lobu daemon` — run a device worker that polls the gateway for jobs
 * (connector syncs/actions, and device Automations via the local agent CLIs).
 *
 * Everything except the token auto-discovers from where it is running:
 *   - api-url  → the logged-in context (`lobu login`), else `--api-url`
 *   - platform → `macos` on darwin, `headless` otherwise
 *   - worker id / label → `<platform>:<short-hostname>` / hostname
 *   - capabilities → `os.shell,os.files`
 *
 * Org binding is the token, not a flag: pass a durable `owl_pat_…` PAT in
 * `WORKER_API_TOKEN` (`lobu token create --raw`); the server anchors the worker
 * to that token's org.
 */
export async function daemonCommand(options: DaemonOptions): Promise<void> {
  let apiUrl = options.apiUrl?.trim();
  if (!apiUrl) {
    try {
      // The worker API is mounted at the ORIGIN, not under the context's
      // `/api/v1` SDK path — see `apiUrlToGatewayOrigin`.
      apiUrl = apiUrlToGatewayOrigin((await resolveContext()).url);
    } catch {
      // No context configured — surface the explicit requirement below.
    }
  }
  if (!apiUrl) {
    throw new Error(
      "--api-url is required (or run `lobu login` to configure a context)"
    );
  }

  const platform =
    options.platform?.trim() ||
    (process.platform === "darwin" ? "macos" : "headless");

  await startDaemonCommand({
    apiUrl,
    platform,
    workerId: options.workerId?.trim() || undefined,
    label: options.label?.trim() || undefined,
    capabilities: (options.capabilities ?? "os.shell,os.files")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    workerApiToken: process.env.WORKER_API_TOKEN,
    debug: options.debug === true,
  });
}
