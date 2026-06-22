/**
 * Postgres-backed `pending-tool:<requestId>` store. Backed by the
 * `oauth_states` table with a `pending-tool` scope so the MCP proxy
 * (writer) and the interaction bridge / CLI gateway (reader) can hand off
 * blocked-tool invocations through a single primitive.
 */

import { getDb } from "../../../db/client.js";

const SCOPE = "pending-tool";

export interface PendingToolInvocation {
  mcpId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  userId: string;
	organizationId: string;
  channelId?: string;
  conversationId?: string;
  teamId?: string;
  connectionId?: string;
}

export async function storePendingTool(
  requestId: string,
  invocation: PendingToolInvocation,
	ttlSeconds: number,
): Promise<void> {
  const sql = getDb();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await sql`
    INSERT INTO oauth_states (id, scope, payload, expires_at)
    VALUES (${requestId}, ${SCOPE}, ${sql.json(invocation as object)}, ${expiresAt})
    ON CONFLICT (id) DO UPDATE SET
      scope = EXCLUDED.scope,
      payload = EXCLUDED.payload,
      expires_at = EXCLUDED.expires_at
  `;
}

/**
 * Read (without consuming) the unresolved pending-tool invocations for a
 * conversation. The live `tool-approval` SSE card is one-shot, so without this
 * a pending approval vanishes from the web UI on reload. The SPA fetches this
 * on load and replays open approvals as approval cards; resolution stays
 * claim-and-delete via `takePendingTool`, so a row surfaced here disappears the
 * moment the user approves/denies and never replays.
 *
 * `organizationId` is REQUIRED — it MUST be the caller's AUTHORIZED org
 * (resolved by the route's authorizeAgentAccess) and always scopes the read so a
 * row can never cross tenants, defense-in-depth on top of the conversationId
 * key. The route returns 403 when no org resolves rather than ever issuing an
 * unscoped read.
 */
export async function listPendingToolsForConversation(
	conversationId: string,
	organizationId: string,
): Promise<Array<PendingToolInvocation & { requestId: string }>> {
	const sql = getDb();
	const rows = await sql`
    SELECT id, payload
    FROM oauth_states
    WHERE scope = ${SCOPE}
      AND expires_at > now()
      AND payload->>'conversationId' = ${conversationId}
      AND payload->>'organizationId' = ${organizationId}
    ORDER BY expires_at ASC
  `;
	return rows.map((r) => {
		const row = r as { id: string; payload: PendingToolInvocation };
		return { ...row.payload, requestId: row.id };
	});
}

/**
 * Atomically fetch and delete a pending tool invocation. Used by the
 * interaction bridge / CLI approve handler to claim the row exactly
 * once — Slack/Telegram webhook retries that arrive after the first
 * click see null and no-op.
 */
export async function takePendingTool(
	requestId: string,
): Promise<PendingToolInvocation | null> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM oauth_states
    WHERE id = ${requestId}
      AND scope = ${SCOPE}
      AND expires_at > now()
    RETURNING payload
  `;
  if (rows.length === 0) return null;
	return (rows[0] as { payload: PendingToolInvocation }).payload ?? null;
}
