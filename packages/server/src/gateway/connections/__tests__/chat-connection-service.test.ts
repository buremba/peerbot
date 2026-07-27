/**
 * `parseConfig` semantics pinned across the Zod→TypeBox migration:
 *   - `lobu apply` string booleans coerce ("true" stays accepted);
 *   - unknown keys are STRIPPED before persistence (Zod's safeParse parity);
 *   - validation failures surface FIELD-level messages (the Telegram token
 *     pattern), not a generic "(root) Expected union value".
 */
import { describe, expect, test } from "bun:test";
import {
	parseConfig,
	unwrapIncomingChatConfig,
} from "../chat-connection-service.js";

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

	test("wrong-typed credentials are rejected, not coerced", () => {
		// A numeric botToken must NOT be silently stringified to "12345".
		expect(() =>
			parseConfig("slack", { botToken: 12345, signingSecret: "s" }),
		).toThrow(/botToken/);
	});

	test("scalar mentionRoleIds is rejected (array required)", () => {
		expect(() =>
			parseConfig("discord", {
				botToken: "t",
				applicationId: "a",
				publicKey: "p",
				mentionRoleIds: "role-1",
			}),
		).toThrow(/mentionRoleIds/);
	});
});


/**
 * A redacted re-apply of an UNCHANGED BYO chat connection must end up holding
 * the REAL credential, not a placeholder.
 *
 * `unwrapIncomingChatConfig` is the production seam every BYO apply goes
 * through. It unwinds two placeholder layers in order: `__LOBU_REDACTED__` →
 * stored value (restore), then `secret://…` → plaintext (resolve). Skipping
 * the second meant an unresolved ref reached `parseConfig`,
 * `connectionMatches` and `validateProviderIdentity` — so an unchanged
 * re-apply reported `changed`, and Slack's `authTest` was handed the literal
 * `secret://…` URI and failed the apply.
 *
 * `resolveRefs` is injected here because the real implementation is the chat
 * manager's secret-store lookup; everything else is the shipped code path.
 */
describe("unwrapIncomingChatConfig", () => {
	const REDACTED = "__LOBU_REDACTED__";
	const REF = "secret://org-1/webhook-token";
	const PLAINTEXT = "real-webhook-bearer-token";

	/** Stands in for the manager's secret-store resolution. */
	const resolveRefs = async (_id: string, config: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(config).map(([k, v]) => [k, v === REF ? PLAINTEXT : v]),
		) as never;

	const incoming = { token: REDACTED, semanticType: "probe" };
	const stored = { token: REF, semanticType: "probe" };

	function unwrap(
		over: Partial<Parameters<typeof unwrapIncomingChatConfig>[0]> = {},
	) {
		return unwrapIncomingChatConfig({
			organizationId: "org-1",
			stableId: "byo-webhook-1",
			incoming,
			stored,
			resolveRefs,
			...over,
		});
	}

	test("a redacted re-apply yields the real credential, never a placeholder", async () => {
		const out = await unwrap();
		expect(out.token).toBe(PLAINTEXT);
		// Neither placeholder may survive to a consumer.
		expect(JSON.stringify(out)).not.toContain(REDACTED);
		expect(JSON.stringify(out)).not.toContain("secret://");
		// Non-secret fields round-trip untouched.
		expect(out.semanticType).toBe("probe");
	});

	test("an unchanged re-apply matches the resolved stored config", async () => {
		// This equality is what the `changed: false` determination rests on.
		const applySide = await unwrap();
		const storedSide = await resolveRefs("byo-webhook-1", stored);
		expect(applySide).toEqual(storedSide as unknown as Record<string, unknown>);
	});

	test("a genuine rotation still passes through", async () => {
		// Preserve-on-sentinel must not make credentials immutable.
		const out = await unwrap({ incoming: { token: "rotated-plaintext" } });
		expect(out.token).toBe("rotated-plaintext");
	});

	test("a create (no stored row) passes the caller's config through", async () => {
		const out = await unwrap({
			incoming: { token: "brand-new" },
			stored: undefined,
		});
		expect(out.token).toBe("brand-new");
	});

	test("resolution failure surfaces rather than persisting a reference", async () => {
		// Failing loudly beats silently storing an unresolvable ref as if it were
		// a credential.
		await expect(
			unwrap({
				resolveRefs: async () => {
					throw new Error("secret store unavailable");
				},
			}),
		).rejects.toThrow(/secret store unavailable/);
	});
});
