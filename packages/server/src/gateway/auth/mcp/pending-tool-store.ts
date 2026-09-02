/**
 * Postgres-backed `pending-tool:<requestId>` store. Backed by the
 * `oauth_states` table with a `pending-tool` scope so the MCP proxy
 * (writer) and the interaction bridge / CLI gateway (reader) can hand off
 * blocked-tool invocations through a single primitive.
 */

import { getDb } from "../../../db/client.js";
import { AUTOMATION_RUN_TYPES_PG } from "../../../runs/run-types.js";

const SCOPE = "pending-tool";

interface PendingToolInvocationFields {
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
  platform?: string;
  source?: string;
  deploymentName?: string;
}

/**
 * The signed per-turn admin-tool allowlist and the canonical Lobu actor it is
 * bound to, preserved across approval resume. Modeled as a PAIR, not two
 * independent optional fields: the resumed call mints a worker token carrying
 * this allowlist, so an allowlist with no verified actor must never be
 * constructible or round-trippable as valid.
 */
export type PendingAdminGrant =
  | { adminTools: string[]; adminActorUserId: string }
  | { adminTools?: undefined; adminActorUserId?: undefined };

export type PendingToolInvocation = PendingToolInvocationFields &
  PendingAdminGrant;

/**
 * Fail closed on an unpaired admin grant: drop the tier entirely rather than
 * defaulting an actor. A legacy or tampered payload carrying an allowlist with
 * no actor (or an actor with no allowlist) resumes as a plain, non-admin call.
 */
export function pairAdminGrant(
  adminTools: string[] | undefined,
  adminActorUserId: string | undefined,
): PendingAdminGrant {
  if (!adminTools?.length || !adminActorUserId) return {};
  return { adminTools, adminActorUserId };
}

function withPairedAdminGrant(
  payload: PendingToolInvocation,
): PendingToolInvocation {
  const { adminTools, adminActorUserId, ...rest } = payload;
  return { ...rest, ...pairAdminGrant(adminTools, adminActorUserId) };
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
 * claim-and-delete via `claimPendingTool`, so a row surfaced here disappears the
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
		return { ...withPairedAdminGrant(row.payload), requestId: row.id };
	});
}

/**
 * The conversation-id shape a headless Automation run uses
 * (`<agent>_automation_<id>_run_<id>`).
 *
 * A POSIX class rather than `\d` because Postgres's regex operator is the only
 * thing that reads it: the claim below both refuses these rows and reports the
 * refusal from one snapshot, so there is no second, hand-written JS copy left
 * to drift out of step with it.
 */
const AUTOMATION_RUN_CONVERSATION_PATTERN = "_automation_[0-9]+_run_[0-9]+$";

/**
 * The outcome of trying to claim a pending tool invocation.
 *
 * A refusal is discriminated rather than described so the caller that renders
 * it owns the wording, and this module stays free of user-facing copy.
 */
export type PendingToolClaim =
  | { ok: true; invocation: PendingToolInvocation }
  | { ok: false; reason: "missing" | "automation_headless" };

/**
 * Atomically claim a pending tool invocation, or say why it cannot be claimed.
 *
 * Used by the interaction bridge / CLI approve handler to claim the row exactly
 * once -- Slack/Telegram webhook retries arriving after the first click get
 * `missing` and no-op.
 *
 * One statement, not a read followed by a delete. The DELETE already refuses a
 * headless Automation row, so the peek that used to precede it existed only to
 * restate that same predicate as a JS regex in order to choose the error text.
 * Deciding the disposition alongside the DELETE keeps the rule in one place and
 * one round trip; a claimable row that comes back with no payload was simply
 * won by a concurrent caller, which is `missing`.
 */
export async function claimPendingTool(
  requestId: string,
): Promise<PendingToolClaim> {
  const sql = getDb();
  const rows = await sql`
    WITH candidate AS (
      SELECT id, payload
      FROM oauth_states
      WHERE id = ${requestId}
        AND scope = ${SCOPE}
        AND expires_at > now()
    ), claimed AS (
      DELETE FROM oauth_states
      USING candidate
      WHERE oauth_states.id = candidate.id
        AND COALESCE(candidate.payload->>'conversationId', '')
            !~ ${AUTOMATION_RUN_CONVERSATION_PATTERN}
      RETURNING oauth_states.payload
    )
    SELECT
      (SELECT payload FROM claimed) AS claimed_payload,
      CASE
        WHEN COALESCE(candidate.payload->>'conversationId', '')
             ~ ${AUTOMATION_RUN_CONVERSATION_PATTERN}
        THEN 'automation_headless'
        ELSE 'claimable'
      END AS disposition
    FROM candidate
  `;
  const row = rows[0] as
    | {
        claimed_payload: PendingToolInvocation | null;
        disposition: "automation_headless" | "claimable";
      }
    | undefined;
  if (!row) return { ok: false, reason: "missing" };
  if (row.disposition === "automation_headless") {
    return { ok: false, reason: "automation_headless" };
  }
  if (!row.claimed_payload) return { ok: false, reason: "missing" };
  return { ok: true, invocation: withPairedAdminGrant(row.claimed_payload) };
}

/** Active tool approvals belonging to this Automation run's agent session. */
export async function listPendingToolsForRun(
	runId: number,
	sql: ReturnType<typeof getDb>
): Promise<Array<{ mcpId: string; toolName: string }>> {
	const rows = await sql`
    SELECT DISTINCT
      pending.payload->>'mcpId' AS mcp_id,
      pending.payload->>'toolName' AS tool_name
    FROM oauth_states pending
    JOIN runs automation_run
      ON automation_run.id = ${runId}
     AND automation_run.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
    WHERE pending.scope = ${SCOPE}
      AND pending.expires_at > now()
      AND pending.payload->>'organizationId' = automation_run.organization_id
      AND right(
        pending.payload->>'conversationId',
        length(
          '_automation_' || automation_run.automation_id::text ||
          '_run_' || automation_run.id::text
        )
      ) = '_automation_' || automation_run.automation_id::text ||
          '_run_' || automation_run.id::text
    ORDER BY mcp_id, tool_name
  `;
	return rows
		.map((r) => r as { mcp_id: string | null; tool_name: string | null })
		.filter((r) => r.mcp_id && r.tool_name)
		.map((r) => ({ mcpId: r.mcp_id as string, toolName: r.tool_name as string }));
}
