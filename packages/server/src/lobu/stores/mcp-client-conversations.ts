import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { ToolContext } from "../../tools/registry.js";

const logger = createLogger("mcp-client-conversations");
const MAX_TITLE_LENGTH = 200;

function currentConversation(ctx: ToolContext) {
	const conversationId = (ctx.mcpConversationId ?? ctx.mcpSessionId)?.trim();
	if (!conversationId || conversationId.length > 512) return null;
	return { clientIdentity: ctx.clientId?.trim() || "", conversationId };
}

function oauthClientId(ctx: ToolContext): string | null {
	return ctx.tokenType === "oauth" ? (ctx.clientId ?? null) : null;
}

export function normalizeMcpConversationTitle(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_TITLE_LENGTH);
}

export async function recordMcpConversationActivity(args: {
	ctx: ToolContext;
	toolName: string;
	actionLabel?: string;
	failed: boolean;
}): Promise<void> {
	const identity = currentConversation(args.ctx);
	if (!identity) return;
	try {
		const sql = getDb();
		const label = args.actionLabel?.trim() || args.toolName;
		const clientId = oauthClientId(args.ctx);
		await sql`
      INSERT INTO public.mcp_client_conversations (
        organization_id, client_identity, conversation_id, transport_session_id,
        client_id, user_id, agent_id, last_action, tools, call_count, failed_count
      ) VALUES (
        ${args.ctx.organizationId}, ${identity.clientIdentity}, ${identity.conversationId},
        ${args.ctx.mcpSessionId ?? null}, ${clientId}, ${args.ctx.userId ?? null},
        ${args.ctx.agentId ?? null}, ${label}, ${sql.json([args.toolName])}, 1, ${args.failed ? 1 : 0}
      )
      ON CONFLICT (organization_id, client_identity, conversation_id) DO UPDATE SET
        transport_session_id = COALESCE(EXCLUDED.transport_session_id, public.mcp_client_conversations.transport_session_id),
        client_id = COALESCE(EXCLUDED.client_id, public.mcp_client_conversations.client_id),
        user_id = COALESCE(EXCLUDED.user_id, public.mcp_client_conversations.user_id),
        agent_id = COALESCE(EXCLUDED.agent_id, public.mcp_client_conversations.agent_id),
        last_action = EXCLUDED.last_action,
        tools = CASE WHEN public.mcp_client_conversations.tools ? ${args.toolName}
          THEN public.mcp_client_conversations.tools
          ELSE public.mcp_client_conversations.tools || EXCLUDED.tools END,
        call_count = public.mcp_client_conversations.call_count + 1,
        failed_count = public.mcp_client_conversations.failed_count + EXCLUDED.failed_count,
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
	await sql`
    INSERT INTO public.mcp_client_conversations (
      organization_id, client_identity, conversation_id, transport_session_id,
      client_id, user_id, agent_id, title, last_action
    ) VALUES (
      ${ctx.organizationId}, ${identity.clientIdentity}, ${identity.conversationId},
      ${ctx.mcpSessionId ?? null}, ${clientId}, ${ctx.userId ?? null},
      ${ctx.agentId ?? null}, ${title}, 'Recent activity'
    )
    ON CONFLICT (organization_id, client_identity, conversation_id)
    DO UPDATE SET title = EXCLUDED.title, updated_at = now()
  `;
	return { title };
}
