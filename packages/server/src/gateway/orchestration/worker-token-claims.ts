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
} {
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
  };
}
