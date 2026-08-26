import { describe, expect, test } from "bun:test";
import { boundedReply } from "../../worker-api/device-chat";

describe("boundedReply", () => {
	test("keeps short replies unchanged", () => {
		expect(boundedReply("hello 🌍")).toBe("hello 🌍");
	});

	test("truncates on a UTF-8 code-point boundary", () => {
		const reply = `${"a".repeat(512 * 1024 - 1)}🌍`;
		const bounded = boundedReply(reply);

		expect(bounded).toEndWith("\n\n[Reply truncated by Lobu]");
		expect(bounded).not.toContain("�");
		expect(bounded).not.toContain("🌍");
	});
});
