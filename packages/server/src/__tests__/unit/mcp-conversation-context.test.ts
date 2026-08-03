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

	it("rejects a blank or oversized host id as null, never as an empty string", () => {
		// Must be null, not "": the caller resolves the id with `?? mcpSessionId`,
		// and "" is not nullish — returning it would suppress the session fallback
		// and drop the row entirely.
		for (const blank of ["", "   ", "\t\n"]) {
			expect(hostConversationIdFromMeta({ "openai/session": blank })).toBeNull();
		}
		expect(
			hostConversationIdFromMeta({ "openai/session": "x".repeat(513) }),
		).toBeNull();
		expect(hostConversationIdFromMeta(null)).toBeNull();
		expect(hostConversationIdFromMeta(undefined)).toBeNull();
	});

	it("normalizes a client title to one bounded plain-text line", () => {
		const title = normalizeMcpConversationTitle(
			`  Q3\nlaunch\t${"x".repeat(250)}  `,
		);
		expect(title).toMatch(/^Q3 launch /);
		expect(title).toHaveLength(200);
		expect(title).not.toMatch(/[\n\r\t]/);
	});

	it("truncates on code points so an emoji is never split", () => {
		const title = normalizeMcpConversationTitle(`${"x".repeat(199)}🚀tail`);
		expect([...title]).toHaveLength(200);
		// A code-unit slice here would keep a lone high surrogate, which cannot
		// be encoded as UTF-8 for the title write.
		expect(title.endsWith("🚀")).toBe(true);
	});
});
