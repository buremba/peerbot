/**
 * `parseConfig` semantics pinned across the Zod→TypeBox migration:
 *   - `lobu apply` string booleans coerce ("true" stays accepted);
 *   - unknown keys are STRIPPED before persistence (Zod's safeParse parity);
 *   - validation failures surface FIELD-level messages (the Telegram token
 *     pattern), not a generic "(root) Expected union value".
 */
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../chat-connection-service.js";

describe("parseConfig", () => {
	test("webhook string booleans are accepted and unknown keys stripped", () => {
		const parsed = parseConfig("webhook", {
			token: "t1",
			searchable: "true",
			junkKey: "should-not-persist",
		}) as Record<string, unknown>;
		expect(parsed).toEqual({
			platform: "webhook",
			token: "t1",
			searchable: "true",
		});
	});

	test("telegram config keeps declared keys and drops extras", () => {
		const botToken = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const parsed = parseConfig("telegram", {
			botToken,
			mode: "auto",
			extra: 1,
		}) as Record<string, unknown>;
		expect(parsed).toEqual({ platform: "telegram", botToken, mode: "auto" });
	});

	test("a malformed telegram token fails with a field-level error", () => {
		expect(() => parseConfig("telegram", { botToken: "notatoken" })).toThrow(
			/botToken/,
		);
	});

	test("an unsupported platform is rejected", () => {
		expect(() => parseConfig("carrier-pigeon", {})).toThrow();
	});
});
