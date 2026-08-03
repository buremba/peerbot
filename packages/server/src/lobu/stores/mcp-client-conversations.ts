import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { ToolContext } from "../../tools/registry.js";

const logger = createLogger("mcp-client-conversations");
const MAX_TITLE_LENGTH = 200;
const RUNNING_LEASE_SECONDS = 90;

export interface McpConversationActivityLease {
	generation: number;
}

function currentConversation(ctx: ToolContext) {
	const conversationId = (ctx.mcpConversationId ?? ctx.mcpSessionId)?.trim();
	if (!conversationId || conversationId.length > 512) return null;
	return { clientIdentity: ctx.clientId?.trim() || "", conversationId };
}

function oauthClientId(ctx: ToolContext): string | null {
	return ctx.tokenType === "oauth" ? (ctx.clientId ?? null) : null;
}

function transportSessionIds(ctx: ToolContext): string[] {
	const sessionId = ctx.mcpSessionId?.trim();
	return sessionId && sessionId.length <= 512 ? [sessionId] : [];
}

export function normalizeMcpConversationTitle(value: string): string {
	// Truncate by code point, not UTF-16 code unit: splitting an astral
	// character (an emoji) leaves a lone surrogate that cannot be encoded as
	// UTF-8, and the title write below would throw.
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return [...cleaned].slice(0, MAX_TITLE_LENGTH).join("");
}

export async function beginMcpConversationActivity(args: {
	ctx: ToolContext;
	toolName: string;
}): Promise<McpConversationActivityLease | null> {
	const identity = currentConversation(args.ctx);
	if (!identity) return null;
	try {
		const sql = getDb();
		const clientId = oauthClientId(args.ctx);
		const sessionIds = transportSessionIds(args.ctx);
		const [row] = await sql<{ running_generation: number | string }>`
      INSERT INTO public.mcp_client_conversations (
        organization_id, client_identity, conversation_id, transport_session_ids,
        client_id, user_id, agent_id, last_action, tools,
        active_call_count, running_generation, running_until
      ) VALUES (
        ${args.ctx.organizationId}, ${identity.clientIdentity}, ${identity.conversationId},
        ${sql.json(sessionIds)}, ${clientId}, ${args.ctx.userId ?? null},
        ${args.ctx.agentId ?? null}, ${args.toolName}, ${sql.json([args.toolName])},
        1, 1, now() + make_interval(secs => ${RUNNING_LEASE_SECONDS})
      )
      ON CONFLICT (organization_id, client_identity, conversation_id) DO UPDATE SET
        transport_session_ids = CASE
          WHEN jsonb_array_length(EXCLUDED.transport_session_ids) = 0
            OR public.mcp_client_conversations.transport_session_ids ? (EXCLUDED.transport_session_ids->>0)
          THEN public.mcp_client_conversations.transport_session_ids
          ELSE public.mcp_client_conversations.transport_session_ids || EXCLUDED.transport_session_ids END,
        client_id = COALESCE(EXCLUDED.client_id, public.mcp_client_conversations.client_id),
        user_id = COALESCE(EXCLUDED.user_id, public.mcp_client_conversations.user_id),
        agent_id = COALESCE(EXCLUDED.agent_id, public.mcp_client_conversations.agent_id),
        last_action = EXCLUDED.last_action,
        tools = CASE WHEN public.mcp_client_conversations.tools ? ${args.toolName}
          THEN public.mcp_client_conversations.tools
          ELSE public.mcp_client_conversations.tools || EXCLUDED.tools END,
        first_activity_at = CASE
          WHEN public.mcp_client_conversations.call_count = 0
            AND (public.mcp_client_conversations.active_call_count = 0
              OR public.mcp_client_conversations.running_until <= now())
          THEN now() ELSE public.mcp_client_conversations.first_activity_at END,
        active_call_count = CASE
          WHEN public.mcp_client_conversations.running_until IS NULL
            OR public.mcp_client_conversations.running_until <= now()
          THEN 1 ELSE public.mcp_client_conversations.active_call_count + 1 END,
        running_generation = CASE
          WHEN public.mcp_client_conversations.running_until IS NULL
            OR public.mcp_client_conversations.running_until <= now()
          THEN public.mcp_client_conversations.running_generation + 1
          ELSE public.mcp_client_conversations.running_generation END,
        running_until = now() + make_interval(secs => ${RUNNING_LEASE_SECONDS}),
        last_activity_at = now(), updated_at = now()
      RETURNING running_generation
    `;
		return { generation: Number(row.running_generation) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(
			{ err, toolName: args.toolName },
			`MCP conversation running state was not materialized: ${message}`,
		);
		return null;
	}
}

export async function renewMcpConversationActivity(
	ctx: ToolContext,
	lease: McpConversationActivityLease,
): Promise<void> {
	const identity = currentConversation(ctx);
	if (!identity) return;
	try {
		const sql = getDb();
		await sql`
      UPDATE public.mcp_client_conversations
      SET running_until = now() + make_interval(secs => ${RUNNING_LEASE_SECONDS}),
        updated_at = now()
      WHERE organization_id = ${ctx.organizationId}
        AND client_identity = ${identity.clientIdentity}
        AND conversation_id = ${identity.conversationId}
        AND running_generation = ${lease.generation}
        AND active_call_count > 0
    `;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn({ err }, `MCP conversation running lease was not renewed: ${message}`);
	}
}

export async function completeMcpConversationActivity(args: {
	ctx: ToolContext;
	toolName: string;
	failed: boolean;
	lease: McpConversationActivityLease | null;
}): Promise<void> {
	const identity = currentConversation(args.ctx);
	if (!identity) return;
	try {
		const sql = getDb();
		// `last_action` stores the RAW tool name, the same contract the migration
		// backfill writes. `displayAction` on the read path is the single
		// formatting point, so live and backfilled rows always render alike.
		const label = args.toolName;
		const clientId = oauthClientId(args.ctx);
		const sessionIds = transportSessionIds(args.ctx);
		// Generations start at 1. A missing begin lease uses -1 so the completion
		// still records its count without touching any newer running generation.
		const generation = args.lease?.generation ?? -1;
		await sql`
      INSERT INTO public.mcp_client_conversations (
        organization_id, client_identity, conversation_id, transport_session_ids,
        client_id, user_id, agent_id, last_action, tools, call_count, failed_count
      ) VALUES (
        ${args.ctx.organizationId}, ${identity.clientIdentity}, ${identity.conversationId},
        ${sql.json(sessionIds)}, ${clientId}, ${args.ctx.userId ?? null},
        ${args.ctx.agentId ?? null}, ${label}, ${sql.json([args.toolName])}, 1, ${args.failed ? 1 : 0}
      )
      ON CONFLICT (organization_id, client_identity, conversation_id) DO UPDATE SET
        transport_session_ids = CASE
          WHEN jsonb_array_length(EXCLUDED.transport_session_ids) = 0
            OR public.mcp_client_conversations.transport_session_ids ? (EXCLUDED.transport_session_ids->>0)
          THEN public.mcp_client_conversations.transport_session_ids
          ELSE public.mcp_client_conversations.transport_session_ids || EXCLUDED.transport_session_ids END,
        client_id = COALESCE(EXCLUDED.client_id, public.mcp_client_conversations.client_id),
        user_id = COALESCE(EXCLUDED.user_id, public.mcp_client_conversations.user_id),
        agent_id = COALESCE(EXCLUDED.agent_id, public.mcp_client_conversations.agent_id),
        last_action = EXCLUDED.last_action,
        tools = CASE WHEN public.mcp_client_conversations.tools ? ${args.toolName}
          THEN public.mcp_client_conversations.tools
          ELSE public.mcp_client_conversations.tools || EXCLUDED.tools END,
        call_count = public.mcp_client_conversations.call_count + 1,
        failed_count = public.mcp_client_conversations.failed_count + EXCLUDED.failed_count,
        active_call_count = CASE
          WHEN public.mcp_client_conversations.running_generation = ${generation}
          THEN GREATEST(public.mcp_client_conversations.active_call_count - 1, 0)
          ELSE public.mcp_client_conversations.active_call_count END,
        running_until = CASE
          WHEN public.mcp_client_conversations.running_generation = ${generation}
            AND public.mcp_client_conversations.active_call_count <= 1
          THEN NULL ELSE public.mcp_client_conversations.running_until END,
        last_activity_at = now(), updated_at = now()
    `;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(
			{ err, toolName: args.toolName },
			`MCP conversation activity was not materialized: ${message}`,
		);
	}
}

export async function recordMcpConversationActivity(args: {
	ctx: ToolContext;
	toolName: string;
	failed: boolean;
}): Promise<void> {
	const lease = await beginMcpConversationActivity(args);
	await completeMcpConversationActivity({ ...args, lease });
}

export async function setCurrentMcpConversationTitle(
	ctx: ToolContext,
	value: string,
) {
	const identity = currentConversation(ctx);
	if (!identity)
		throw new Error(
			"No current MCP conversation is available for this client session.",
		);
	const title = normalizeMcpConversationTitle(value);
	if (!title) throw new Error("Conversation title must not be empty.");
	const sql = getDb();
	const clientId = oauthClientId(ctx);
	const sessionIds = transportSessionIds(ctx);
	// A title can be set before the conversation's first call lands (the activity
	// row is written after the tool returns), so this seeds the row. `last_action`
	// is NOT NULL and keeps the raw-name contract; the enclosing tool call
	// overwrites it moments later, and the read path hides the row until it does.
	await sql`
    INSERT INTO public.mcp_client_conversations (
      organization_id, client_identity, conversation_id, transport_session_ids,
      client_id, user_id, agent_id, title, last_action
    ) VALUES (
      ${ctx.organizationId}, ${identity.clientIdentity}, ${identity.conversationId},
      ${sql.json(sessionIds)}, ${clientId}, ${ctx.userId ?? null},
      ${ctx.agentId ?? null}, ${title}, 'set_title'
    )
    ON CONFLICT (organization_id, client_identity, conversation_id)
    DO UPDATE SET title = EXCLUDED.title,
      transport_session_ids = CASE
        WHEN jsonb_array_length(EXCLUDED.transport_session_ids) = 0
          OR public.mcp_client_conversations.transport_session_ids ? (EXCLUDED.transport_session_ids->>0)
        THEN public.mcp_client_conversations.transport_session_ids
        ELSE public.mcp_client_conversations.transport_session_ids || EXCLUDED.transport_session_ids END,
      updated_at = now()
  `;
	return { title };
}
