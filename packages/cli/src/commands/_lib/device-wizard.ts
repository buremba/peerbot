import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { apiUrlToGatewayOrigin } from "../../internal/context.js";
import {
  saveDeviceState,
  WORKER_ID_PATTERN,
  workerTokenPrefix,
} from "../../internal/device-state.js";
import {
  extractApiError,
  fetchWithRetry,
  parseJsonResponse,
} from "../../internal/http.js";

const NEW_DEVICE_CHOICE = "__lobu_new_device__";
/** Stands in for the personal org when `/oauth/userinfo` did not name it. */
const PERSONAL_FALLBACK_CHOICE = "__lobu_personal__";

/**
 * First-run interactive onboarding for `lobu daemon`.
 *
 * The server remains authoritative for both identity and workspace attachment:
 * an existing device reports its stored workspace, while a new device attaches
 * according to the durable worker PAT on its first poll. The local cache only
 * keeps subsequent boots on the same `worker_id`.
 */
export interface DeviceWizardOptions {
  context?: string;
  /** Actual daemon gateway URL; the worker PAT is sent only here. */
  apiUrl: string;
  /** Pre-computed default `<platform>:<hostname>` id. */
  suggestedWorkerId: string;
  /** Durable worker PAT used by the daemon. */
  workerApiToken: string;
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

interface OrganizationInfo {
  slug: string;
  name?: string;
  personal?: boolean;
}

export interface DeviceWizardResult {
  workerId: string;
  /** How the id was chosen, including a concurrent first boot winning first. */
  source: "reused" | "created" | "cached";
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
  const parsed = (await parseJsonResponse(res, url, (message: string) => {
    throw new Error(message);
  })) as { devices?: unknown } | undefined;
  if (!res.ok) {
    const { message } = extractApiError(parsed, res.status, res.statusText);
    throw new Error(`Could not list devices: ${message}`);
  }
  if (!Array.isArray(parsed?.devices)) {
    throw new Error(
      "Could not list devices: gateway returned an invalid response"
    );
  }
  return parsed.devices.filter(isRemoteDevice);
}

async function fetchOrganizations(
  apiUrl: string,
  token: string
): Promise<OrganizationInfo[]> {
  const origin = apiUrlToGatewayOrigin(apiUrl);
  const res = await fetchWithRetry(`${origin}/oauth/userinfo`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as {
    personal_org_slug?: unknown;
    organizations?: unknown;
  } | null;
  if (!body || !Array.isArray(body.organizations)) return [];
  const personal =
    typeof body.personal_org_slug === "string" ? body.personal_org_slug : null;
  const organizations: OrganizationInfo[] = [];
  for (const entry of body.organizations) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.slug !== "string" || !value.slug) continue;
    organizations.push({
      slug: value.slug,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(value.personal === true || value.slug === personal
        ? { personal: true }
        : {}),
    });
  }
  return organizations;
}

function isRemoteDevice(value: unknown): value is RemoteDevice {
  if (!value || typeof value !== "object") return false;
  const device = value as Record<string, unknown>;
  return (
    typeof device.id === "string" &&
    device.id.length > 0 &&
    typeof device.worker_id === "string" &&
    device.worker_id.length > 0
  );
}

/** The prompt primitives the wizard drives; injectable for deterministic tests. */
export interface DeviceWizardPrompts {
  select: (config: Parameters<typeof select>[0]) => Promise<string>;
  confirm: (config: Parameters<typeof confirm>[0]) => Promise<boolean>;
  input: (config: Parameters<typeof input>[0]) => Promise<string>;
}

export async function deviceWizard(
  options: DeviceWizardOptions
): Promise<DeviceWizardResult> {
  const prompts = options.prompts ?? { select, confirm, input };
  // The daemon URL and PAT are explicit inputs; a stale/missing context file
  // must not block setup or redirect either credential. The context name is
  // only a local cache namespace.
  const contextName = options.context?.trim() || "gateway";
  const [orgs, devices] = await Promise.all([
    // Organization discovery is optional guidance. Device discovery is not:
    // hiding its failure could create a duplicate identity.
    fetchOrganizations(options.apiUrl, options.workerApiToken).catch(() => []),
    fetchRemoteDevices(options.apiUrl, options.workerApiToken),
  ]);
  const tokenPrefix = workerTokenPrefix(options.workerApiToken);

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

  // A `device_worker:run`-only PAT cannot read `/oauth/userinfo`, so org
  // discovery legitimately comes back empty or single-valued. Prompting for a
  // choice that has exactly one option asks the user to confirm a foregone
  // conclusion, so only ask when there is something to pick between.
  const personalChoice = {
    value: personal ?? PERSONAL_FALLBACK_CHOICE,
    name: personalLabel,
  };
  const orgTarget =
    orgOptions.length > 0
      ? await prompts.select({
          message:
            "Which workspace do you intend this device to run for? (guidance only; the worker PAT decides)",
          choices: [personalChoice, ...orgOptions],
        })
      : personalChoice.value;
  const selectedOrg =
    orgTarget === PERSONAL_FALLBACK_CHOICE
      ? (personal ?? "personal")
      : orgTarget;

  let workerId = options.suggestedWorkerId;
  let source: DeviceWizardResult["source"] = "created";
  let selectedDevice: RemoteDevice | undefined;

  if (devices.length > 0) {
    const choice = await prompts.select({
      message: "Pick a device identity (or start a new one)",
      choices: [
        {
          value: NEW_DEVICE_CHOICE,
          name: chalk.dim("Start a new device with a fresh id"),
        },
        ...devices.map((device) => ({
          value: device.id,
          name: `${device.label ?? device.worker_id}${device.organization_slug ? chalk.dim(` — ${device.organization_slug}`) : ""}`,
        })),
      ],
    });
    if (choice !== NEW_DEVICE_CHOICE) {
      selectedDevice = devices.find((device) => device.id === choice);
      if (!selectedDevice) {
        throw new Error("Selected device is no longer available");
      }
      workerId = selectedDevice.worker_id;
      source = "reused";
    }
  }

  if (source === "created") {
    const confirmed = await prompts.confirm({
      message: `Register this machine as device "${chalk.bold(options.suggestedWorkerId)}"?`,
      default: true,
    });
    if (!confirmed) {
      const custom = await prompts.input({
        message:
          "Enter a device id (letters, digits, dot, underscore, colon, hyphen):",
        validate: (value) =>
          WORKER_ID_PATTERN.test(value.trim())
            ? true
            : "Use 1-128 characters of letters, digits, dot, underscore, colon or hyphen",
      });
      workerId = custom.trim();
    }
  }

  const saved = await saveDeviceState(contextName, { workerId });
  if (saved.workerId !== workerId) {
    workerId = saved.workerId;
    source = "cached";
    selectedDevice = undefined;
  }

  console.log(chalk.green(`\n  Device identity "${workerId}" saved locally.`));
  if (source === "reused") {
    const actualOrg = selectedDevice?.organization_slug;
    console.log(
      chalk.dim(
        `  Reusing the existing device row; the server reports workspace ${actualOrg ? `"${actualOrg}"` : "unattached"}.`
      )
    );
    console.log(
      chalk.dim(
        `  The selected workspace "${selectedOrg}" was guidance only and did not move the existing device.`
      )
    );
  } else if (source === "cached") {
    console.log(
      chalk.dim(
        "  Another concurrent first boot saved this identity first; both daemons will use the same cached id."
      )
    );
  } else {
    console.log(
      chalk.dim(
        "  New device; WORKER_API_TOKEN determines its workspace attachment on first poll."
      )
    );
    console.log(
      chalk.dim(
        `  The selected workspace "${selectedOrg}" is token-selection guidance only.`
      )
    );
  }
  console.log(
    chalk.dim(
      `  Token: ${tokenPrefix ?? "unknown"}… (the server verifies its scope and attachment on poll).`
    )
  );
  console.log(
    chalk.dim(
      `  Saved under ~/.lobu/devices/ for context "${contextName}" (local only; the server owns the attachment).`
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
