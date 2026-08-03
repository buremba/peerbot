import { describe, expect, it } from "vitest";
import { hostConversationIdFromMeta } from "../../mcp-handler";
import { normalizeMcpConversationTitle } from "../../lobu/stores/mcp-client-conversations";

describe("MCP conversation display context", () => {
	it("uses only the host conversation correlation id", () => {
		expect(
			hostConversationIdFromMeta({
				"openai/session": " convo-1 ",
				url: "https://evil.example",
			}),
		).toBe("convo-1");
		expect(
			hostConversationIdFromMeta({
				conversation_id: "fake",
				location: "#general",
			}),
		).toBeNull();
	});

	it("normalizes a client title to one bounded plain-text line", () => {
		const title = normalizeMcpConversationTitle(
			`  Q3\nlaunch\t${"x".repeat(250)}  `,
		);
		expect(title).toMatch(/^Q3 launch /);
		expect(title).toHaveLength(200);
		expect(title).not.toMatch(/[\n\r\t]/);
	});
});
