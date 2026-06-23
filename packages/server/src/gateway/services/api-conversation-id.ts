/**
 * Composite conversation ids for the web-panel Agent API (`POST /api/v1/agents`).
 * Watcher automation is exempt from org scoping — pass `organizationId: undefined`
 * for that path (see `routes/public/agent.ts`).
 */

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

function isUserThreadSuffix(threadId: string): boolean {
	return (
		threadId.length > 0 &&
		!threadId.startsWith("watcher_") &&
		!threadId.startsWith("run_")
	);
}

/** Reverse {@link buildApiConversationId} for a known (agent, user, org) tuple. */
export function extractThreadIdFromConversationId(
	conversationId: string,
	agentId: string,
	userId: string,
	organizationId?: string,
): string | null {
	const base = buildApiConversationId({ agentId, userId, organizationId });
	if (conversationId === base) return null;

	const scopedPrefix = organizationId
		? `${agentId}_${userId}_${organizationId}_`
		: null;
	if (scopedPrefix && conversationId.startsWith(scopedPrefix)) {
		const threadId = conversationId.slice(scopedPrefix.length);
		return isUserThreadSuffix(threadId) ? threadId : null;
	}

	const legacyPrefix = `${agentId}_${userId}_`;
	if (!conversationId.startsWith(legacyPrefix)) return null;
	const rest = conversationId.slice(legacyPrefix.length);
	return isUserThreadSuffix(rest) ? rest : null;
}

export function isUserOwnedApiConversationId(
	conversationId: string,
	agentId: string,
	userId: string,
	organizationId?: string,
): boolean {
	return (
		extractThreadIdFromConversationId(
			conversationId,
			agentId,
			userId,
			organizationId,
		) !== null
	);
}
