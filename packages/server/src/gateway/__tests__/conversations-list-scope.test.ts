import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { listConversations } from "../services/conversations-store.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

/**
 * The three listing scopes, and specifically the line between `shared` and
 * `admin` — they return identical platform rows and differ ONLY on other
 * users' owned rows, which is exactly why they must be separate names.
 *
 * Before this fix there were two scopes, and the predicate applied
 * `kind='owned' AND user_id = …` only when `scope === "user"`. So the
 * end-user feed's `all` returned every user's owned rows — and a conversation
 * title is message text. That was inert only because the read path re-derived
 * a conversation's id from the caller's own userId, so the ids handed out were
 * not readable. Making conversations addressable by their stored id would have
 * turned that title disclosure into a full transcript disclosure.
 *
 * Narrowing it is not enough on its own: `manage_conversations` derives its
 * scope from an already-checked admin/owner role and MUST still see every row,
 * so the fix is a third scope rather than a blanket narrowing.
 */

const ORG = "test-org-scope-all-owned";
const OWNER = "user-scope-owner";
const STRANGER = "user-scope-stranger";
const AGENT = "agent-scope-all";

await ensureDbForGatewayTests();

beforeEach(async () => {
	await resetTestDatabase();
	// Creates the organization row the conversations FK requires.
	await seedAgentRow(AGENT, { organizationId: ORG, name: "Scope Agent" });
	const sql = getDb();
	// Two owned conversations by different users, plus a platform one.
	await sql`
		INSERT INTO public.conversations
			(organization_id, agent_id, platform, conversation_id, thread_id, kind, user_id, title)
		VALUES
			(${ORG}, ${AGENT}, 'web', ${`${AGENT}_${OWNER}_${ORG}_t-owner`}, 't-owner', 'owned', ${OWNER}, 'Owner private note'),
			(${ORG}, ${AGENT}, 'web', ${`${AGENT}_${STRANGER}_${ORG}_t-stranger`}, 't-stranger', 'owned', ${STRANGER}, 'Stranger private note'),
			(${ORG}, ${AGENT}, 'slack', 'slack:C0SCOPE:1700000000.1', NULL, 'platform', NULL, 'Team channel')
		ON CONFLICT DO NOTHING
	`;
});

afterAll(async () => {
	await resetTestDatabase();
});

describe("listConversations scope", () => {
	test("scope=shared excludes another user's owned conversations", async () => {
		const rows = await listConversations({
			organizationId: ORG,
			agentId: AGENT,
			scope: "shared",
			userId: OWNER,
		});

		const owned = rows.filter((r) => r.kind === "owned");
		expect(owned.map((r) => r.userId)).toEqual([OWNER]);
		// Titles are message text — the stranger's must not appear at all.
		expect(rows.map((r) => r.title)).not.toContain("Stranger private note");
	});

	test("scope=shared still widens to platform conversations", async () => {
		// The whole point of `shared`: platform rows the user does not own are the
		// reason the scope exists. Narrowing owned rows must not narrow these.
		const rows = await listConversations({
			organizationId: ORG,
			agentId: AGENT,
			scope: "shared",
			userId: OWNER,
		});

		expect(rows.some((r) => r.kind === "platform")).toBe(true);
		expect(rows.map((r) => r.title)).toContain("Team channel");
	});

	test("scope=admin lists every user's owned conversations", async () => {
		// `manage_conversations` reaches this only after checking an admin/owner
		// role, and its `get` action likewise lets an admin read any row. If a
		// narrowing meant to protect the end-user feed also applied here, the
		// admin listing would silently lose rows while `get` still served them.
		const rows = await listConversations({
			organizationId: ORG,
			agentId: AGENT,
			scope: "admin",
			userId: OWNER,
		});

		const owned = rows.filter((r) => r.kind === "owned");
		expect(owned.map((r) => r.userId).sort()).toEqual([OWNER, STRANGER].sort());
		expect(rows.map((r) => r.title)).toContain("Stranger private note");
		// Platform rows are unaffected by the owner predicate.
		expect(rows.map((r) => r.title)).toContain("Team channel");
	});

	test("scope=user returns only the caller's owned conversations", async () => {
		const rows = await listConversations({
			organizationId: ORG,
			agentId: AGENT,
			scope: "user",
			userId: OWNER,
		});

		expect(rows.every((r) => r.kind === "owned")).toBe(true);
		expect(rows.map((r) => r.userId)).toEqual([OWNER]);
	});
});
