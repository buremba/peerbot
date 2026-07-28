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
	 * Register a turn's run so finalizeTurnSuggestions can order it. Mirrors what
	 * the dispatch path writes; the ordering guard only reads (message_id, run_id).
	 * Returns the real `runs.id` — run ids are assigned by the sequence, so the
	 * ordering under test is the genuine monotonic one, not a hand-picked number.
	 */
	async function seedTurnRun(
		messageId: string,
		options: {
			conversationId?: string;
			deploymentName?: string;
		} = {},
	): Promise<number> {
		const sql = getTestDb();
		const turnConversationId = options.conversationId ?? conversationId;
		const deploymentName = options.deploymentName ?? "test-deploy";
		const runRows = (await sql`
			INSERT INTO public.runs (organization_id, run_type, status)
			VALUES (${orgId}, 'chat_message', 'completed')
			RETURNING id
		`) as Array<{ id: number }>;
		const runId = Number(runRows[0].id);
		await sql`
			INSERT INTO public.agent_run_input (
				organization_id, message_id, agent_id, conversation_id,
				deployment_name, run_id, payload, token_claims
			) VALUES (
				${orgId}, ${messageId}, 'suggest-agent', ${turnConversationId},
				${deploymentName}, ${runId}, '{}'::jsonb, '{}'::jsonb
			)
			ON CONFLICT (organization_id, deployment_name, message_id) DO NOTHING
		`;
		return runId;
	}

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
		// caused the bug. Only the status-agnostic query below can, which is why
		// this test asserts on a raw count rather than currentCount().
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

	it("a DELAYED terminal does not clear a newer turn's set", async () => {
		// Turn A publishes, then turn B publishes (B is the live set the user
		// sees). A's terminal row is only processed now — a queue backlog or a
		// retry made it lag a whole turn. Without an ordering guard, A does not
		// recognize B's turnMessageId, treats it as "a prior turn's leftovers",
		// and clears chips that are actually the newest ones.
		const runA = await seedTurnRun("msg-A");
		const runB = await seedTurnRun("msg-B");
		await persistSuggestion({
			organizationId: orgId,
			conversationId,
			prompts: [{ title: "A", message: "from turn A" }],
			turnMessageId: "msg-A",
			runId: runA,
		});
		const idB = await persistSuggestion({
			organizationId: orgId,
			conversationId,
			prompts: [{ title: "B", message: "from turn B" }],
			turnMessageId: "msg-B",
			runId: runB,
		});

		// A's terminal lands late. It must recognize B's set as NEWER and leave it.
		await finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId,
			turnMessageIds: ["msg-A"],
		});

		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.id).toBe(idB);
		expect(current?.prompts).toEqual([{ title: "B", message: "from turn B" }]);
	});

	it("a delayed turn that emitted NOTHING still cannot clear a newer set", async () => {
		// The harder case: turn C published no suggestions at all, so it has no
		// suggestion event of its own to order against — only its run id. Turn D
		// then published. C's terminal finally lands and must leave D's set alone.
		await seedTurnRun("msg-C");
		const runD = await seedTurnRun("msg-D");
		const idD = await persistSuggestion({
			organizationId: orgId,
			conversationId,
			prompts: [{ title: "D", message: "from turn D" }],
			turnMessageId: "msg-D",
			runId: runD,
		});
		// message_id is only unique per deployment. A later run in another
		// conversation must not be mistaken for this turn's ordering row.
		await seedTurnRun("msg-C", {
			conversationId: "api:other-conversation",
			deploymentName: "other-deploy",
		});

		await finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId,
			turnMessageIds: ["msg-C"],
		});

		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.id).toBe(idD);
		expect(current?.prompts).toEqual([{ title: "D", message: "from turn D" }]);
	});

	it("an IN-ORDER turn that emitted none still clears the prior set", async () => {
		// The guard must not become a blanket "never clear": a later turn (higher
		// run id) that emits nothing must still supersede the earlier chips.
		const runE = await seedTurnRun("msg-E");
		await persistSuggestion({
			organizationId: orgId,
			conversationId,
			prompts: [{ title: "E", message: "from turn E" }],
			turnMessageId: "msg-E",
			runId: runE,
		});
		await seedTurnRun("msg-F");

		await finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId,
			turnMessageIds: ["msg-F"],
		});

		expect(await readCurrentSuggestion(orgId, conversationId)).toBeNull();
	});

	it("a stale persist cannot supersede a LATER run's set (TOCTOU)", async () => {
		// A suggest_actions POST is decided by the worker but persists over the
		// network — a window in which the next turn may have published.
		// persistSuggestion's ordering guard must refuse to clobber the newer
		// set with the stale one.
		const convo = "api:conv-toctou";
		const runG = await seedTurnRun("msg-G", { conversationId: convo });
		const runH = await seedTurnRun("msg-H", { conversationId: convo });
		const idH = await persistSuggestion({
			organizationId: orgId,
			conversationId: convo,
			prompts: [{ title: "H", message: "from turn H" }],
			turnMessageId: "msg-H",
			runId: runH,
		});

		// Turn G's persist lands late, carrying the older run id.
		const returned = await persistSuggestion({
			organizationId: orgId,
			conversationId: convo,
			prompts: [{ title: "G", message: "stale generated chips" }],
			turnMessageId: "msg-G",
			runId: runG,
		});

		// The guard reports the surviving row and H's set stays current.
		expect(returned).toBe(idH);
		const current = await readCurrentSuggestion(orgId, convo);
		expect(current?.id).toBe(idH);
		expect(current?.prompts).toEqual([{ title: "H", message: "from turn H" }]);
	});

	it("a stale persist cannot resurrect chips over a LATER run's clear", async () => {
		// Same race, other terminal state: the newer turn emitted nothing, so its
		// finalize CLEARED the rail. The clear marker carries the clearing run's
		// id precisely so this delayed persist can see it is outdated — without
		// the stamp the rail would flash stale chips after the user saw it empty.
		const convo = "api:conv-toctou-clear";
		const runJ = await seedTurnRun("msg-J", { conversationId: convo });
		await persistSuggestion({
			organizationId: orgId,
			conversationId: convo,
			prompts: [{ title: "J", message: "from turn J" }],
			turnMessageId: "msg-J",
			runId: runJ,
		});
		await seedTurnRun("msg-K", { conversationId: convo });
		await finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId: convo,
			turnMessageIds: ["msg-K"],
		});
		expect(await readCurrentSuggestion(orgId, convo)).toBeNull();

		// Turn J's persist lands after K's clear.
		await persistSuggestion({
			organizationId: orgId,
			conversationId: convo,
			prompts: [{ title: "J-late", message: "stale generated chips" }],
			turnMessageId: "msg-J",
			runId: runJ,
		});

		expect(await readCurrentSuggestion(orgId, convo)).toBeNull();
	});
});
