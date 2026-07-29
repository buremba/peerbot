import { createHash } from "node:crypto";
import { normalizeDomainPattern } from "@lobu/core";
import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import { remoteCwd } from "../workspace.js";
import {
  RuntimeInfrastructureError,
  type RuntimeExecutionOutcome,
} from "../types.js";
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
 * The SDK's `APIError` carries the status on `response` and repeats it in the
 * message text; its own retry gives up when `Retry-After` exceeds its ceiling,
 * so a sustained 429 arrives here unretried. Reading the status off the error
 * avoids recovering it by matching that message.
 */
function asRuntimeInfrastructureError(
  error: unknown,
  stage: string,
  outcome: RuntimeExecutionOutcome
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
    { status, outcome, cause: error }
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
    // here is the runtime's, never the command's.
    let sandbox: Sandbox;
    try {
      sandbox = await getSandbox({
        name: sandboxName,
        networkPolicy,
        credentials: ctx.credentials.values,
      });
    } catch (error) {
      throw asRuntimeInfrastructureError(error, "provision sandbox", "not_started");
    }

    // The cwd is created by the command itself rather than by a separate
    // `sandbox.fs.mkdir()`: the SDK implements its recursive branch as a real
    // command execution, so a standalone call doubled the command-API rate for
    // every command — including ones touching no filesystem — and trips the
    // provider's rate limit. `mkdir -p` then `cd` gives the same guarantee in
    // one execution.
    const cwd = remoteCwd(ctx.cwd, ctx.workspaceDir, REMOTE_WORKSPACE_DIR);
    // Only the TRANSPORT is wrapped: a non-zero exitCode from the agent's own
    // command is a normal result and must flow through untouched.
    let result: Awaited<ReturnType<Sandbox["runCommand"]>>;
    try {
      result = await sandbox.runCommand({
        cmd: "/bin/bash",
        // The cwd and the command are POSITIONAL ARGUMENTS, never interpolated
        // into the script. Textual prepending changed shell semantics: `&&`
        // binds tighter than `&`, so `sleep 0 & pwd` backgrounded the cwd setup
        // and ran `pwd` in the default directory, and a comment-only command
        // turned the trailing `&&` into a syntax error. `eval "$2"` runs the
        // submitted command as its own program, so its parse is unchanged.
        args: [
          "-lc",
          'mkdir -p -- "$1" && cd -- "$1" && eval "$2"',
          "lobu-exec",
          cwd,
          ctx.command,
        ],
        env: ctx.env,
        timeoutMs: ctx.timeoutMs,
      });
    } catch (error) {
      // Dispatch rejected. The SDK can reject after the command has started, so
      // this is "unknown", not "not_started" — retryable, but not a promise that
      // nothing happened.
      throw asRuntimeInfrastructureError(error, "run command", "unknown");
    }

    // Fetching the logs is a SEPARATE call, and by this point the command has
    // already executed. A failure here must never be reported as "your command
    // did not run" with a retry hint — re-running a command that already
    // succeeded duplicates its side effects (a POST sent twice, a file appended
    // twice). Report it as non-retryable and say the outcome is unknown.
    let stdout: string;
    let stderr: string;
    try {
      [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RuntimeInfrastructureError(
        `Sandbox runtime ran the command but could not retrieve its output: ${detail}. The command MAY have completed — do not assume it needs re-running.`,
        { retryable: false, outcome: "completed", cause: error }
      );
    }
    const exitCode = result.exitCode;

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
