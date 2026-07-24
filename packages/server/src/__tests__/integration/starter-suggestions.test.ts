/**
 * Starter-suggestion cache — per agent+org chips shown before a conversation
 * starts. Keyed `origin_id='starter:<agentId>'` (a fresh draft has no server
 * conversation), superseded so exactly ONE current row exists per agent, and
 * compared with the org's latest non-suggestion event. Verified against real
 * Postgres.
 */

import type { MessagePayload } from "@lobu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueueProducer } from "../../gateway/infrastructure/queue/queue-producer";
import type { ISessionManager, ThreadSession } from "../../gateway/session";
import { ensureStarters } from "../../gateway/starters/generate-starters";
import {
	currentOrgEventsMarker,
	isStarterStale,
	persistSuggestion,
	persistStarterSuggestion,
	readCurrentStarter,
} from "../../gateway/suggestions/persist-suggestion";
import { insertEvent } from "../../utils/insert-event";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { seedOwnerContext } from "../setup/test-fixtures";

describe("starter suggestions (per agent+org cache)", () => {
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

	async function currentCount(): Promise<number> {
		const rows = (await getTestDb()`
			SELECT count(*)::int AS n
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND interaction_type = 'suggestion'
			  AND interaction_status = 'current'
			  AND origin_id = ${`starter:${agentId}`}
		`) as Array<{ n: number }>;
		return rows[0]?.n ?? 0;
	}

	it("persists a starter set readable by agent, exactly one current row", async () => {
		const id = await persistStarterSuggestion({
			organizationId: orgId,
			agentId,
			prompts: [
				{ title: "Connect Slack", message: "Connect a Slack workspace" },
			],
		});
		expect(id).toBeGreaterThan(0);

		const cached = await readCurrentStarter(orgId, agentId);
		expect(cached?.id).toBe(id);
		expect(cached?.prompts).toEqual([
			{ title: "Connect Slack", message: "Connect a Slack workspace" },
		]);
		expect(await currentCount()).toBe(1);
	});

	it("supersedes the prior set — one current row after regeneration", async () => {
		await persistStarterSuggestion({
			organizationId: orgId,
			agentId,
			prompts: [{ title: "Import CRM", message: "Import your CRM contacts" }],
		});
		expect(await currentCount()).toBe(1);
		const cached = await readCurrentStarter(orgId, agentId);
		expect(cached?.prompts).toEqual([
			{ title: "Import CRM", message: "Import your CRM contacts" },
		]);
	});

	it("suggestion events do not invalidate starter caches", async () => {
		const cached = await readCurrentStarter(orgId, agentId);
		await persistSuggestion({
			organizationId: orgId,
			conversationId: "another-conversation",
			prompts: [{ title: "Next", message: "Do the next thing" }],
		});
		expect(
			isStarterStale(cached, await currentOrgEventsMarker(orgId)),
		).toBe(false);
	});

	it("becomes stale after a later non-suggestion org event", async () => {
		const before = await readCurrentStarter(orgId, agentId);
		// Simulate workspace activity with a non-suggestion org event.
		await insertEvent({
			entityIds: [],
			organizationId: orgId,
			originId: `probe_${before?.id ?? 0}`,
			semanticType: "operation",
			title: null,
			content: "workspace activity probe",
		});
		const marker = await currentOrgEventsMarker(orgId);
		expect(isStarterStale(before, marker)).toBe(true);
	});

	it("treats a missing cache as stale", async () => {
		// A never-generated agent has no cache → stale (should generate).
		const cached = await readCurrentStarter(orgId, "some-other-agent");
		expect(cached).toBeNull();
		expect(isStarterStale(cached, await currentOrgEventsMarker(orgId))).toBe(
			true,
		);
	});

	it("ensureStarters dispatches when stale, and NOT when the cache is fresh", async () => {
		// Track hidden-turn dispatch through spy deps.
		let enqueued = 0;
		let enqueuedPayload: MessagePayload | null = null;
		const sessions = new Map<string, ThreadSession>();
		const deps = {
			sessionManager: {
				setSession: async (s: ThreadSession) => {
					sessions.set(s.conversationId, s);
				},
				getSession: async (id: string) => sessions.get(id) ?? null,
				touchSession: async () => undefined,
			} as unknown as ISessionManager,
			queueProducer: {
				enqueueMessage: async (payload: MessagePayload) => {
					enqueued += 1;
					enqueuedPayload = payload;
					return "job-1";
				},
			} as unknown as QueueProducer,
		};

		// A never-generated agent (no cache) → stale → dispatches exactly once.
		const dispatched = await ensureStarters(deps, {
			agentId: "dispatch-agent",
			organizationId: orgId,
		});
		expect(dispatched).toBe(true);
		expect(enqueued).toBe(1);
		expect(enqueuedPayload?.agentOptions).toMatchObject({
			allowedTools: [
				"search_sdk",
				"query_sdk",
				"query_sql",
				"search_memory",
				"suggest_actions",
			],
			toolsConfig: { strictMode: true },
		});

		// Persist a fresh set, then ensure a second call sees it as fresh under
		// the lease and does not re-dispatch.
		await persistStarterSuggestion({
			organizationId: orgId,
			agentId: "dispatch-agent",
			prompts: [{ title: "Fresh", message: "Fresh" }],
		});
		const redispatched = await ensureStarters(deps, {
			agentId: "dispatch-agent",
			organizationId: orgId,
		});
		expect(redispatched).toBe(false);
		expect(enqueued).toBe(1); // no new enqueue
	});

	it("holds a durable lease across concurrent starter pulls", async () => {
		let enqueued = 0;
		const sessions = new Map<string, ThreadSession>();
		const deps = {
			sessionManager: {
				setSession: async (s: ThreadSession) => {
					sessions.set(s.conversationId, s);
				},
				getSession: async (id: string) => sessions.get(id) ?? null,
				touchSession: async () => undefined,
			} as unknown as ISessionManager,
			queueProducer: {
				enqueueMessage: async () => {
					enqueued += 1;
					return `job-${enqueued}`;
				},
			} as unknown as QueueProducer,
		};

		const results = await Promise.all([
			ensureStarters(deps, {
				agentId: "concurrent-agent",
				organizationId: orgId,
			}),
			ensureStarters(deps, {
				agentId: "concurrent-agent",
				organizationId: orgId,
			}),
		]);

		expect(results.sort()).toEqual([false, true]);
		expect(enqueued).toBe(1);
	});
});
