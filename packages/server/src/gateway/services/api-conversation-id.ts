/**
 * Composite conversation ids for the web-panel Agent API (`POST /api/v1/agents`).
 * Watcher automation is exempt from org scoping — pass `organizationId: undefined`
 * for that path (see `routes/public/agent.ts`).
 */

/**
 * Inverse of {@link buildApiConversationId}: recover the `threadId` suffix from a
 * packed web/API conversation id using its known owner columns.
 *
 * This runs at write time so the result can be stored in
 * `conversations.thread_id`; list readers do not parse the id string again.
 * Returns null when the id is not packed for this owner or has no thread suffix.
 *
 * NOTE for a future origin with OPAQUE ids (an MCP session, a behaviour run):
 * storing the id verbatim here is NOT enough to make it work, and is why that
 * case is deliberately still null. The thread read path re-PACKS the id —
 * `readThreadMessages` and the interactions query in `routes/public/agent-history.ts`
 * both call {@link buildApiConversationId} with the thread id — so an opaque
 * value would list in the sidebar and then resolve to a conversation id no row
 * has. Making those origins listable means teaching the read path to address a
 * conversation by its stored id, not just widening what gets stored.
 */
export function threadIdFromApiConversationId(args: {
	conversationId: string;
	agentId: string;
	userId: string;
	organizationId?: string;
}): string | null {
	const orgScope = args.organizationId ? `_${args.organizationId}` : "";
	const prefix = `${args.agentId}_${args.userId}${orgScope}_`;
	if (!args.conversationId.startsWith(prefix)) return null;
	const suffix = args.conversationId.slice(prefix.length);
	return suffix.length > 0 ? suffix : null;
}

export function buildApiConversationId(args: {
	agentId: string;
	userId: string;
	organizationId?: string;
	threadId?: string;
}): string {
	const orgScope = args.organizationId ? `_${args.organizationId}` : "";
	if (args.threadId) {
		return `${args.agentId}_${args.userId}${orgScope}_${args.threadId}`;
	}
	return `${args.agentId}_${args.userId}${orgScope}`;
}
