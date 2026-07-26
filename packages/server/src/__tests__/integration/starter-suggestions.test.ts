/**
 * Starter chips — the per agent+org cache shown BEFORE a conversation starts.
 *
 * Starters are a derived cache (`agent_starters`), not conversation history:
 * exactly one row per (org, agent), replaced by upsert on each regeneration.
 * These tests pin the cache contract and — importantly — the two brakes that
 * stop a hidden LLM turn from firing on every landing in an active workspace.
 * Verified against real Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureStarters } from "../../gateway/starters/generate-starters";
import {
	finalizeStarterGeneration,
	readCachedStarters,
	shouldRegenerate,
	STARTERS_FAILURE_BACKOFF_MS,
	STARTERS_MIN_AGE_MS,
	writeCachedStarters,
} from "../../gateway/starters/starter-store";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { seedOwnerContext } from "../setup/test-fixtures";

describe("starter chips (per agent+org cache)", () => {
	let orgId: string;
	const agentId = "lobu-builder";

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org } = await seedOwnerContext({ orgName: "Starter Org" });
		orgId = org.id;
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	async function rowCount(): Promise<number> {
		const rows = (await getTestDb()`
			SELECT count(*)::int AS n
			FROM public.agent_starters
			WHERE organization_id = ${orgId} AND agent_id = ${agentId}
		`) as Array<{ n: number }>;
		return rows[0]?.n ?? 0;
	}

	it("persists a starter set readable by agent", async () => {
		await writeCachedStarters({
			organizationId: orgId,
			agentId,
			prompts: [
				{ title: "Connect Slack", message: "Connect a Slack workspace" },
			],
		});

		const cached = await readCachedStarters(orgId, agentId);
		expect(cached?.prompts).toEqual([
			{ title: "Connect Slack", message: "Connect a Slack workspace" },
		]);
		expect(cached?.failedAt).toBeNull();
		expect(await rowCount()).toBe(1);
	});

	it("regenerating REPLACES the set in place — no row growth", async () => {
		await writeCachedStarters({
			organizationId: orgId,
			agentId,
			prompts: [{ title: "Import CRM", message: "Import your CRM contacts" }],
		});
		// The events-substrate version appended a superseded row per generation,
		// unbounded forever. The cache holds exactly one row per agent+org.
		expect(await rowCount()).toBe(1);
		const cached = await readCachedStarters(orgId, agentId);
		expect(cached?.prompts).toEqual([
			{ title: "Import CRM", message: "Import your CRM contacts" },
		]);
	});

	it("a never-generated agent has no cache and must generate", async () => {
		const cached = await readCachedStarters(orgId, "never-generated-agent");
		expect(cached).toBeNull();
		expect(shouldRegenerate(cached)).toBe(true);
	});

	it("a FRESH set is not regenerated — the min-age dampener holds", async () => {
		const cached = await readCachedStarters(orgId, agentId);
		expect(shouldRegenerate(cached)).toBe(false);
	});

	it("regenerates only once the set has aged past the dampener", async () => {
		const cached = await readCachedStarters(orgId, agentId);
		if (!cached) throw new Error("expected a cached set");
		// Just inside the window: still fresh.
		const justInside =
			cached.generatedAt.getTime() + STARTERS_MIN_AGE_MS - 1000;
		expect(shouldRegenerate(cached, justInside)).toBe(false);
		// Past the window: regenerate.
		const past = cached.generatedAt.getTime() + STARTERS_MIN_AGE_MS + 1000;
		expect(shouldRegenerate(cached, past)).toBe(true);
	});

	it("an empty generation records a failure and backs off before retrying", async () => {
		const failAgent = "failing-agent";
		// The agent produced nothing usable (errored, or emitted no valid chips).
		await writeCachedStarters({
			organizationId: orgId,
			agentId: failAgent,
			prompts: [],
		});
		const cached = await readCachedStarters(orgId, failAgent);
		expect(cached?.failedAt).not.toBeNull();
		if (!cached?.failedAt) throw new Error("expected failedAt to be set");

		// Immediately after: do NOT retry (otherwise a broken agent dispatches a
		// hidden LLM turn on every single landing).
		expect(shouldRegenerate(cached, cached.failedAt.getTime() + 1000)).toBe(
			false,
		);
		// After the back-off: retry is allowed.
		expect(
			shouldRegenerate(
				cached,
				cached.failedAt.getTime() + STARTERS_FAILURE_BACKOFF_MS + 1000,
			),
		).toBe(true);
	});

	it("ensureStarters dispatches when missing, and NOT when the cache is fresh", async () => {
		let enqueued = 0;
		let enqueuedMessageId: string | undefined;
		const sessions = new Map<string, unknown>();
		const deps = {
			sessionManager: {
				setSession: async (s: any) => {
					sessions.set(s.conversationId, s);
				},
				getSession: async (id: string) => sessions.get(id) ?? null,
				touchSession: async () => undefined,
			},
			queueProducer: {
				enqueueMessage: async (payload: { messageId?: string }) => {
					enqueued += 1;
					enqueuedMessageId = payload.messageId;
					return "job-1";
				},
			},
		} as any;

		// No cache → dispatches exactly once.
		const dispatched = await ensureStarters(deps, {
			agentId: "dispatch-agent",
			organizationId: orgId,
		});
		expect(dispatched).toBe(true);
		expect(enqueued).toBe(1);
		expect(enqueuedMessageId).toBeTruthy();
		if (!enqueuedMessageId) throw new Error("expected an enqueued message id");

		// The matching hidden turn consumes its lease and publishes the fresh set.
		const finalized = await finalizeStarterGeneration({
			organizationId: orgId,
			agentId: "dispatch-agent",
			messageId: enqueuedMessageId,
			prompts: [{ title: "Fresh", message: "Fresh" }],
		});
		expect(finalized).toBe(true);

		// A duplicate/late terminal from the same turn cannot replace its result.
		const finalizedAgain = await finalizeStarterGeneration({
			organizationId: orgId,
			agentId: "dispatch-agent",
			messageId: enqueuedMessageId,
			prompts: [],
		});
		expect(finalizedAgain).toBe(false);
		expect(
			(await readCachedStarters(orgId, "dispatch-agent"))?.prompts,
		).toEqual([{ title: "Fresh", message: "Fresh" }]);

		// With no active lease, ensureStarters claims one, sees the fresh cache,
		// releases it, and declines to enqueue.
		const redispatched = await ensureStarters(deps, {
			agentId: "dispatch-agent",
			organizationId: orgId,
		});
		expect(redispatched).toBe(false);
		expect(enqueued).toBe(1); // no new enqueue
	});

	it("starter rows are scoped per agent — one agent's set never serves another", async () => {
		await writeCachedStarters({
			organizationId: orgId,
			agentId: "agent-a",
			prompts: [{ title: "A", message: "A" }],
		});
		await writeCachedStarters({
			organizationId: orgId,
			agentId: "agent-b",
			prompts: [{ title: "B", message: "B" }],
		});
		expect((await readCachedStarters(orgId, "agent-a"))?.prompts).toEqual([
			{ title: "A", message: "A" },
		]);
		expect((await readCachedStarters(orgId, "agent-b"))?.prompts).toEqual([
			{ title: "B", message: "B" },
		]);
	});
});
