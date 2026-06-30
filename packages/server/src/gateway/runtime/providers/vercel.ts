import { createHash } from "node:crypto";
import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import { remoteCwd } from "../workspace.js";
import type {
  GatewayRuntimeProvider,
  RuntimeExecContext,
  RuntimeExecResult,
} from "../types.js";

const REMOTE_WORKSPACE_DIR = "/vercel/sandbox";

type SnapshotRetention = {
  snapshotExpiration?: number;
  keepLastSnapshots?: {
    count: number;
    expiration?: number;
    deleteEvicted?: boolean;
  };
};

type VercelCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function snapshotRetention(): SnapshotRetention {
  const snapshotExpiration = parseNonNegativeInt(
    process.env.LOBU_VERCEL_SANDBOX_SNAPSHOT_EXPIRATION_MS
  );
  const keepCount = Math.min(
    10,
    Math.max(
      1,
      parsePositiveInt(process.env.LOBU_VERCEL_SANDBOX_KEEP_LAST_SNAPSHOTS, 1)
    )
  );
  return {
    ...(snapshotExpiration !== undefined ? { snapshotExpiration } : {}),
    keepLastSnapshots: {
      count: keepCount,
      ...(snapshotExpiration !== undefined
        ? { expiration: snapshotExpiration }
        : {}),
      deleteEvicted: parseBoolean(
        process.env.LOBU_VERCEL_SANDBOX_DELETE_EVICTED_SNAPSHOTS,
        true
      ),
    },
  };
}

/**
 * The credential resolver hands us token/teamId/projectId together (all
 * `required`), but stay defensive: an empty `values` map means "fall back to
 * the Vercel SDK's ambient/OIDC auth" exactly as the original route did.
 */
function vercelCredentials(
  values: Record<string, string>
): Partial<VercelCredentials> {
  const { token, teamId, projectId } = values;
  const present = [token, teamId, projectId].filter((value) => !!value).length;
  if (present === 0) return {};
  if (present !== 3 || !token || !teamId || !projectId) {
    throw new Error(
      "VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID must be set together"
    );
  }
  return { token, teamId, projectId };
}

function stableSandboxName(params: {
  organizationId?: string;
  agentId: string;
  conversationId: string;
}): string {
  const prefix = (process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX || "lobu")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const org = (params.organizationId || "orgless")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const agent = params.agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const hash = createHash("sha256")
    .update(
      `${params.organizationId || ""}:${params.agentId}:${params.conversationId}`
    )
    .digest("hex")
    .slice(0, 16);
  return [prefix || "lobu", org || "orgless", agent || "agent", hash]
    .join("-")
    .slice(0, 100);
}

function sameSnapshotRetention(
  actual: Sandbox["keepLastSnapshots"],
  expected: SnapshotRetention["keepLastSnapshots"],
  actualExpiration: Sandbox["snapshotExpiration"],
  expectedExpiration: SnapshotRetention["snapshotExpiration"]
): boolean {
  return (
    actual?.count === expected?.count &&
    actual?.expiration === expected?.expiration &&
    actual?.deleteEvicted === expected?.deleteEvicted &&
    actualExpiration === expectedExpiration
  );
}

function normalizeAllowedDomain(domain: string): string | null {
  const trimmed = domain.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  if (!/^[A-Za-z0-9.*_-]+(?::\d+)?$/.test(trimmed)) return null;
  if (trimmed.startsWith(".")) return `*${trimmed}`;
  return trimmed;
}

function networkPolicyFromDomains(value: unknown): NetworkPolicy {
  if (!Array.isArray(value)) return "deny-all";
  const domains = value
    .filter((entry): entry is string => typeof entry === "string")
    .map(normalizeAllowedDomain)
    .filter((entry): entry is string => !!entry);
  if (domains.includes("*")) return "allow-all";
  return domains.length > 0
    ? { allow: Array.from(new Set(domains)) }
    : "deny-all";
}

async function getSandbox(params: {
  name: string;
  networkPolicy: NetworkPolicy;
  credentials: Record<string, string>;
}): Promise<Sandbox> {
  const timeout = parsePositiveInt(
    process.env.LOBU_VERCEL_SANDBOX_TIMEOUT_MS,
    parsePositiveInt(process.env.TIMEOUT_MINUTES, 10) * 60 * 1000
  );
  const vcpus = parsePositiveInt(process.env.LOBU_VERCEL_SANDBOX_VCPUS, 1);
  const runtime =
    process.env.LOBU_VERCEL_SANDBOX_RUNTIME ||
    process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME ||
    "node24";
  const retention = snapshotRetention();
  const sandbox = await Sandbox.getOrCreate({
    name: params.name,
    ...vercelCredentials(params.credentials),
    persistent: true,
    runtime,
    timeout,
    resources: { vcpus },
    networkPolicy: params.networkPolicy,
    ...retention,
    tags: { app: "lobu", backend: "worker" },
  });

  if (
    JSON.stringify(sandbox.networkPolicy) !==
      JSON.stringify(params.networkPolicy) ||
    sandbox.timeout !== timeout ||
    sandbox.vcpus !== vcpus ||
    !sameSnapshotRetention(
      sandbox.keepLastSnapshots,
      retention.keepLastSnapshots,
      sandbox.snapshotExpiration,
      retention.snapshotExpiration
    )
  ) {
    await sandbox.update({
      networkPolicy: params.networkPolicy,
      resources: { vcpus },
      timeout,
      ...retention,
    });
  }
  return sandbox;
}

/**
 * Vercel persistent-sandbox runtime (gateway side). The sandbox name is
 * deterministic per (org, agent, conversation) so messages resume the same
 * filesystem; the filesystem is the persistent source of truth (no file sync).
 */
export const vercelGatewayRuntimeProvider: GatewayRuntimeProvider = {
  id: "vercel",
  credentialFields: [
    {
      key: "token",
      systemEnvVar: "VERCEL_TOKEN",
      required: true,
      secret: true,
      label: "Access token",
    },
    {
      key: "teamId",
      systemEnvVar: "VERCEL_TEAM_ID",
      required: true,
      secret: false,
      label: "Team ID",
    },
    {
      key: "projectId",
      systemEnvVar: "VERCEL_PROJECT_ID",
      required: true,
      secret: false,
      label: "Project ID",
    },
  ],
  canSelfAuth(): boolean {
    // Vercel's recommended auth: an ambient OIDC token (present when Lobu runs
    // on Vercel, or pulled via `vercel env pull`). The SDK self-resolves it.
    return !!process.env.VERCEL_OIDC_TOKEN?.trim();
  },
  async exec(ctx: RuntimeExecContext): Promise<RuntimeExecResult> {
    const sandboxName = stableSandboxName({
      organizationId: ctx.organizationId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    const networkPolicy = networkPolicyFromDomains(ctx.allowedDomains);
    const sandbox = await getSandbox({
      name: sandboxName,
      networkPolicy,
      credentials: ctx.credentials.values,
    });

    await sandbox.fs.mkdir(REMOTE_WORKSPACE_DIR, { recursive: true });

    const result = await sandbox.runCommand({
      cmd: "/bin/bash",
      args: ["-lc", ctx.command],
      cwd: remoteCwd(ctx.cwd, ctx.workspaceDir, REMOTE_WORKSPACE_DIR),
      env: ctx.env,
      timeoutMs: ctx.timeoutMs,
    });
    const [stdout, stderr] = await Promise.all([
      result.stdout(),
      result.stderr(),
    ]);

    return {
      stdout,
      stderr,
      exitCode: result.exitCode,
      meta: {
        name: sandbox.name,
        persistent: sandbox.persistent,
        cwd: sandbox.cwd,
      },
    };
  },
};
