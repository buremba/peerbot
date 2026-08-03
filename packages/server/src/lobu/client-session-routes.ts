import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { getDb } from "../db/client";
import type { Env } from "../index";

/**
 * Recent org-wide MCP client conversations. The per-conversation counts, tools
 * and labels are read straight off the `mcp_client_conversations` row
 * materialized at tool-call time, rather than aggregated out of `events` per
 * request. The one remaining aggregate is the pending-interaction count — see
 * the note on its CTE below.
 */
const routes = new Hono<{ Bindings: Env }>();
const ACTIVITY_WINDOW_DAYS = 14;
const LOBU_COMMAND_CLIENT_SOFTWARE_ID = "lobu-cli";

interface SessionRow {
	conversation_id: string;
	client_id: string | null;
	client_name: string | null;
	user_id: string | null;
	agent_id: string | null;
	title: string | null;
	last_action: string;
	first_activity_at: Date;
	last_activity_at: Date;
	call_count: number | string;
	failed_count: number | string;
	tools: unknown;
	pending_interaction_count: number;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function displayAction(value: string): string {
	if (!value.includes("_")) return value;
	return value
		.split("_")
		.filter(Boolean)
		.map((part) => {
			const lower = part.toLowerCase();
			if (["sdk", "sql", "mcp"].includes(lower)) return lower.toUpperCase();
			return lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join(" ");
}

routes.get("/", mcpAuth, async (c) => {
	const organizationId = c.get("organizationId") as string | undefined;
	if (!organizationId) return c.json({ error: "Organization required" }, 401);
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
	const limit = Math.min(
		Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1),
		100,
	);
	const conversationOnly = c.req.query("conversation_only") === "true";
	const sql = getDb();
	const rows = await sql<SessionRow>`
    -- The one aggregate left on this path. It groups the org's LIVE
    -- pending-interaction working set — rows leave it as soon as they resolve —
    -- not append-only history, so it stays bounded as events grows. Kept as a
    -- CTE rather than a correlated subquery so it is evaluated once, not once
    -- per returned conversation, and served by the partial index
    -- events_pending_interaction_mcp_session so the scan touches only rows that
    -- are still pending.
    WITH pending_interactions AS (
      SELECT mc.client_identity, mc.conversation_id,
        count(*)::integer AS pending_interaction_count
      FROM current_event_records a
      JOIN public.mcp_client_conversations mc
        ON mc.organization_id = a.organization_id
        AND mc.transport_session_ids ? (a.metadata->>'mcp_session_id')
      WHERE a.organization_id = ${organizationId}
        AND a.interaction_type <> 'none'
        AND a.interaction_status = 'pending'
        AND a.metadata->>'mcp_session_id' IS NOT NULL
        AND mc.last_activity_at > now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS})
      GROUP BY mc.client_identity, mc.conversation_id
    )
    SELECT mc.conversation_id, mc.client_id, oc.client_name, mc.user_id, mc.agent_id,
      mc.title, mc.last_action, mc.first_activity_at, mc.last_activity_at,
      mc.call_count, mc.failed_count,
      jsonb_path_query_array(mc.tools, '$[0 to 7]') AS tools,
      COALESCE(pi.pending_interaction_count, 0)::integer AS pending_interaction_count
    FROM public.mcp_client_conversations mc
    LEFT JOIN oauth_clients oc ON oc.id = mc.client_id
    LEFT JOIN pending_interactions pi
      ON pi.client_identity = mc.client_identity AND pi.conversation_id = mc.conversation_id
    WHERE mc.organization_id = ${organizationId}
      -- Title-only rows are not activity: setTitle can create a row before the
      -- conversation has called any tool, and it would otherwise sort first on
      -- its default now() timestamps with a placeholder action.
      AND mc.call_count > 0
      AND mc.last_activity_at > now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS})
      AND (
        NOT ${conversationOnly}
        OR mc.client_software_id IS DISTINCT FROM ${LOBU_COMMAND_CLIENT_SOFTWARE_ID}
      )
    ORDER BY mc.last_activity_at DESC LIMIT ${limit}
  `;
	return c.json({
		sessions: rows.map((row) => ({
			sessionId: row.conversation_id,
			clientId: row.client_id,
			clientName: row.client_name,
			userId: row.user_id,
			agentId: row.agent_id,
			title: row.title,
			lastAction: displayAction(row.last_action),
			firstCallAt: new Date(row.first_activity_at).getTime(),
			lastCallAt: new Date(row.last_activity_at).getTime(),
			callCount: Number(row.call_count),
			failedCount: Number(row.failed_count),
			tools: stringArray(row.tools),
			pendingInteractionCount: Number(row.pending_interaction_count),
		})),
	});
});

export const clientSessionRoutes = routes;
