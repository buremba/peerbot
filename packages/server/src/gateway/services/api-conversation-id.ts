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
