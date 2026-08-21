import {
  resolveDaemonLaunchContext,
  resolveDaemonWorkerId,
  startDaemonCommand,
} from "@lobu/connector-worker/daemon";
import { hostname } from "node:os";
import {
  addContext,
  apiUrlToGatewayOrigin,
  findContextByOrigin,
  loadContextConfig,
  type ResolvedContext,
  resolveContext,
} from "../internal/context.js";
import { getContextToken } from "../internal/credentials.js";
import {
  type DeviceState,
  loadDeviceState,
  saveDeviceState,
  updateDeviceState,
} from "../internal/device-state.js";
import {
  extractApiError,
  fetchWithRetry,
  parseJsonResponse,
} from "../internal/http.js";
import { deviceWizard } from "./_lib/device-wizard.js";
import { loginCommand } from "./login.js";

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

interface DaemonTarget {
  gatewayOrigin: string;
  contextName?: string;
}

interface MintedDeviceCredential {
  workerId: string;
  workerApiToken: string;
  expiresAt?: number;
}

class DeviceMintError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "DeviceMintError";
  }
}

const CHILD_TOKEN_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000;

/** Shown when `lobu daemon` can't find anything to authorize against. */
const SETUP_MESSAGE =
  "Could not determine a gateway to poll. Configure one of:\n" +
  "  - run `lobu login` to configure a context, or\n" +
  "  - pass --api-url <origin>.";

const LOGIN_SETUP_MESSAGE = (contextName: string) =>
  `This Lobu installation is not logged in. Run \`lobu login --force --context ${contextName}\` in an interactive terminal, then retry.`;

/**
 * Run a headless device worker against one Lobu installation.
 *
 * WORKER_API_TOKEN remains an escape hatch for unattended setups. Ordinarily
 * the command uses the target installation's named OAuth context to mint and
 * cache a worker-bound child PAT. The short-lived OAuth bearer is never handed
 * to the long-running worker and never crosses URL origins.
 */
export async function daemonCommand(options: DaemonOptions): Promise<void> {
  const explicitWorkerToken = process.env.WORKER_API_TOKEN?.trim();
  const target = await resolveDaemonTarget(options.apiUrl);

  const requestedPlatform = options.platform?.trim() || undefined;
  // The native macOS app owns the `macos` platform. A terminal daemon is a
  // headless device on every host, including a Mac running Herdr.
  const defaultPlatform = "headless";
  const launchContext = resolveDaemonLaunchContext({
    platform: requestedPlatform,
    defaultPlatform,
    ...(options.interactiveSession === false
      ? { interactiveSession: false as const }
      : {}),
    ...(options.insideClaude === true ? { insideClaude: true } : {}),
  });
  const platform = launchContext.platform ?? defaultPlatform;
  const sessionLane =
    launchContext.interactiveSession !== undefined ||
    options.insideClaude === true;
  const shortHost = hostname().split(".")[0] || hostname();
  const explicitWorkerId = options.workerId?.trim() || undefined;
  const sessionWorkerId = sessionLane
    ? resolveDaemonWorkerId(
        {
          workerId: explicitWorkerId,
          ...(options.insideClaude === true ? { insideClaude: true } : {}),
        },
        platform,
        shortHost,
        launchContext.interactiveSession
      )
    : undefined;

  let contextName = target.contextName;
  if (!explicitWorkerToken) {
    // Checked before any context is saved: an advanced platform override has no
    // login-based path, so a doomed start must not leave a new context behind.
    if (platform !== "headless") {
      throw new Error(
        `Login-based daemon setup supports the headless platform, not "${platform}". Omit --platform, or provide an explicit WORKER_API_TOKEN for this advanced platform override.`
      );
    }
    if (!contextName) {
      contextName = await ensureInstallationContext(target.gatewayOrigin);
    }
  }

  // One cache slot per persisted identity: the host default shares the bare
  // platform key the wizard writes, while an explicit --worker-id gets its own.
  const statePlatform = explicitWorkerId
    ? `${platform}-worker-${explicitWorkerId}`
    : platform;
  // Agent-session identities are deterministic but ephemeral, so they get no
  // cache slot at all. Keep their PAT in this process only: a restart can mint
  // the same worker id again, while the server reaper owns cleanup of
  // abandoned unbound devices and tokens.
  const cachedState =
    contextName && !sessionLane
      ? await loadDeviceState(contextName, statePlatform)
      : null;

  let workerId = explicitWorkerId ?? sessionWorkerId ?? cachedState?.workerId;
  let workerApiToken = explicitWorkerToken;

  if (workerApiToken) {
    if (!workerApiToken.startsWith("owl_pat_")) {
      throw new Error(
        "WORKER_API_TOKEN must be a Lobu personal access token with an owl_pat_ prefix."
      );
    }
    if (!workerId) {
      workerId = await resolveHostWorkerId(
        platform,
        contextName,
        target.gatewayOrigin,
        workerApiToken
      );
    }
  } else {
    // Assigned above whenever WORKER_API_TOKEN is unset; restated so the mint
    // helpers below see a `string`.
    if (!contextName) throw new Error(SETUP_MESSAGE);

    if (
      workerId &&
      cachedState?.workerId === workerId &&
      hasUsableCachedWorkerToken(cachedState)
    ) {
      workerApiToken = cachedState.workerApiToken;
    } else {
      let mintBearer = cachedState?.workerApiToken;
      if (!workerId) {
        mintBearer = await requireInstallationLogin(contextName);
        workerId = await resolveHostWorkerId(
          platform,
          contextName,
          target.gatewayOrigin,
          mintBearer
        );
      }

      let minted: MintedDeviceCredential;
      try {
        const bearer =
          mintBearer ?? (await requireInstallationLogin(contextName));
        minted = await mintDeviceCredential({
          gatewayOrigin: target.gatewayOrigin,
          bearer,
          platform,
          workerId,
          label: options.label?.trim() || shortHost,
        });
      } catch (error) {
        // A cached child can rotate only itself and may have expired or been
        // revoked. Fall back to this installation's login, never another
        // context's token.
        if (
          !mintBearer?.startsWith("owl_pat_") ||
          !(error instanceof DeviceMintError) ||
          (error.status !== 401 && error.status !== 403)
        ) {
          throw error;
        }
        minted = await mintDeviceCredential({
          gatewayOrigin: target.gatewayOrigin,
          bearer: await requireInstallationLogin(contextName),
          platform,
          workerId,
          label: options.label?.trim() || shortHost,
        });
      }

      if (minted.workerId !== workerId) {
        throw new Error(
          `The gateway registered worker id "${minted.workerId}" instead of "${workerId}"; refusing to start with a mismatched credential.`
        );
      }
      if (!sessionLane) {
        await persistDeviceCredential(contextName, statePlatform, minted);
      }
      workerApiToken = minted.workerApiToken;
    }
  }

  // Both are set on every path above; this narrows them for the call below.
  if (!workerId || !workerApiToken) {
    throw new Error(
      `Could not resolve a device identity and credential for ${target.gatewayOrigin}.`
    );
  }

  await startDaemonCommand({
    apiUrl: target.gatewayOrigin,
    platform: sessionLane ? "headless" : requestedPlatform,
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

async function resolveDaemonTarget(
  explicitApiUrl: string | undefined
): Promise<DaemonTarget> {
  const explicit = explicitApiUrl?.trim();
  if (explicit) {
    const gatewayOrigin = requireGatewayOrigin(explicit);
    const matched = await findContextByOrigin(gatewayOrigin);
    return {
      gatewayOrigin,
      ...(matched ? { contextName: matched.name } : {}),
    };
  }

  // Only the lookup itself falls back to the setup message: an unusable URL has
  // to keep reporting the address the user actually configured.
  let context: ResolvedContext;
  try {
    context = await resolveContext();
  } catch {
    throw new Error(SETUP_MESSAGE);
  }
  const gatewayOrigin = requireGatewayOrigin(context.url);
  // LOBU_API_URL is an override just like --api-url: it must not inherit the
  // device state of the otherwise-current named context, only of a context
  // configured for that same origin.
  if (context.source !== "env") {
    return { gatewayOrigin, contextName: context.name };
  }
  const matched = await findContextByOrigin(gatewayOrigin);
  return {
    gatewayOrigin,
    ...(matched ? { contextName: matched.name } : {}),
  };
}

function requireGatewayOrigin(value: string): string {
  const origin = apiUrlToGatewayOrigin(value);
  try {
    return new URL(origin).origin;
  } catch {
    throw new Error(`Invalid gateway URL: ${value}`);
  }
}

async function ensureInstallationContext(
  gatewayOrigin: string
): Promise<string> {
  const matched = await findContextByOrigin(gatewayOrigin);
  if (matched) return matched.name;

  const config = await loadContextConfig();
  const host = new URL(gatewayOrigin).hostname.toLowerCase();
  const baseName = host || "lobu-installation";
  let name = baseName;
  let suffix = 2;
  while (config.contexts[name]) {
    name = `${baseName}-${suffix}`;
    suffix += 1;
  }
  await addContext(name, gatewayOrigin);
  console.log(
    `\n  Saved Lobu installation context "${name}" (${gatewayOrigin}).`
  );
  return name;
}

async function requireInstallationLogin(contextName: string): Promise<string> {
  const existing = await getContextToken(contextName);
  if (existing) return existing;
  if (!canPrompt()) throw new Error(LOGIN_SETUP_MESSAGE(contextName));

  // `getContextToken` already returned null, so any stored credential is
  // expired and unrefreshable. Without --force `lobu login` short-circuits on
  // it with "Already logged in" and authorizes nothing.
  await loginCommand({ context: contextName, force: true });
  const authenticated = await getContextToken(contextName);
  if (!authenticated) throw new Error(LOGIN_SETUP_MESSAGE(contextName));
  return authenticated;
}

function hasUsableCachedWorkerToken(state: DeviceState): boolean {
  return Boolean(
    state.workerApiToken?.startsWith("owl_pat_") &&
      typeof state.expiresAt === "number" &&
      state.expiresAt > Date.now() + CHILD_TOKEN_REFRESH_BUFFER_MS
  );
}

async function mintDeviceCredential(options: {
  gatewayOrigin: string;
  bearer: string;
  platform: string;
  workerId: string;
  label: string;
}): Promise<MintedDeviceCredential> {
  const url = `${options.gatewayOrigin}/api/me/devices/mint-child-token`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.bearer}`,
      "Content-Type": "application/json",
      "X-Lobu-Client": "cli",
    },
    body: JSON.stringify({
      platform: options.platform,
      worker_id: options.workerId,
      label: options.label,
    }),
  });
  const parsed = (await parseJsonResponse(res, url, (message: string) => {
    throw new DeviceMintError(message, res.status);
  })) as Record<string, unknown> | undefined;
  if (!res.ok) {
    const { message } = extractApiError(parsed, res.status, res.statusText);
    throw new DeviceMintError(
      `Could not authorize this device: ${message}`,
      res.status
    );
  }

  const workerId =
    typeof parsed?.worker_id === "string" ? parsed.worker_id : "";
  const workerApiToken =
    typeof parsed?.access_token === "string" ? parsed.access_token : "";
  const expiresAt =
    typeof parsed?.expires_at === "string"
      ? Date.parse(parsed.expires_at)
      : Number.NaN;
  if (!workerId || !workerApiToken.startsWith("owl_pat_")) {
    throw new DeviceMintError(
      "The gateway returned an invalid device credential.",
      res.status
    );
  }
  return {
    workerId,
    workerApiToken,
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
  };
}

async function persistDeviceCredential(
  contextName: string,
  statePlatform: string,
  credential: MintedDeviceCredential
): Promise<void> {
  const state: DeviceState = {
    workerId: credential.workerId,
    workerApiToken: credential.workerApiToken,
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
  };
  const existing = await loadDeviceState(contextName, statePlatform);
  if (existing) {
    await updateDeviceState(contextName, statePlatform, state);
    return;
  }
  try {
    await saveDeviceState(contextName, statePlatform, state);
  } catch (error) {
    const winner = await loadDeviceState(contextName, statePlatform);
    if (winner?.workerId !== state.workerId) throw error;
    await updateDeviceState(contextName, statePlatform, state);
  }
}

/**
 * Resolve a normal host identity for a device that has no cached one yet: the
 * TTY first-run wizard, else the deterministic `<platform>:<hostname>`. Callers
 * consume the cache themselves, so reaching here means there is nothing saved.
 */
async function resolveHostWorkerId(
  platform: string,
  contextName: string | undefined,
  gatewayOrigin: string,
  authorizationToken: string
): Promise<string> {
  const shortHost = hostname().split(".")[0] || hostname();
  const suggested = `${platform}:${shortHost}`;
  // A URL override with no matching context is stateless: it has no context to
  // save the wizard's choice under, so take the deterministic id.
  if (!contextName) return suggested;
  if (!canPrompt()) return suggested;

  const result = await deviceWizard({
    context: contextName,
    gatewayOrigin,
    platform,
    suggestedWorkerId: suggested,
    workerApiToken: authorizationToken,
  });
  return result.workerId;
}

function canPrompt(): boolean {
  const ci = process.env.CI?.trim().toLowerCase();
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    (!ci || ci === "0" || ci === "false")
  );
}
