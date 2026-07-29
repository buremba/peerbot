import { createHash } from "node:crypto";
import { normalizeDomainPattern } from "@lobu/core";
import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import { remoteCwd, shellQuote } from "../workspace.js";
import { RuntimeInfrastructureError } from "../types.js";
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
  // Canonicalize (lowercase + punycode, "*.x" collapses to ".x") so
  // allow/deny overlap checks compare the one form DNS actually resolves —
  // a mixed-case deny must still subtract its allow entry.
  const canonical = normalizeDomainPattern(trimmed);
  if (canonical.startsWith(".")) return `*${canonical}`;
  return canonical;
}

/**
 * True when `entry` (a normalized allow pattern, possibly `*.suffix`) overlaps
 * `denied` (same forms) in either direction. The sandbox network policy can
 * only express an allow list, so any allow entry a deny covers — or that
 * covers a deny — must be dropped rather than granted (fail closed).
 */
function overlapsDeny(entry: string, denied: string[]): boolean {
  // Compare bare hostnames: strip the wildcard prefix AND any :port
  // qualifier, so "evil.example.com:443" cannot dodge a deny on
  // "evil.example.com".
  const bare = (p: string) =>
    (p.startsWith("*.") ? p.slice(2) : p).replace(/:\d+$/, "");
  const isWild = (p: string) => p.startsWith("*.");
  const covers = (pattern: string, host: string) =>
    isWild(pattern)
      ? host === bare(pattern) || host.endsWith(`.${bare(pattern)}`)
      : host === pattern;
  return denied.some(
    (deny) =>
      covers(deny, bare(entry)) ||
      covers(entry, bare(deny)) ||
      bare(deny) === bare(entry)
  );
}

function networkPolicyFromDomains(
  value: unknown,
  deniedValue?: unknown
): NetworkPolicy {
  if (!Array.isArray(value)) return "deny-all";
  const normalize = (input: unknown) =>
    (Array.isArray(input) ? input : [])
      .filter((entry): entry is string => typeof entry === "string")
      .map(normalizeAllowedDomain)
      .filter((entry): entry is string => !!entry);
  const domains = normalize(value);
  const denied = normalize(deniedValue);
  if (domains.includes("*") && denied.length === 0) return "allow-all";
  // The provider policy has no deny primitive, so denies are enforced by
  // subtraction: drop "*" (an unbounded allow can't honor exclusions) and
  // any allow entry that overlaps a denied pattern.
  const allowed = domains.filter(
    (entry) => entry !== "*" && !overlapsDeny(entry, denied)
  );
  return allowed.length > 0
    ? { allow: Array.from(new Set(allowed)) }
    : "deny-all";
}

/**
 * Normalize a provider SDK throw into a {@link RuntimeInfrastructureError}.
 *
 * The Vercel SDK raises an `APIError` whose message is literally
 * `Status code ${status} is not ok` and which carries a `response`. Its own
 * retry gives up when the upstream `Retry-After` exceeds its ceiling, so a
 * sustained 429 reaches us unretried. Reading the status off the error keeps the
 * route from having to recover it by matching that message text.
 */
function asRuntimeInfrastructureError(
  error: unknown,
  stage: string
): RuntimeInfrastructureError {
  if (error instanceof RuntimeInfrastructureError) return error;
  const candidate = error as
    | { response?: { status?: unknown }; status?: unknown }
    | undefined;
  const raw = candidate?.response?.status ?? candidate?.status;
  const status = typeof raw === "number" ? raw : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  return new RuntimeInfrastructureError(
    `Sandbox runtime failed to ${stage}: ${detail}`,
    { status, cause: error }
  );
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
export const __testOnly = { networkPolicyFromDomains };

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
    const networkPolicy = networkPolicyFromDomains(
      ctx.allowedDomains,
      ctx.deniedDomains
    );
    // Provisioning happens before the agent's command exists, so ANY failure
    // here is the runtime's, never the command's. Wrapped so the route reports
    // it as an infrastructure fault carrying the real upstream status instead of
    // flattening it to a 500 and handing the agent a failed-command signal.
    let sandbox: Sandbox;
    try {
      sandbox = await getSandbox({
        name: sandboxName,
        networkPolicy,
        credentials: ctx.credentials.values,
      });
    } catch (error) {
      throw asRuntimeInfrastructureError(error, "provision sandbox");
    }

    // The working directory is created by the command itself, not by a separate
    // `sandbox.fs.mkdir()`. The SDK implements the recursive branch as a real
    // command execution (`runCommand("mkdir", ["-p", …])`), so a standalone call
    // DOUBLED the command-API rate for every command — including ones that touch
    // no filesystem at all. Sustained, that trips Vercel's rate limit, and the
    // resulting 429 arrives as a failure of the agent's own command: a bare
    // `echo hello > /tmp/x` reported "Status code 429 is not ok", so the agent
    // rewrote a correct command and retried into an already-throttled endpoint.
    //
    // `cd` after `mkdir -p` rather than passing `cwd`, so the directory exists
    // before the shell enters it, in one execution instead of two.
    const cwd = remoteCwd(ctx.cwd, ctx.workspaceDir, REMOTE_WORKSPACE_DIR);
    // Only the TRANSPORT is wrapped. A non-zero exitCode from the agent's own
    // command is a normal result and must keep flowing through untouched — the
    // point of the distinction is that a throttled provider no longer looks
    // like one.
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      const result = await sandbox.runCommand({
        cmd: "/bin/bash",
        args: [
          "-lc",
          `mkdir -p ${shellQuote(cwd)} && cd ${shellQuote(cwd)} && ${ctx.command}`,
        ],
        env: ctx.env,
        timeoutMs: ctx.timeoutMs,
      });
      [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      exitCode = result.exitCode;
    } catch (error) {
      throw asRuntimeInfrastructureError(error, "run command");
    }

    return {
      stdout,
      stderr,
      exitCode,
      meta: {
        name: sandbox.name,
        persistent: sandbox.persistent,
        cwd: sandbox.cwd,
      },
    };
  },
};
