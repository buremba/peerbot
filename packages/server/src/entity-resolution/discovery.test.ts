import { describe, expect, it } from "vitest";
import { discoverEntityResolutionGroups } from "./discovery";
import { assessEntityResolution } from "./policy";

const schema = {
	type: "object",
	"x-lobu-resolution": {
		rules: [
			{ fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
			{ fields: ["phone"], normalizer: "phone", onMatch: "review" },
		],
	},
};

describe("entity resolution module", () => {
	it("discovers connected components and chooses the most complete canonical record", () => {
		const result = discoverEntityResolutionGroups({
			metadataSchema: schema,
			candidates: [
				{ id: 3, metadata: { email: "person@example.com" } },
				{
					id: 4,
					metadata: {
						email: " Person@Example.com ",
						phone: "+44 123 456 789",
						title: "Engineer",
					},
				},
				{ id: 5, metadata: { phone: "44-123-456-789" } },
			],
		});
		expect(result).toEqual({
			groups: [{ winnerId: 4, loserIds: [3, 5] }],
			oversizedGroupCount: 0,
			deferredCandidateCount: 0,
		});
	});

	it("defers candidates without direct evidence to the chosen canonical record", () => {
		const chainSchema = {
			"x-lobu-resolution": {
				rules: [
					{ fields: ["email"], normalizer: "email", onMatch: "review" },
					{ fields: ["phone"], normalizer: "phone", onMatch: "review" },
					{ fields: ["external_id"], normalizer: "exact", onMatch: "review" },
				],
			},
		};
		const result = discoverEntityResolutionGroups({
			metadataSchema: chainSchema,
			candidates: [
				{ id: 1, metadata: { email: "same@example.com" } },
				{
					id: 2,
					metadata: { email: "same@example.com", phone: "+44 123 456 789" },
				},
				{
					id: 3,
					metadata: { phone: "+44 123 456 789", external_id: "remote-1" },
				},
				{ id: 4, metadata: { external_id: "remote-1" } },
			],
		});
		expect(result.groups).toEqual([{ winnerId: 2, loserIds: [1, 3] }]);
		expect(result.deferredCandidateCount).toBe(1);
	});

	it("does not invent matching semantics when the entity type has no policy", () => {
		const result = discoverEntityResolutionGroups({
			metadataSchema: { type: "object" },
			candidates: [
				{ id: 1, metadata: { email: "same@example.com" } },
				{ id: 2, metadata: { email: "same@example.com" } },
			],
		});
		expect(result.groups).toEqual([]);
	});

	it("keeps the built-in person watcher useful with review-only defaults", () => {
		const result = discoverEntityResolutionGroups({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			candidates: [
				{ id: 1, metadata: { email: "same@example.com" } },
				{ id: 2, metadata: { email: " SAME@example.com " } },
				{ id: 3, metadata: { phone: "+44 123 456 789" } },
				{ id: 4, metadata: { phone: "44-123-456-789" } },
			],
		});
		expect(result.groups).toEqual([
			{ winnerId: 1, loserIds: [2] },
			{ winnerId: 3, loserIds: [4] },
		]);
		const assessment = assessEntityResolution({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			winner: { id: 1, metadata: { email: "same@example.com" } },
			losers: [{ id: 2, metadata: { email: " SAME@example.com " } }],
		});
		expect(assessment.decision).toBe("review");
		expect(assessment.reason).toBe(
			"Matching email is evidence, but this entity type does not declare it unique enough to merge automatically.",
		);
	});

	it("auto-merges a configured unique identity but reviews conflicting strict identities", () => {
		const base = {
			metadataSchema: schema,
			winner: {
				id: 1,
				metadata: { email: "same@example.com", phone: "1111111" },
			},
		};
		expect(
			assessEntityResolution({
				...base,
				losers: [
					{
						id: 2,
						metadata: { email: "SAME@example.com", phone: "2222222" },
					},
				],
			}).decision,
		).toBe("auto_merge");

		const strictSchema = {
			...schema,
			"x-lobu-resolution": {
				rules: [
					{ fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
					{
						fields: ["external_id"],
						normalizer: "exact",
						onMatch: "auto_merge",
					},
				],
			},
		};
		const conflict = assessEntityResolution({
			metadataSchema: strictSchema,
			winner: {
				id: 1,
				metadata: { email: "same@example.com", external_id: "one" },
			},
			losers: [
				{
					id: 2,
					metadata: { email: "same@example.com", external_id: "two" },
				},
			],
		});
		expect(conflict.decision).toBe("review");

		const changedConflict = assessEntityResolution({
			metadataSchema: strictSchema,
			winner: {
				id: 1,
				metadata: { email: "same@example.com", external_id: "three" },
			},
			losers: [
				{
					id: 2,
					metadata: { email: "same@example.com", external_id: "four" },
				},
			],
		});
		expect(changedConflict.fingerprint).not.toBe(conflict.fingerprint);
	});

	it("rejects malformed email and phone values as deterministic identities", () => {
		expect(
			discoverEntityResolutionGroups({
				metadataSchema: schema,
				candidates: [
					{
						id: 1,
						metadata: { email: "not-an-email", phone: "call 1234567" },
					},
					{
						id: 2,
						metadata: { email: "not-an-email", phone: "call 1234567" },
					},
				],
			}).groups,
		).toEqual([]);
		expect(
			assessEntityResolution({
				metadataSchema: schema,
				winner: { id: 1, metadata: { email: "person@.example.com" } },
				losers: [{ id: 2, metadata: { email: "person@.example.com" } }],
			}).decision,
		).toBe("review");
	});

	it("matches an identity shared by multi-valued fields", () => {
		const assessment = assessEntityResolution({
			metadataSchema: schema,
			winner: {
				id: 1,
				metadata: {
					email: ["primary@example.com", "shared@example.com"],
				},
			},
			losers: [
				{
					id: 2,
					metadata: { email: ["SHARED@example.com"] },
				},
			],
		});
		expect(assessment.decision).toBe("auto_merge");
		expect(assessment.evidence).toContainEqual({
			kind: "email",
			identifier: "shared@example.com",
		});
	});

	it("changes the rejection fingerprint when a conflicting strict value changes", () => {
		const strictSchema = {
			"x-lobu-resolution": {
				rules: [
					{ fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
					{
						fields: ["external_id"],
						normalizer: "exact",
						onMatch: "auto_merge",
					},
				],
			},
		};
		const assess = (externalId: string) =>
			assessEntityResolution({
				metadataSchema: strictSchema,
				winner: {
					id: 1,
					metadata: { email: "same@example.com", external_id: "one" },
				},
				losers: [
					{
						id: 2,
						metadata: {
							email: "same@example.com",
							external_id: externalId,
						},
					},
				],
			});

		expect(assess("two").fingerprint).not.toBe(assess("three").fingerprint);
	});

	it("rejects oversized decision batches before returning partial work", () => {
		const candidates = Array.from({ length: 400 }, (_, index) => ({
			id: index + 1,
			metadata: { email: `pair-${Math.floor(index / 2)}@example.com` },
		}));
		expect(() =>
			discoverEntityResolutionGroups({
				metadataSchema: schema,
				candidates,
				maxGroups: 500,
				maxOperations: 199,
			}),
		).toThrow(/199 duplicate decisions/);
	});

	it("bounds direct-neighbor work for one oversized identity component", () => {
		const candidates = Array.from({ length: 5_000 }, (_, index) => ({
			id: index + 1,
			metadata: { email: "shared@example.com" },
		}));
		expect(
			discoverEntityResolutionGroups({
				metadataSchema: schema,
				candidates,
			}),
		).toEqual({
			groups: [],
			oversizedGroupCount: 1,
			deferredCandidateCount: 0,
		});
	});
});
