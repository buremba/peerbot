import { describe, expect, it } from "vitest";
import {
	droppedEvidence,
	gainedEvidence,
	hasEvidenceStrengthened,
	hasMergeEvidenceStrengthened,
} from "./evidence-strength";

const phone = { kind: "phone", identifier: "905395102240" };
const email = { kind: "email", identifier: "a@example.com" };

describe("hasEvidenceStrengthened", () => {
	it("strengthens when a merge reviewed with no evidence gains proof", () => {
		// Legacy proposals can have no recorded evidence even though the current
		// matcher proves a shared identity.
		expect(hasEvidenceStrengthened([], [phone])).toBe(true);
	});

	it("strengthens when the re-check proves strictly more", () => {
		expect(hasEvidenceStrengthened([phone], [phone, email])).toBe(true);
	});

	it("does not strengthen when the evidence set is unchanged", () => {
		// A fingerprint can differ while evidence stands still — an identity row
		// added to one side only produces no match. The merge now carries a claim
		// nobody reviewed, so it must be re-presented, not applied.
		expect(hasEvidenceStrengthened([], [])).toBe(false);
		expect(hasEvidenceStrengthened([phone], [phone])).toBe(false);
	});

	it("does not strengthen when an item the reviewer relied on is gone", () => {
		expect(hasEvidenceStrengthened([phone], [])).toBe(false);
		expect(hasEvidenceStrengthened([phone, email], [email])).toBe(false);
	});

	it("does not strengthen on a swap that both gains and drops", () => {
		// Trading one proof for another is not a strengthening: what the reviewer
		// relied on stopped holding, whatever replaced it.
		expect(hasEvidenceStrengthened([phone], [email])).toBe(false);
	});

	it("treats a changed identifier under the same kind as a swap", () => {
		expect(
			hasEvidenceStrengthened([phone], [{ kind: "phone", identifier: "1" }]),
		).toBe(false);
	});

	it("does not let kind and identifier bleed across the key boundary", () => {
		// A delimiter-joined key would make these equal, reporting "unchanged" for
		// evidence that was never proven.
		expect(
			hasEvidenceStrengthened(
				[{ kind: "a b", identifier: "c" }],
				[{ kind: "a", identifier: "b c" }],
			),
		).toBe(false);
		expect(
			droppedEvidence(
				[{ kind: "a b", identifier: "c" }],
				[{ kind: "a", identifier: "b c" }],
			),
		).toEqual([{ kind: "a b", identifier: "c" }]);
	});

	it("ignores ordering and duplication", () => {
		expect(hasEvidenceStrengthened([phone], [email, phone, phone])).toBe(true);
	});
});

describe("droppedEvidence / gainedEvidence", () => {
	it("names what stopped holding, for the reviewer-facing message", () => {
		expect(droppedEvidence([phone, email], [email])).toEqual([phone]);
		expect(droppedEvidence([phone], [phone])).toEqual([]);
	});

	it("names what the re-check newly proved", () => {
		expect(gainedEvidence([], [phone])).toEqual([phone]);
		expect(gainedEvidence([phone], [phone])).toEqual([]);
	});
});

describe("hasMergeEvidenceStrengthened", () => {
	it("accepts a newly shared key on both merge sides", () => {
		expect(
			hasMergeEvidenceStrengthened({
				reviewedEvidence: [],
				currentEvidence: [phone],
				winnerId: 1,
				loserIds: [2],
				reviewedResolutionKeys: [
					{ id: 1, keys: {} },
					{ id: 2, keys: {} },
				],
				currentResolutionKeys: [
					{ id: 1, keys: { phone: [phone.identifier] } },
					{ id: 2, keys: { phone: [phone.identifier] } },
				],
			}),
		).toBe(true);
	});

	it("survives a rule field named like an Object prototype member", () => {
		// Rule fields are user-defined metadata field names, and these keys arrive
		// as JSON from runs.action_input. Indexing an object literal would read
		// Object.prototype.constructor and throw inside new Set(...).
		const run = () =>
			hasMergeEvidenceStrengthened({
				reviewedEvidence: [],
				currentEvidence: [phone],
				winnerId: 1,
				loserIds: [2],
				reviewedResolutionKeys: [
					{ id: 1, keys: {} },
					{ id: 2, keys: {} },
				],
				currentResolutionKeys: [
					{ id: 1, keys: { constructor: [phone.identifier] } },
					{ id: 2, keys: { constructor: [phone.identifier] } },
				],
			});
		expect(run).not.toThrow();
		expect(run()).toBe(true);
	});

	it("rejects a matching gain that hides a new one-sided identity", () => {
		expect(
			hasMergeEvidenceStrengthened({
				reviewedEvidence: [],
				currentEvidence: [phone],
				winnerId: 1,
				loserIds: [2],
				reviewedResolutionKeys: [
					{ id: 1, keys: {} },
					{ id: 2, keys: {} },
				],
				currentResolutionKeys: [
					{
						id: 1,
						keys: {
							phone: [phone.identifier],
							email: ["winner@example.com"],
						},
					},
					{
						id: 2,
						keys: {
							phone: [phone.identifier],
							email: ["loser@example.com"],
						},
					},
				],
			}),
		).toBe(false);
	});
});
