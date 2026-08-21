import {
  resolveDaemonLaunchContext,
  startDaemonCommand,
} from "@lobu/connector-worker/daemon";
import { hostname } from "node:os";
import { apiUrlToGatewayOrigin, resolveContext } from "../internal/context.js";
import { loadDeviceState } from "../internal/device-state.js";
import { getCurrentContextName } from "../internal/index.js";
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
  "  - run `lobu login` to configure a context, or\n" +
  "  - pass --api-url <origin>.";

const TOKEN_SETUP_MESSAGE =
  "A device daemon requires a durable owl_pat_ token in WORKER_API_TOKEN; " +
  "a stored OAuth login expires and is never used as daemon authentication.\n" +
  "Mint a device PAT with the required worker scope, then start the daemon:\n" +
  '  WORKER_API_TOKEN=$(lobu token create --raw --org <slug> --scope "device_worker:run profile:read") lobu daemon';

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
 * see the server's current attachment, then caches the choice at
 * `~/.lobu/devices/<context>.json` so later runs bootstrap silently. Pass
 * `--worker-id`, run non-interactively/under CI, inherit a supported agent
 * session, or delete the cache to bypass the wizard.
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

  // Stored login credentials are short-lived admin/session auth. A daemon polls
  // for weeks and snapshots its bearer at boot, so only the explicitly exported
  // worker PAT is accepted here (the shared daemon bootstrap validates again).
  const workerApiToken = process.env.WORKER_API_TOKEN?.trim();
  if (!workerApiToken?.startsWith("owl_pat_")) {
    throw new Error(TOKEN_SETUP_MESSAGE);
  }

  const platform = options.platform?.trim() || undefined;
  const defaultPlatform = process.platform === "darwin" ? "macos" : "headless";
  const launchContext = resolveDaemonLaunchContext({
    platform,
    defaultPlatform,
    ...(options.interactiveSession === false
      ? { interactiveSession: false as const }
      : {}),
    ...(options.insideClaude === true ? { insideClaude: true } : {}),
  });
  const explicitWorkerId = options.workerId?.trim() || undefined;
  // An inherited agent session (or the legacy --inside-claude flag) registers a
  // per-session headless device, and the shared daemon bootstrap derives that
  // id itself. Handing it a cached or wizard-chosen id here would override that
  // routing, so this lane contributes neither an id nor a host platform. The
  // legacy flag holds the lane even when its startup metadata is momentarily
  // absent, since detection re-runs on the next boot.
  const sessionLane =
    launchContext.interactiveSession !== undefined ||
    options.insideClaude === true;
  const workerId =
    explicitWorkerId ??
    (sessionLane
      ? undefined
      : await resolveWorkerId(
          launchContext.platform ?? defaultPlatform,
          apiUrl,
          workerApiToken
        ));
  const daemonPlatform = sessionLane ? "headless" : platform;

  await startDaemonCommand({
    apiUrl,
    platform: daemonPlatform,
    defaultPlatform,
    workerId,
    label: options.label?.trim() || undefined,
    capabilities: (options.capabilities ?? "os.shell,os.files")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    workerApiToken,
    debug: options.debug === true,
    ...(options.interactiveSession === false
      ? { interactiveSession: false as const }
      : {}),
    ...(options.insideClaude === true ? { insideClaude: true } : {}),
  });
}

/**
 * Resolve an ordinary host device's `worker_id` after explicit and inherited
 * session identities have already been handled by the caller: cached identity,
 * then the TTY-only first-run wizard, then `<platform>:<hostname>`.
 *
 * The wizard only runs on a TTY, only when the id is absent, and only when there
 * is no cached device yet — so a fully-configured daemon never prompts.
 */
async function resolveWorkerId(
  platform: string,
  apiUrl: string,
  workerApiToken: string
): Promise<string> {
  const shortHost = hostname().split(".")[0] || hostname();
  const suggested = `${platform}:${shortHost}`;

  const contextName = (await getCurrentContextName()).trim() || undefined;
  const cached = contextName ? await loadDeviceState(contextName) : null;
  if (cached?.workerId) return cached.workerId;

  if (canPrompt()) {
    const result = await deviceWizard({
      context: contextName,
      apiUrl,
      suggestedWorkerId: suggested,
      workerApiToken,
    });
    return result.workerId;
  }

  return suggested;
}

function canPrompt(): boolean {
  const ci = process.env.CI?.trim().toLowerCase();
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    (!ci || ci === "0" || ci === "false")
  );
}
