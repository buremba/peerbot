import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { getDb } from "../db/client";
import type { Env } from "../index";

const routes = new Hono<{ Bindings: Env }>();
const ACTIVITY_WINDOW_DAYS = 14;

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
	const sql = getDb();
	const rows = await sql<SessionRow>`
    SELECT mc.conversation_id, mc.client_id, oc.client_name, mc.user_id, mc.agent_id,
      mc.title, mc.last_action, mc.first_activity_at, mc.last_activity_at,
      mc.call_count, mc.failed_count, mc.tools,
      COALESCE((SELECT count(*)::integer FROM current_event_records a
        WHERE a.organization_id = mc.organization_id
          AND a.interaction_type <> 'none' AND a.interaction_status = 'pending'
          AND a.metadata->>'mcp_session_id' = mc.transport_session_id), 0)::integer
        AS pending_interaction_count
    FROM public.mcp_client_conversations mc
    LEFT JOIN oauth_clients oc ON oc.id = mc.client_id
    WHERE mc.organization_id = ${organizationId}
      AND mc.last_activity_at > now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS})
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
