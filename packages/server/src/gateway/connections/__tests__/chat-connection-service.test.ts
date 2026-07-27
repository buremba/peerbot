/**
 * `parseConfig` semantics pinned across the Zod→TypeBox migration:
 *   - `lobu apply` string booleans coerce ("true" stays accepted);
 *   - unknown keys are STRIPPED before persistence (Zod's safeParse parity);
 *   - validation failures surface FIELD-level messages (the Telegram token
 *     pattern), not a generic "(root) Expected union value".
 */
import { describe, expect, test } from "bun:test";
import { restoreRedactedConfig } from "../../../utils/connection-config-redaction.js";
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

/**
 * The chat twin of the non-chat locked-restore race.
 *
 * `connections.update` on a chat connection routes into `updateChatConnection`.
 * A redacted round-trip sends `__LOBU_REDACTED__` back for any
 * `format: "password"` field, and the sentinel is restored from the stored row.
 * If that restore sources a snapshot taken BEFORE the write is serialized, this
 * interleaving silently rolls back a rotation:
 *
 *   A: read (redacted)       — snapshot holds the OLD token
 *   B: rotate the bot token  — commits the NEW token
 *   A: write, restoring from A's snapshot → OLD token overwrites NEW
 *
 * It matters more here than on the non-chat path: the chat connectors
 * (slack/discord/telegram/teams/whatsapp/gchat/webhook) are exactly the ones
 * declaring `format: "password"`, so this is where live bot tokens sit.
 *
 * The fix has two halves: `crud.ts` passes the RAW incoming config (it must NOT
 * restore against the handler's unlocked snapshot), and `updateChatConnection`
 * takes `withStableChatLock`, re-reads the row inside it, and restores from
 * THAT. These cases pin the property that makes the second half correct —
 * restoring against the fresh row yields the ROTATED value, restoring against
 * the stale snapshot yields the old one.
 *
 * This is a seam test, not end-to-end. An integration attempt could park
 * `handleUpdate` mid-flight and prove the stale token reaches the manager, but
 * the row it finally persists is written by `ChatInstanceManager` against a
 * warm in-memory instance the test harness has no way to create — so the
 * end-to-end assertion passed whether or not the fix was present. A test that
 * cannot fail is worse than no test, so it was dropped in favour of this.
 */
describe("chat config restore sources the fresh row", () => {
	const REDACTED = "__LOBU_REDACTED__";
	const OLD_TOKEN = "webhook-token-original";
	const ROTATED_TOKEN = "webhook-token-rotated-by-replica-b";

	// What a client sends back after reading the redacted connection.
	const incoming = { token: REDACTED, semanticType: "probe" };

	test("restoring against the freshly-read row keeps the rotation", () => {
		// The row as re-read INSIDE the lock, after B's rotation committed.
		const freshRow = { token: ROTATED_TOKEN, platform: "webhook" };
		const restored = restoreRedactedConfig(incoming, freshRow) as Record<
			string,
			unknown
		>;
		expect(restored.token).toBe(ROTATED_TOKEN);
		expect(restored.semanticType).toBe("probe");
	});

	test("restoring against a stale snapshot resurrects the old token", () => {
		// The snapshot `crud.ts` used to restore from — read before the rotation.
		// This is the bug, pinned so the failure mode stays visible: the sentinel
		// resolves to a credential that is no longer current.
		const staleSnapshot = { token: OLD_TOKEN, platform: "webhook" };
		const restored = restoreRedactedConfig(incoming, staleSnapshot) as Record<
			string,
			unknown
		>;
		expect(restored.token).toBe(OLD_TOKEN);
		expect(restored.token).not.toBe(ROTATED_TOKEN);
	});

	test("the merge cannot reintroduce a stale value the restore dropped", () => {
		// `updateChatConnection` merges `{...currentConfig, ...restored}` where
		// BOTH sides come from the locked row, so no pre-lock value can leak in.
		const freshRow = { token: ROTATED_TOKEN, platform: "webhook" };
		const restored = restoreRedactedConfig(incoming, freshRow) as Record<
			string,
			unknown
		>;
		const merged = { ...freshRow, ...restored };
		expect(merged.token).toBe(ROTATED_TOKEN);
		expect(JSON.stringify(merged)).not.toContain(OLD_TOKEN);
		expect(JSON.stringify(merged)).not.toContain(REDACTED);
	});
});
