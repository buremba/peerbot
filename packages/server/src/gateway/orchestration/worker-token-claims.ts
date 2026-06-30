/**
 * Shared claim extraction for the two worker-token mints — the per-run
 * `runJobToken` (message-consumer) and the deployment-lifetime `WORKER_TOKEN`
 * (deployment-manager). Both read the SAME routing claims off the message;
 * the #1274 P0 was an omitted-claim divergence between exactly these two mints
 * (the per-run mint dropped `connectionId`, so every chat `ask_user` 500'd at
 * `assertRoutableInteraction`).
 *
 * Keeping the common bag here makes that parity invariant structural: any
 * routing claim a downstream consumer reads off the verified token
 * (channelId, teamId, platform, agentId, organizationId, connectionId, source)
 * is set in ONE place for both mints. Mint-specific claims (runId+messageId for
 * the per-run token, traceId for the deployment token) stay with each caller.
 */
export interface WorkerTokenClaimsArgs {
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
  platform?: string;
  platformMetadata?: Record<string, unknown>;
  /**
   * Selected runtime provider for this agent, resolved from its environment by
   * the caller (which has the agent settings + environments store). When
   * omitted, falls back to the deployment-wide `LOBU_RUNTIME_PROVIDER` (self-
   * host / org default). The generic runtime route reads this claim to pick a
   * provider — see WorkerTokenData.runtimeProviderId.
   */
  runtimeProviderId?: string;
  /** The `environments.id` whose vault credential backs the provider above. */
  environmentId?: string;
  /**
   * True when the agent has an explicit runtime selection (a provider or
   * builtin). When true, the env-var fallback below is suppressed so an agent
   * pinned to builtin doesn't inherit the deployment-wide LOBU_RUNTIME_PROVIDER.
   */
  runtimeExplicit?: boolean;
}

/**
 * The routing claims common to both worker-token mints, in the exact shape the
 * `generateWorkerToken` options object expects. `connectionId` and `source` are
 * lifted off `platformMetadata` (string-guarded — both default to `undefined`
 * when absent or non-string).
 *
 * `connectionId`: PRIMARY/fallback auth must carry it or interaction posts
 * (ask_user / tool approval / link button) hit `assertRoutableInteraction`,
 * which rejects a chat-platform interaction with no connectionId (#1274).
 *
 * `source`: headless run origin — interaction cards from this turn are stamped
 * headless and skip the SSE-owner gate (no browser SSE exists on any pod for a
 * headless run, so an owner-gated card would dead-letter).
 */
export function buildWorkerTokenClaims(args: WorkerTokenClaimsArgs): {
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
  platform?: string;
  connectionId?: string;
  source?: string;
  runtimeProviderId?: string;
  environmentId?: string;
} {
  // Per-agent environment selection wins; otherwise the deployment-wide
  // selector covers self-host / org-default — UNLESS the agent made an explicit
  // selection (e.g. pinned to builtin), in which case we honor it and skip the
  // env-var fallback. Resolving here keeps both mints in lockstep.
  const runtimeProviderId =
    args.runtimeProviderId ??
    (args.runtimeExplicit
      ? undefined
      : process.env.LOBU_RUNTIME_PROVIDER?.trim() || undefined);
  return {
    channelId: args.channelId,
    teamId: args.teamId,
    agentId: args.agentId,
    organizationId: args.organizationId,
    platform: args.platform,
    connectionId:
      typeof args.platformMetadata?.connectionId === "string"
        ? args.platformMetadata.connectionId
        : undefined,
    source:
      typeof args.platformMetadata?.source === "string"
        ? args.platformMetadata.source
        : undefined,
    runtimeProviderId,
    // Only meaningful when a per-agent environment drove the selection; the
    // env-var fallback has no environment row, so credentials resolve from
    // system env.
    environmentId: runtimeProviderId ? args.environmentId : undefined,
  };
}
