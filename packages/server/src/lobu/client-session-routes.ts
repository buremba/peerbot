import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { getDb } from "../db/client";
import type { Env } from "../index";

/** Recent org-wide MCP session activity derived from tool-invocation audits. */
const routes = new Hono<{ Bindings: Env }>();

const ACTIVITY_WINDOW_DAYS = 14;

interface SessionRow {
	session_id: string;
	client_id: string | null;
	client_name: string | null;
	user_id: string | null;
	agent_id: string | null;
	first_call_at: Date;
	last_call_at: Date;
	call_count: string;
	failed_count: string;
	tools: string[] | null;
	pending_interaction_count: string;
}

routes.get("/", mcpAuth, async (c) => {
	const organizationId = c.get("organizationId") as string | undefined;
	if (!organizationId) {
		return c.json({ error: "Organization required" }, 401);
	}
	const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10);
	const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1), 100);

	const sql = getDb();
	const rows = (await sql`
		WITH session_calls AS (
			SELECT
				e.metadata->>'mcp_session_id' AS session_id,
				e.client_id,
				e.created_by,
				e.metadata->>'agent_id' AS agent_id,
				e.payload_data->>'tool_name' AS tool_name,
				(e.payload_data->>'success')::boolean AS success,
				e.occurred_at
			FROM events e
			WHERE e.organization_id = ${organizationId}
				AND e.semantic_type = 'audit'
				AND e.origin_type = 'tool_invocation'
				AND e.metadata->>'mcp_session_id' IS NOT NULL
				AND e.occurred_at > now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS})
		),
		sessions AS (
			SELECT
				session_id,
				max(client_id) AS client_id,
				max(created_by) AS user_id,
				max(agent_id) AS agent_id,
				min(occurred_at) AS first_call_at,
				max(occurred_at) AS last_call_at,
				count(*) AS call_count,
				count(*) FILTER (WHERE success IS NOT TRUE) AS failed_count,
				-- to_jsonb: raw text[] arrives as an unparsed "{a,b}" string under
				-- the prod fetch_types:false client options; jsonb parses cleanly.
				to_jsonb((array_agg(DISTINCT tool_name ORDER BY tool_name))[1:8]) AS tools
			FROM session_calls
			GROUP BY session_id
		),
		pending_interactions AS (
			SELECT
				a.metadata->>'mcp_session_id' AS session_id,
				count(*) AS pending_interaction_count
			FROM current_event_records a
			WHERE a.organization_id = ${organizationId}
				AND a.interaction_type <> 'none'
				AND a.interaction_status = 'pending'
				AND a.metadata->>'mcp_session_id' IS NOT NULL
			GROUP BY a.metadata->>'mcp_session_id'
		)
		SELECT
			s.*,
			oc.client_name,
			coalesce(pi.pending_interaction_count, 0) AS pending_interaction_count
		FROM sessions s
		LEFT JOIN oauth_clients oc ON oc.id = s.client_id
		LEFT JOIN pending_interactions pi ON pi.session_id = s.session_id
		ORDER BY last_call_at DESC
		LIMIT ${limit}
	`) as unknown as SessionRow[];

	return c.json({
		sessions: rows.map((row) => ({
			sessionId: row.session_id,
			clientId: row.client_id,
			clientName: row.client_name,
			userId: row.user_id,
			agentId: row.agent_id,
			firstCallAt: new Date(row.first_call_at).getTime(),
			lastCallAt: new Date(row.last_call_at).getTime(),
			callCount: Number(row.call_count),
			failedCount: Number(row.failed_count),
			tools: row.tools ?? [],
			pendingInteractionCount: Number(row.pending_interaction_count),
		})),
	});
});

export const clientSessionRoutes = routes;
