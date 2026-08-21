import { startDaemonCommand } from "@lobu/connector-worker/daemon";
import { hostname } from "node:os";
import { apiUrlToGatewayOrigin, resolveContext } from "../internal/context.js";
import { loadDeviceState } from "../internal/device-state.js";
import { getCurrentContextName, getToken } from "../internal/index.js";
import { deviceWizard } from "./_lib/device-wizard.js";

export interface DaemonOptions {
  apiUrl?: string;
  workerId?: string;
  platform?: string;
  capabilities?: string;
  label?: string;
  debug?: boolean;
  insideClaude?: boolean;
  interactiveSession?: boolean;
}

/** Shown when `lobu daemon` can't find anything to authorize against. */
const SETUP_MESSAGE =
  "Could not determine a gateway to poll. Configure one of:\n" +
  "  - run `lobu login` to set up a context (then `lobu daemon` auto-uses it), or\n" +
  "  - pass --api-url <origin> and a durable device token:\n" +
  "      WORKER_API_TOKEN=$(lobu token create --raw --org <slug>) lobu daemon --api-url <origin>\n" +
  "  A long-running daemon needs a durable owl_pat_ token, not the 24h login session.";

/**
 * `lobu daemon` — run a device worker that polls the gateway for jobs
 * (connector syncs/actions, and device Automations via the local agent CLIs).
 *
 * Everything except the token auto-discovers from where it is running:
 *   - api-url  → the logged-in context (`lobu login`), else `--api-url`
 *   - platform → `macos` on darwin, `headless` otherwise
 *   - worker id → `<platform>:<short-hostname>` outside a supported interactive
 *     agent, or a provider/session-derived id when one is inherited
 *   - label → hostname
 *   - capabilities → `os.shell,os.files`
 *
 * Org binding is the token, not a flag: pass a durable `owl_pat_…` PAT in
 * `WORKER_API_TOKEN` (`lobu token create --raw`); the server anchors the worker
 * to that token's org (an org-scoped PAT → that org, personal/session → the
 * personal org).
 *
 * On FIRST interactive boot, a short wizard lets you confirm the device id and
 * see which token/org the device will be pinned with, then caches the choice at
 * `~/.lobu/devices/<context>.json` so later runs bootstrap silently. Pass
 * `--worker-id`, run non-interactively (no TTY), or delete the cache to bypass
 * the wizard.
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
    throw new Error(SETUP_MESSAGE);
  }

  // A device daemon polls for weeks, so it needs a durable credential: either a
  // `WORKER_API_TOKEN` (owl_pat_) or a logged-in session it can fall back to.
  // A brand-new install defaults to a placeholder `local` context with no stored
  // credential, so `resolveContext()` succeeds and the user would otherwise hit
  // the cryptic fail-closed token guard. Surface the setup options up front.
  const contextName = (await getCurrentContextName()).trim() || undefined;
  const hasDurableToken = Boolean(process.env.WORKER_API_TOKEN?.trim());
  const hasSession = Boolean(await getToken(contextName));
  if (!hasDurableToken && !hasSession) {
    throw new Error(SETUP_MESSAGE);
  }

  const platform =
    options.platform?.trim() ||
    (process.platform === "darwin" ? "macos" : "headless");

  const workerId = await resolveWorkerId(options, platform);

  await startDaemonCommand({
    apiUrl,
    platform: options.platform?.trim() || undefined,
    defaultPlatform: process.platform === "darwin" ? "macos" : "headless",
    workerId,
    label: options.label?.trim() || undefined,
    capabilities: (options.capabilities ?? "os.shell,os.files")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    workerApiToken: process.env.WORKER_API_TOKEN,
    debug: options.debug === true,
    ...(options.interactiveSession === false
      ? { interactiveSession: false as const }
      : {}),
    ...(options.insideClaude === true ? { insideClaude: true } : {}),
  });
}

/**
 * Resolve the `worker_id` for this run, in priority order:
 *   1. an explicit `--worker-id` flag (never overridden);
 *   2. a previously cached device id (so every later boot — interactive or not —
 *      stays consistent and never re-prompts);
 *   3. interactive first-run → the onboarding wizard (confirms identity, caches);
 *   4. the computed `<platform>:<hostname>` default.
 *
 * The wizard only runs on a TTY, only when the id is absent, and only when there
 * is no cached device yet — so a fully-configured daemon never prompts.
 */
async function resolveWorkerId(
  options: DaemonOptions,
  platform: string
): Promise<string> {
  const explicit = options.workerId?.trim();
  if (explicit) return explicit;

  const shortHost = hostname().split(".")[0] || hostname();
  const suggested = `${platform}:${shortHost}`;

  const contextName = (await getCurrentContextName()).trim() || undefined;
  const cached = contextName ? await loadDeviceState(contextName) : null;
  if (cached?.workerId) return cached.workerId;

  if (process.stdin.isTTY === true) {
    const result = await deviceWizard({
      context: contextName,
      suggestedWorkerId: suggested,
      workerApiToken: process.env.WORKER_API_TOKEN,
    });
    return result.workerId;
  }

  return suggested;
}
