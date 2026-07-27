/**
 * Composite conversation ids for the web-panel Agent API (`POST /api/v1/agents`).
 * Watcher automation is exempt from org scoping — pass `organizationId: undefined`
 * for that path (see `routes/public/agent.ts`).
 */

/**
 * Inverse of {@link buildApiConversationId}: recover the `threadId` suffix from a
 * packed web/API conversation id using the row's OWN known columns.
 *
 * This is the ONE place the packing is undone, and it runs at WRITE time so the
 * result can be stored in `conversations.thread_id`. Readers must never re-derive
 * a route from the id string — they read the stored column
 * (`thread_id ?? conversation_id`), which is what lets conversation origins whose
 * ids are not packed this way (MCP sessions, behaviour runs) list correctly.
 *
 * Returns null for the prefix-only "default thread" id (no suffix), which carries
 * no routable thread id and is not listed.
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
