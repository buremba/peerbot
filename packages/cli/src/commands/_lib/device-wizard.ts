import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import {
  getToken,
  listOrganizations,
  resolveContext,
} from "../../internal/index.js";
import { apiUrlToGatewayOrigin } from "../../internal/context.js";
import {
  fetchWithRetry,
  parseJsonResponse,
  extractApiError,
} from "../../internal/http.js";
import {
  saveDeviceState,
  workerTokenPrefix,
} from "../../internal/device-state.js";

/**
 * First-run interactive onboarding for `lobu daemon`.
 *
 * Everything here is a guided convenience over the existing server contract:
 *   - the device id is the `worker_id` the daemon passes on every poll; the
 *     server upserts on `(user_id, worker_id)`, so reusing a confirmed id keeps
 *     the device row stable instead of churning into a second device;
 *   - the org a device is pinned to is driven by the `WORKER_API_TOKEN` it auths
 *     with (org-scoped PAT → that org; personal/session → the personal org). The
 *     wizard does not mutate the org itself — it just surfaces the choice so the
 *     user mints the right token.
 *
 * Runs only when the CLI is interactive (a TTY) AND no explicit `--worker-id`
 * was given. Headless / scripted runs skip the wizard entirely.
 */

export interface DeviceWizardOptions {
  context?: string;
  apiUrl?: string;
  /** Pre-computed default `<platform>:<hostname>` id. */
  suggestedWorkerId: string;
  /** The token the daemon will boot with (WORKER_API_TOKEN), if any. */
  workerApiToken?: string;
  /** Overridable prompts (defaults to real inquirer); injectable for tests. */
  prompts?: DeviceWizardPrompts;
}

/** A registered device as returned by `GET /api/me/devices`. */
interface RemoteDevice {
  id: string;
  worker_id: string;
  platform: string | null;
  label: string | null;
  organization_slug: string | null;
  organization_name: string | null;
}

export interface DeviceWizardResult {
  workerId: string;
  /** How the id was chosen: an existing server row or a fresh confirmation. */
  source: "reused" | "created";
}

async function fetchRemoteDevices(
  apiUrl: string,
  token: string
): Promise<RemoteDevice[]> {
  const origin = apiUrlToGatewayOrigin(apiUrl);
  const url = `${origin}/api/me/devices`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const parsed = (await parseJsonResponse(res, url, (msg: string) => {
    throw new Error(msg);
  })) as { devices?: RemoteDevice[] } | undefined;
  if (!res.ok) {
    const { message } = extractApiError(parsed, res.status, res.statusText);
    throw new Error(`Could not list devices: ${message}`);
  }
  return parsed?.devices ?? [];
}

/**
 * The four prompts the wizard drives. Defaults to the real inquirer prompts;
 * injectable so unit tests can drive every branch without a TTY.
 */
export interface DeviceWizardPrompts {
  select: (config: Parameters<typeof select>[0]) => Promise<string>;
  confirm: (config: Parameters<typeof confirm>[0]) => Promise<boolean>;
  input: (config: Parameters<typeof input>[0]) => Promise<string>;
}

/** Run the wizard. Resolves orgs (for token guidance) and the caller's existing
 * devices, asks personal-vs-org + confirms the device id, and persists the
 * choice so later non-interactive boots reuse it.
 */
export async function deviceWizard(
  options: DeviceWizardOptions
): Promise<DeviceWizardResult> {
  const prompts = options.prompts ?? { select, confirm, input };
  const target = await resolveContext(options.context);
  const apiUrl = options.apiUrl?.trim() || target.url;
  const token = await getToken(target.name);

  let orgs: Array<{ slug: string; name?: string; personal?: boolean }> = [];
  let devices: RemoteDevice[] = [];
  const tokenPrefix = workerTokenPrefix(options.workerApiToken);

  if (token) {
    orgs = await listOrganizations({ context: target.name }).catch(
      () => [] as Array<{ slug: string; name?: string; personal?: boolean }>
    );
    devices = await fetchRemoteDevices(apiUrl, token).catch(
      () => [] as RemoteDevice[]
    );
  }

  const personal = orgs.find((org) => org.personal === true)?.slug;
  const orgOptions = orgs
    .filter((org) => org.slug !== personal)
    .map((org) => ({
      value: org.slug,
      name:
        org.name && org.name !== org.slug
          ? `${org.slug} (${org.name})`
          : org.slug,
    }));
  const personalLabel = personal
    ? chalk.bold(personal) + chalk.dim(" (your private workspace)")
    : "personal";

  console.log();
  console.log(chalk.bold("  Set up this device as a Lobu worker"));
  console.log(
    chalk.dim(
      "  It polls the gateway for connector syncs, actions, and device Automations.\n"
    )
  );

  const orgTarget = await prompts.select({
    message: "Which workspace should this device belong to?",
    choices: [
      { value: personal ?? "__personal__", name: personalLabel },
      ...orgOptions.map((org) => ({ ...org, name: org.name ?? org.value })),
    ],
  });
  const orgSlug =
    orgTarget === "__personal__" ? (personal ?? undefined) : orgTarget;

  // Pick an identity: reuse an existing registered device when available (so a
  // re-run doesn't duplicate a row), else confirm the computed default id.
  const existing = devices.filter(
    (device) => device.worker_id && device.worker_id.length > 0
  );
  let workerId = options.suggestedWorkerId;
  let source: "reused" | "created" = "reused";

  if (existing.length > 0) {
    const choice = await prompts.select({
      message: "Pick a device identity (or start a new one)",
      choices: [
        {
          value: "__new__",
          name: chalk.dim("Start a new device with a fresh id"),
        },
        ...existing.map((device) => ({
          value: device.worker_id,
          name: `${device.label ?? device.worker_id}${device.organization_slug ? chalk.dim(` — ${device.organization_slug}`) : ""}`,
        })),
      ],
    });
    if (choice !== "__new__") {
      workerId = choice;
    } else {
      source = "created";
    }
  } else {
    source = "created";
    const confirmed = await prompts.confirm({
      message: `Register this machine as device "${chalk.bold(options.suggestedWorkerId)}"?`,
      default: true,
    });
    if (!confirmed) {
      const custom = await prompts.input({
        message:
          "Enter a device id (letters, digits, dot, underscore, colon, hyphen):",
        validate: (value) =>
          /^[A-Za-z0-9._:-]{1,128}$/.test(value.trim())
            ? true
            : "Use 1-128 characters of letters, digits, dot, underscore, colon or hyphen",
      });
      workerId = custom.trim();
    }
  }

  const contextName = target.name;
  await saveDeviceState(contextName, {
    workerId,
    workerTokenPrefix: tokenPrefix,
  });

  console.log(
    chalk.green(`\n  Device "${workerId}" pinned to ${orgSlug ?? "personal"}.`)
  );
  console.log(
    chalk.dim(
      `  ${source === "reused" ? "Reusing an existing device row; the daemon will upsert on the same id." : "New device; it registers on the first poll."}`
    )
  );
  if (tokenPrefix) {
    console.log(
      chalk.dim(
        `  Token: ${tokenPrefix}… (${orgSlug ? `org-scoped to ${orgSlug}` : "personal/session"})`
      )
    );
  } else {
    console.log(
      chalk.yellow(
        "  No WORKER_API_TOKEN set — export a durable owl_pat_ token before the daemon can poll."
      )
    );
  }
  console.log(
    chalk.dim(
      `  Saved to ~/.lobu/devices/${contextName}.json (local only; the server owns the pin).`
    )
  );
  console.log(
    chalk.dim(
      "  Later `lobu daemon` runs reuse this without asking, unless you pass --worker-id or delete the file."
    )
  );
  console.log();

  return { workerId, source };
}
