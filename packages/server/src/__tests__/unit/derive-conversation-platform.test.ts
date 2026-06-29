import { describe, expect, it } from "vitest";
import { deriveConversationPlatform } from "../../gateway/services/agent-thread-list";

/**
 * `scope=all` lists conversations across platforms by deriving the platform
 * from the conversation-id prefix. The invariant under test: only genuine
 * platform sessions (colon-prefixed, e.g. `slack:{channel}:{ts}`) map to a
 * platform; the app's own threads and system/watcher sessions (underscore-
 * delimited, no colon) stay "web" so they never masquerade as a platform.
 */
describe("deriveConversationPlatform", () => {
	it("derives the platform from a colon-prefixed conversation id", () => {
		expect(deriveConversationPlatform("slack:C0BAUJJ2RJP:1781641725.28")).toBe(
			"slack",
		);
		expect(deriveConversationPlatform("telegram:998877:1")).toBe("telegram");
		expect(deriveConversationPlatform("whatsapp:1555:0")).toBe("whatsapp");
		expect(deriveConversationPlatform("discord:guild:chan")).toBe("discord");
	});

	it("treats the app's own threads (no colon) as web", () => {
		expect(
			deriveConversationPlatform("food-ordering_user_1_org_abc_thread123"),
		).toBe("web");
		expect(deriveConversationPlatform("owletto-default_u1_o1_t1")).toBe("web");
	});

	it("does NOT classify watcher/system ids as a platform", () => {
		// Watcher runs are underscore-delimited (no colon) — they must never leak
		// into the cross-platform conversation list as a fake platform.
		expect(
			deriveConversationPlatform("food-ordering_watcher_4_run_466129"),
		).toBe("web");
	});

	it("ignores a leading colon and non-prefixed ids", () => {
		expect(deriveConversationPlatform(":weird")).toBe("web");
		expect(deriveConversationPlatform("nocolon")).toBe("web");
		expect(deriveConversationPlatform("")).toBe("web");
	});
});
