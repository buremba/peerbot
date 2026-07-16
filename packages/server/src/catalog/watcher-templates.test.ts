import { describe, expect, it } from "vitest";
import type { ClientSDK } from "../sandbox/client-sdk";
import { runScript } from "../sandbox/run-script";
import {
	compileReactionScript,
	extractReactionInputSchema,
} from "../watchers/reaction-executor";
import { WATCHER_CATALOG_TEMPLATES } from "./watcher-templates";

const duplicateMergeTemplate = WATCHER_CATALOG_TEMPLATES.find(
	(entry) => entry.id === "duplicate-merge",
);
if (!duplicateMergeTemplate) {
	throw new Error("duplicate-merge watcher template is missing");
}
const duplicateMergeReaction = String(
	duplicateMergeTemplate.detail.reaction_script,
);

async function executeDuplicateMergeReaction(
	people: Array<{ id: number; metadata: Record<string, unknown> }>,
): Promise<{
	calls: Record<string, unknown>[];
	result: Awaited<ReturnType<typeof runScript>>;
}> {
	const calls: Record<string, unknown>[] = [];
	const sdk = {
		knowledge: {
			read: async () => ({ sources: { people } }),
		},
		entities: {
			manage: async (input: Record<string, unknown>) => {
				calls.push(input);
				return { approval_queued: true };
			},
		},
	} as unknown as ClientSDK;
	const result = await runScript({
		source: duplicateMergeReaction,
		sdk,
		context: {
			window: {
				watcher_id: 7,
				window_start: "2026-01-01T00:00:00.000Z",
				window_end: "2026-01-02T00:00:00.000Z",
			},
		},
	});
	return { calls, result };
}

async function runDuplicateMergeReaction(
	people: Array<{ id: number; metadata: Record<string, unknown> }>,
): Promise<Record<string, unknown>[]> {
	const { calls, result } = await executeDuplicateMergeReaction(people);
	expect(result.error ?? null).toBeNull();
	expect(result.success).toBe(true);
	return calls;
}

describe("duplicate merge watcher template", () => {
	it("keeps model output explanatory and approval-gated", () => {
		const prompt = String(duplicateMergeTemplate.detail.prompt);

		expect(prompt).toContain("analysis_summary");
		expect(prompt).toContain("pending human approval");
		expect(prompt).toContain("Do not call entity tools or emit backlog tasks");
	});

	it("ships a reaction script that compiles in the watcher runtime", async () => {
		await expect(
			compileReactionScript(duplicateMergeReaction),
		).resolves.toBeTruthy();
	});

	it("declares the model's explanatory extraction contract", async () => {
		const schema = await extractReactionInputSchema(duplicateMergeReaction);

		expect(schema?.required).toEqual(["analysis_summary", "uncertain_groups"]);
		expect(schema).toMatchObject({
			properties: {
				analysis_summary: { type: "string" },
				uncertain_groups: { type: "array" },
			},
		});
	});

	it("normalizes valid identities without merging malformed metadata", async () => {
		const calls = await runDuplicateMergeReaction([
			{ id: 1, metadata: { email: "not-an-email", phone: "call 1234567" } },
			{ id: 2, metadata: { email: "not-an-email", phone: "call 1234567" } },
			{ id: 3, metadata: { email: " Person@Example.com " } },
			{ id: 4, metadata: { emails: ["person@example.com"] } },
		]);

		expect(calls).toEqual([
			{
				action: "merge",
				winner_entity_id: 3,
				duplicate_entity_ids: [4],
				merge_evidence: [{ kind: "email", identifier: "person@example.com" }],
			},
		]);
	});

	it("produces the same proposal regardless of source row order", async () => {
		const people = [
			{
				id: 1,
				metadata: { email: "cycle@example.com", phone: "111 111 1111" },
			},
			{
				id: 2,
				metadata: { email: "cycle@example.com", phone: "222 222 2222" },
			},
			{ id: 3, metadata: { phones: ["111 111 1111", "222 222 2222"] } },
		];
		const forward = await runDuplicateMergeReaction(people);
		const reverse = await runDuplicateMergeReaction([...people].reverse());

		expect(reverse).toEqual(forward);
		expect(forward[0].merge_evidence).toEqual([
			{ kind: "email", identifier: "cycle@example.com" },
			{ kind: "phone", identifier: "1111111111" },
		]);
	});

	it("uses bounded evidence that connects every proposed duplicate", async () => {
		const redundantEmails = Array.from(
			{ length: 26 },
			(_, index) => `shared-${index}@example.com`,
		);
		const calls = await runDuplicateMergeReaction([
			{ id: 1, metadata: { emails: redundantEmails } },
			{
				id: 2,
				metadata: {
					emails: [...redundantEmails, "zzz-bridge@example.com"],
				},
			},
			{ id: 3, metadata: { email: "zzz-bridge@example.com" } },
		]);

		expect(calls[0].merge_evidence).toEqual([
			{ kind: "email", identifier: "shared-0@example.com" },
			{ kind: "email", identifier: "zzz-bridge@example.com" },
		]);
	});

	it("stays within merge entity limits", async () => {
		const eligible = await runDuplicateMergeReaction(
			Array.from({ length: 26 }, (_, index) => ({
				id: index + 1,
				metadata: { email: "group@example.com" },
			})),
		);
		expect(eligible).toHaveLength(1);
		expect(eligible[0].duplicate_entity_ids).toHaveLength(25);
		expect(eligible[0].merge_evidence).toHaveLength(1);

		const oversized = await runDuplicateMergeReaction(
			Array.from({ length: 27 }, (_, index) => ({
				id: index + 1,
				metadata: { email: "oversized@example.com" },
			})),
		);
		expect(oversized).toEqual([]);
	});

	it("fails before queuing partial approvals when the SDK call budget is too small", async () => {
		const people = Array.from({ length: 400 }, (_, index) => ({
			id: index + 1,
			metadata: { email: `group-${Math.floor(index / 2)}@example.com` },
		}));
		const atLimit = await executeDuplicateMergeReaction(people.slice(0, 398));
		expect(atLimit.result.success).toBe(true);
		expect(atLimit.calls).toHaveLength(199);

		const { calls, result } = await executeDuplicateMergeReaction(people);

		expect(result.success).toBe(false);
		expect(result.error?.message).toContain(
			"More than 199 identity components need merging",
		);
		expect(calls).toEqual([]);
	});
});
