import type { ParsedMessage } from "@lobu/core";
import { entryToMessage, parseSessionEntries } from "@lobu/core";

export function paginateSessionMessages(
	content: string,
	cursorParam: string,
	limit: number,
	options?: {
		excludeVerbose?: boolean;
		sessionIdFallback?: string;
	},
): {
	messages: ParsedMessage[];
	nextCursor: string | null;
	hasMore: boolean;
	sessionId: string;
} {
	const { entries, sessionId } = parseSessionEntries(content);
	const allMessages: ParsedMessage[] = [];
	for (const entry of entries) {
		const msg = entryToMessage(entry);
		if (!msg) continue;
		if (options?.excludeVerbose && msg.isVerbose) continue;
		allMessages.push(msg);
	}

	let startIndex = 0;
	if (cursorParam) {
		const idx = allMessages.findIndex((m) => m.id === cursorParam);
		if (idx >= 0) startIndex = idx + 1;
	}

	const pageMessages = allMessages.slice(startIndex, startIndex + limit);
	const hasMore = startIndex + limit < allMessages.length;
	const nextCursor = hasMore ? pageMessages[pageMessages.length - 1]?.id : null;

	return {
		messages: pageMessages,
		nextCursor,
		hasMore,
		sessionId: sessionId || options?.sessionIdFallback || "unknown",
	};
}
