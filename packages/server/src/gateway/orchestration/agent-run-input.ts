import {
  generateWorkerToken,
  type MessagePayload,
  verifyWorkerToken,
  type WorkerTokenData,
} from "@lobu/core";
import { getDb, pgTextArray, type DbClient } from "../../db/client.js";

export type DurableRunTokenClaims = Omit<
  WorkerTokenData,
  "timestamp" | "jti"
>;

export interface PendingAgentRunInput {
  payload: MessagePayload;
  tokenClaims: DurableRunTokenClaims;
}

function durableClaims(token: WorkerTokenData): DurableRunTokenClaims {
  return {
    userId: token.userId,
    conversationId: token.conversationId,
    channelId: token.channelId,
    teamId: token.teamId,
    agentId: token.agentId,
    organizationId: token.organizationId,
    connectionId: token.connectionId,
    deploymentName: token.deploymentName,
    platform: token.platform,
    source: token.source,
    sessionKey: token.sessionKey,
    traceId: token.traceId,
    runId: token.runId,
    messageId: token.messageId,
    adminTools: token.adminTools,
    runtimeProviderId: token.runtimeProviderId,
    environmentId: token.environmentId,
    allowedDomains: token.allowedDomains,
  };
}

function assertTokenMatchesInput(
  token: WorkerTokenData,
  payload: MessagePayload,
  deploymentName: string,
): void {
  const matches =
    token.userId === payload.userId &&
    token.conversationId === payload.conversationId &&
    token.channelId === payload.channelId &&
    token.agentId === payload.agentId &&
    token.organizationId === payload.organizationId &&
    token.deploymentName === deploymentName &&
    token.runId === payload.runId &&
    token.messageId === payload.messageId;
  if (!matches) {
    throw new Error("Durable agent input token scope does not match payload");
  }
}

export function attachFreshRunJobToken(
  input: PendingAgentRunInput,
): MessagePayload {
  const token = input.tokenClaims;
  if (
    !token.channelId ||
    !token.runId ||
    !token.messageId ||
    token.runId !== input.payload.runId ||
    token.messageId !== input.payload.messageId
  ) {
    throw new Error("Durable agent input has invalid run token claims");
  }
  return {
    ...input.payload,
    runJobToken: generateWorkerToken(
      token.userId,
      token.conversationId,
      token.deploymentName,
      {
        channelId: token.channelId,
        teamId: token.teamId,
        agentId: token.agentId,
        organizationId: token.organizationId,
        connectionId: token.connectionId,
        platform: token.platform,
        source: token.source,
        // Carry the trusted origin through a token refresh — else a re-minted
        // token would drop the claim and the worker would fail-close to `agent`,
        // silently disabling human-gated actions mid-conversation.
        origin: token.origin,
        sessionKey: token.sessionKey,
        traceId: token.traceId,
        runId: token.runId,
        messageId: token.messageId,
        adminTools: token.adminTools,
        runtimeProviderId: token.runtimeProviderId,
        environmentId: token.environmentId,
        allowedDomains: token.allowedDomains,
      },
    ),
  };
}

export async function recordAgentRunInput(
  payload: MessagePayload,
  deploymentName: string,
): Promise<void> {
  if (!payload.organizationId || typeof payload.runId !== "number") {
    throw new Error("Durable agent input requires organizationId and runId");
  }
  if (!payload.runJobToken) {
    throw new Error("Durable agent input requires a per-run token");
  }
  const token = verifyWorkerToken(payload.runJobToken);
  if (!token) {
    throw new Error("Durable agent input requires a valid per-run token");
  }
  assertTokenMatchesInput(token, payload, deploymentName);
  const storedPayload = { ...payload };
  delete storedPayload.runJobToken;
  const tokenClaims = durableClaims(token);
  const sql = getDb();
  await sql`
    INSERT INTO public.agent_run_input (
      organization_id, message_id, agent_id, conversation_id,
      deployment_name, run_id, payload, token_claims
    ) VALUES (
      ${payload.organizationId}, ${payload.messageId}, ${payload.agentId},
      ${payload.conversationId}, ${deploymentName}, ${payload.runId},
      ${sql.json(storedPayload as unknown as Record<string, unknown>)},
      ${sql.json(tokenClaims as unknown as Record<string, unknown>)}
    )
    ON CONFLICT (organization_id, deployment_name, message_id) DO UPDATE SET
      payload = EXCLUDED.payload,
      token_claims = EXCLUDED.token_claims,
      run_id = EXCLUDED.run_id
    WHERE agent_run_input.status = 'pending'
  `;
}

export async function listPendingAgentRunInputs(
  deploymentName: string,
): Promise<PendingAgentRunInput[]> {
  const sql = getDb();
  const rows = await sql<{
    payload: MessagePayload;
    token_claims: DurableRunTokenClaims;
  }>`
    SELECT input.payload, input.token_claims
    FROM public.agent_run_input input
    WHERE input.deployment_name = ${deploymentName}
      AND input.status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM public.runs marker
        WHERE marker.status = 'pending'
          AND marker.run_type = 'internal'
          AND marker.queue_name = 'internal:turn_timeout'
          AND marker.action_input->>'deploymentName' = input.deployment_name
          AND marker.action_input->>'messageId' = input.message_id
          AND marker.run_at > now()
      )
    ORDER BY input.created_at, input.message_id
  `;
  return rows.map((row) => ({
    payload: row.payload,
    tokenClaims: row.token_claims,
  }));
}

export async function completeAgentRunInputs(
  tx: DbClient,
  organizationId: string | null,
  deploymentName: string,
  messageIds: readonly string[],
): Promise<void> {
  if (!organizationId || messageIds.length === 0) return;
  await tx`
    UPDATE public.agent_run_input
    SET status = 'completed', completed_at = now()
    WHERE organization_id = ${organizationId}
      AND deployment_name = ${deploymentName}
      AND message_id = ANY(${pgTextArray([...messageIds])}::text[])
      AND status = 'pending'
  `;
}
