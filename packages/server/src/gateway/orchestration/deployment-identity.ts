import { createHash } from "node:crypto";
import { generateWorkerToken, generateWorkerTokenPair } from "@lobu/core";
import type { DbClient, DbQuery } from "../../db/client.js";
import type { ModelProviderModule } from "../modules/module-system.js";
import { buildWorkerTokenClaims } from "./worker-token-claims.js";

/**
 * Detect base-URL env keys claimed by more than one provider with CONFLICTING
 * values. When agents merge every installed provider's proxy base-URL mappings,
 * two providers sharing a key (e.g. the old bug where every sdkCompat provider
 * emitted OPENAI_BASE_URL) means the later-merged one silently clobbers the
 * earlier and a request egresses to the wrong slug. Pure + exported so the guard
 * is testable independently of a full deploy. Order matches the merge:
 * last-write-wins, so `incoming` is what survives.
 */
export function detectProviderBaseUrlCollisions(
  perProvider: Array<{ providerId: string; mappings: Record<string, string> }>
): Array<{ key: string; providerId: string; existing: string; incoming: string }> {
  const seen: Record<string, string> = {};
  const collisions: Array<{
    key: string;
    providerId: string;
    existing: string;
    incoming: string;
  }> = [];
  for (const { providerId, mappings } of perProvider) {
    for (const [key, value] of Object.entries(mappings)) {
      const existing = seen[key];
      if (existing !== undefined && existing !== value) {
        collisions.push({ key, providerId, existing, incoming: value });
      }
      seen[key] = value;
    }
  }
  return collisions;
}

/**
 * Mint the deployment-lifetime WORKER_TOKEN. This is the FALLBACK gateway auth
 * the worker uses when no per-run runJobToken was minted (`session-runner`:
 * `runJobToken || WORKER_TOKEN`). Extracted (mirrors message-consumer's
 * `buildRunJobToken`) so both primary-auth mints share a tested claim-parity
 * surface — the #1274 P0 was an omitted-claim divergence between exactly these
 * two mints. Every claim a downstream consumer reads off the verified worker
 * token MUST be set on BOTH mints, or a worker that lands on this fallback path
 * loses it (e.g. headless `source` → owner-gated card dead-letters).
 */
export function buildDeploymentWorkerToken(args: {
  userId: string;
  conversationId: string;
  deploymentName: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
  platform?: string;
  platformMetadata?: Record<string, unknown>;
  traceId?: string;
  /** Resolved runtime provider + sandbox, so the deployment-lifetime token
   *  also carries the claim the runtime route reads (parity with the per-run mint). */
  runtimeProviderId?: string;
  sandboxId?: string;
  /** Resolved egress allowlist for a remote runtime sandbox (signed claim). */
  allowedDomains?: string[];
  /** Resolved egress denylist for a remote runtime sandbox (signed claim). */
  deniedDomains?: string[];
  /** Resolved nix package set for a remote runtime sandbox (signed claim). */
  nixPackages?: string[];
}): string {
  return generateWorkerToken(
    args.userId,
    args.conversationId,
    args.deploymentName,
    buildDeploymentTokenOptions(args)
  );
}

function buildDeploymentTokenOptions(
  args: Parameters<typeof buildDeploymentWorkerToken>[0]
) {
  return {
    // Shared routing claims — kept in lockstep with the per-run mint via
    // `buildWorkerTokenClaims` so a worker that falls back to this
    // deployment-lifetime token carries the same connectionId/source and
    // doesn't dead-letter its interaction cards (#1274).
    ...buildWorkerTokenClaims(args),
    // Deployment-token-specific claim.
    traceId: args.traceId,
  };
}

export function buildDeploymentTokenPair(
  args: Parameters<typeof buildDeploymentWorkerToken>[0]
): { workerToken: string; egressProxyToken: string } {
  return generateWorkerTokenPair(
    args.userId,
    args.conversationId,
    args.deploymentName,
    buildDeploymentTokenOptions(args)
  );
}

export interface DeploymentIdentity {
  conversationId: string;
  channelId?: string;
  platform?: string;
  userId?: string;
  agentId: string;
  organizationId: string;
}

/**
 * Build a canonical conversation identity key for runtime routing.
 * Preferred format: organizationId:agentId:platform:channelId:conversationId
 */
export function buildCanonicalConversationKey(
  identity: DeploymentIdentity
): string {
  const { organizationId, agentId, conversationId, channelId, platform } =
    identity;
  const scope = `${organizationId}:${agentId}`;
  if (platform && channelId) {
    return `${scope}:${platform}:${channelId}:${conversationId}`;
  }
  if (channelId) {
    return `${scope}:${channelId}:${conversationId}`;
  }
  return `${scope}:${conversationId}`;
}

/**
 * Generate a consistent worker runtime ID from canonical conversation identity.
 * Runtime IDs stay lowercase alphanumeric with hyphens for filesystem and
 * process-manager compatibility.
 */
export function generateDeploymentName(identity: DeploymentIdentity): string {
  const canonicalKey = buildCanonicalConversationKey(identity);
  const rawHint = (identity.platform || identity.userId || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const hint = (rawHint.slice(0, 8) || "ctx").toLowerCase();
  const hash = createHash("sha256")
    .update(canonicalKey)
    .digest("hex")
    .slice(0, 12);
  return `lobu-worker-${hint}-${hash}`;
}

/** Queue name prefix a per-deployment worker listens on. */
export const THREAD_MESSAGE_QUEUE_PREFIX = "thread_message_";

/**
 * Who a linked chat_message child was enqueued for, as its `action_input`
 * recorded it.
 *
 * Three sweeps read this shape off `runs` -- the dead-letter path, the
 * expired-child path, and the parent-terminalization cascade -- and each one
 * feeds it straight back into {@link deploymentNameForLinkedChild}. A column
 * this type omits is a deployment name that silently comes out wrong, so the
 * type, the projection that fills it, and the name derived from it are
 * declared together here instead of spelled out per call site.
 */
export interface LinkedChildIdentity {
  message_id: string | null;
  agent_id: string | null;
  user_id: string | null;
  conversation_id: string | null;
  channel_id: string | null;
  platform: string | null;
}

/**
 * The `action_input` projection that populates a {@link LinkedChildIdentity}.
 *
 * Takes the executing client because a fragment is bound by the statement it
 * is nested into: build it with `tx` inside a transaction and `sql` outside,
 * or the parameters land on the wrong connection.
 */
export function linkedChildIdentityColumns(sql: DbClient): DbQuery {
  return sql`
    action_input->>'messageId' AS message_id,
    action_input->>'agentId' AS agent_id,
    action_input->>'userId' AS user_id,
    action_input->>'conversationId' AS conversation_id,
    action_input->>'channelId' AS channel_id,
    action_input->>'platform' AS platform
  `;
}

/**
 * The deployment a linked chat_message child run was dispatched to.
 *
 * A thread-message queue already carries the deployment in its own name; any
 * other child has to be re-derived from the identity its action_input recorded.
 * Returns "" when the row carries neither, which callers read as "no live turn
 * to act on".
 */
export function deploymentNameForLinkedChild(
  child: LinkedChildIdentity & { queue_name: string },
  organizationId: string
): string {
  if (child.queue_name.startsWith(THREAD_MESSAGE_QUEUE_PREFIX)) {
    return child.queue_name.slice(THREAD_MESSAGE_QUEUE_PREFIX.length);
  }
  if (!child.agent_id || !child.conversation_id) return "";
  return generateDeploymentName({
    organizationId,
    agentId: child.agent_id,
    userId: child.user_id ?? undefined,
    platform: child.platform ?? undefined,
    channelId: child.channel_id ?? undefined,
    conversationId: child.conversation_id,
  });
}

/** Check if an env var name looks like a secret (API key / token / secret / password). */
export function isSecretEnvVar(
  name: string,
  providerModules: ModelProviderModule[]
): boolean {
  for (const provider of providerModules) {
    if (provider.getSecretEnvVarNames().includes(name)) return true;
  }
  const upper = name.toUpperCase();
  return (
    upper.includes("_KEY") ||
    upper.includes("_TOKEN") ||
    upper.includes("_SECRET") ||
    upper.includes("_PASSWORD")
  );
}
