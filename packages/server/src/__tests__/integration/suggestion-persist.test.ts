/**
 * Turn-owned suggestion supersession — the load-bearing correctness claim.
 *
 * Suggestions persist as a superseded `interaction_type='suggestion'` event
 * keyed per CONVERSATION. Each new set must supersede the prior so exactly ONE
 * 'current' row exists per conversation (the "stack forever" bug for API/
 * Builder sessions with no numeric connectionId). Clearing on a no-suggestion
 * turn must drop the current set. All verified against real Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspaceProvider } from "../../workspace";
import {
	finalizeTurnSuggestions,
	persistSuggestion,
	readCurrentSuggestion,
} from "../../gateway/suggestions/persist-suggestion";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { seedOwnerContext } from "../setup/test-fixtures";

describe("suggestion persistence (turn-owned supersede)", () => {
	let orgId: string;
	const conversationId = "api:conv-suggest-1";

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org } = await seedOwnerContext({ orgName: "Suggestion Org" });
		orgId = org.id;
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	/**
	 * Count rows the CURRENT-SET QUERY sees — i.e. what the renderer reads.
	 * Deliberately mirrors readCurrentSuggestion's filter.
	 */
	async function currentCount(): Promise<number> {
		const rows = (await getTestDb()`
			SELECT count(*)::int AS n
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND interaction_type = 'suggestion'
			  AND interaction_status = 'current'
			  AND origin_id = ${`suggestion:${conversationId}`}
		`) as Array<{ n: number }>;
		return rows[0]?.n ?? 0;
	}

	/**
	 * Count rows LIVE IN THE VIEW, whatever their interaction_status.
	 *
	 * `current_event_records` defines live as "nothing supersedes me" and does
	 * NOT filter interaction_status, so a row this count sees but `currentCount`
	 * does not is a row nothing will ever supersede — an unbounded leak in an
	 * append-only table. Every assertion here used to filter on
	 * interaction_status='current', which is precisely the filter that let a
	 * clear-row leak survive six green tests.
	 */
	async function liveCount(): Promise<number> {
		const rows = (await getTestDb()`
			SELECT count(*)::int AS n
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND interaction_type = 'suggestion'
			  AND origin_id = ${`suggestion:${conversationId}`}
		`) as Array<{ n: number }>;
		return rows[0]?.n ?? 0;
	}

	it("persists a current suggestion set readable by conversation", async () => {
		const id = await persistSuggestion({
			organizationId: orgId,
			conversationId,
			prompts: [{ title: "Ship it", message: "Ship the PR" }],
			turnMessageId: "msg-1",
		});
		expect(id).toBeGreaterThan(0);

		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.id).toBe(id);
		expect(current?.prompts).toEqual([{ title: "Ship it", message: "Ship the PR" }]);
		expect(current?.turnMessageId).toBe("msg-1");
		expect(await currentCount()).toBe(1);
	});

	it("supersedes the prior set — exactly one current row after a second turn", async () => {
		await persistSuggestion({
			organizationId: orgId,
			conversationId,
			prompts: [{ title: "Next", message: "What's next?" }],
			turnMessageId: "msg-2",
		});
		// The stack-forever bug would leave 2 current rows here.
		expect(await currentCount()).toBe(1);
		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.prompts).toEqual([{ title: "Next", message: "What's next?" }]);
		expect(current?.turnMessageId).toBe("msg-2");
	});

	it("finalize keeps the set when THIS turn owns it", async () => {
		// Current set is msg-2's (from the prior test). A completion for msg-2
		// that folds several inbound ids must keep its own chips.
		await finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId,
			turnMessageIds: ["extra-inbound", "msg-2"],
		});
		expect(await currentCount()).toBe(1);
		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.turnMessageId).toBe("msg-2");
	});

	it("finalize supersedes a prior set on a turn that emitted none", async () => {
		// A later turn (msg-9) completes without (re)issuing suggestions → the
		// stale msg-2 chips must be cleared.
		await finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId,
			turnMessageIds: ["msg-9"],
		});
		expect(await currentCount()).toBe(0);
		expect(await readCurrentSuggestion(orgId, conversationId)).toBeNull();
	});

	it("finalize is a no-op when nothing is current", async () => {
		await finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId,
			turnMessageIds: ["msg-10"],
		});
		expect(await currentCount()).toBe(0);
	});

	it("finalize by the OWNING turn keeps its own newly-persisted set", async () => {
		// The turn that just emitted a set and immediately finalizes must keep it
		// — the ordered common case (finalize runs after this turn's own persist).
		const id = await persistSuggestion({
			organizationId: orgId,
			conversationId,
			prompts: [{ title: "Fresh", message: "Fresh message" }],
			turnMessageId: "msg-fresh",
		});
		await finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId,
			turnMessageIds: ["msg-fresh"],
		});
		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.id).toBe(id);
		expect(current?.prompts).toEqual([
			{ title: "Fresh", message: "Fresh message" },
		]);
	});

	it("leaves exactly one live row across repeated suggest→clear cycles", async () => {
		// THE LEAK: finalize writes its clear marker with interaction_status
		// 'completed'. persistSuggestion used to search for a prior row filtered
		// on status='current', so it never saw that clear marker and never
		// superseded it — and `current_event_records` keeps it live forever
		// (the view filters on "nothing supersedes me", NOT on status). Every
		// suggest→clear cycle therefore stranded one immortal row in an
		// append-only table.
		//
		// currentCount() cannot see this: it applies the same status filter that
		// caused the bug. Only liveCount() can, which is why it exists.
		const cycles = "api:conv-cycles";
		for (let i = 0; i < 3; i++) {
			await persistSuggestion({
				organizationId: orgId,
				conversationId: cycles,
				prompts: [{ title: `T${i}`, message: `M${i}` }],
				turnMessageId: `cycle-${i}`,
			});
			await finalizeTurnSuggestions({
				organizationId: orgId,
				conversationId: cycles,
				// A different turn id, so this clears rather than keeps.
				turnMessageIds: [`other-${i}`],
			});
		}

		const rows = (await getTestDb()`
			SELECT count(*)::int AS n
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND interaction_type = 'suggestion'
			  AND origin_id = ${`suggestion:${cycles}`}
		`) as Array<{ n: number }>;
		// One live row: the final clear marker. Pre-fix this was 3 and grew
		// without bound — one stranded row per cycle, forever.
		expect(rows[0]?.n ?? 0).toBe(1);
	});
});
