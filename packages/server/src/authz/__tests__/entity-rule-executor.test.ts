/**
 * Proves the compile/execute round trip end to end: an author's TypeScript
 * source goes through `compileEntityRule` exactly as the apply path would store
 * it, and `runEntityRules` executes that stored string in a real isolate.
 *
 * Nothing here is mocked. The whole reason this file exists is the two-pass
 * compile — `compileEntityRule` builds the author's module, and `runScript`
 * compiles the stored artifact AGAIN. That composition is the thing most likely
 * to be silently wrong (a rule that evaluates to `undefined` would fail closed
 * and deny every write, which looks like working enforcement), so it is checked
 * against a running isolate rather than argued from the build flags.
 */

import { describe, expect, it } from "vitest";
import {
	compileEntityRule,
	MAX_RULE_BATCH,
	runEntityRules,
} from "../entity-rule-executor";

/** A transition rule of the shape an ontology author would actually write. */
const STATUS_RULE = `
const ALLOWED = {
  draft: ["review"],
  review: ["draft", "posted"],
  posted: [],
};

export default (row) => {
  if (!row.changed("status")) return;
  const from = row.committed.status;
  const to = row.next.status;
  if (row.op === "create") {
    if (to !== "draft") row.deny("a document must be created in draft, not " + to);
    return;
  }
  if (!(ALLOWED[from] ?? []).includes(to)) {
    row.deny("cannot move from " + from + " to " + to);
  }
  if (to === "posted") row.escalate(["status"], "posting needs sign-off");
};
`;

describe("compileEntityRule + runEntityRules", () => {
	it("runs a compiled rule and returns one verdict per row, positionally", async () => {
		const compiled = await compileEntityRule(STATUS_RULE);

		const verdicts = await runEntityRules({
			compiled,
			op: "update",
			// MERGED-shaped, because that is the only shape the seam produces:
			// `flatten` spreads the whole merged metadata into `patch`. Delta-shaped
			// fixtures used to hide a broken `changed()` here — the unit test passed
			// while the API mis-fired in production.
			rows: [
				{ committed: { status: "draft" }, patch: { status: "review" } },
				{ committed: { status: "posted" }, patch: { status: "draft" } },
				{ committed: { status: "review" }, patch: { status: "posted" } },
				{
					committed: { status: "draft" },
					patch: { status: "draft", $name: "renamed" },
				},
			],
		});

		expect(verdicts).toEqual([
			{ outcome: "allow" },
			{ outcome: "deny", reason: "cannot move from posted to draft" },
			{
				outcome: "escalate",
				fields: ["status"],
				reason: "posting needs sign-off",
			},
			{ outcome: "allow" },
		]);
	});

	it("treats a create as a transition from nothing", async () => {
		const compiled = await compileEntityRule(STATUS_RULE);

		// The bypass this whole seam exists to close: the same end state that the
		// rule refuses to reach by update must also be refused at birth.
		const [born] = await runEntityRules({
			compiled,
			op: "create",
			rows: [{ committed: {}, patch: { status: "posted" } }],
		});
		expect(born).toEqual({
			outcome: "deny",
			reason: "a document must be created in draft, not posted",
		});

		const [legal] = await runEntityRules({
			compiled,
			op: "create",
			rows: [{ committed: {}, patch: { status: "draft" } }],
		});
		expect(legal).toEqual({ outcome: "allow" });
	});

	it("changed() reports a VALUE change, not the presence of a key", async () => {
		// The defect this replaced: `changed` was `hasOwnProperty(patch, f)`, and
		// the seam hands over the merged value set, so `changed("status")` was true
		// on any metadata write at all. An update touching only `amount` was denied
		// by a rule that guards only `status`.
		const compiled = await compileEntityRule(
			`export default (row) => { if (row.changed("status")) row.deny("status moved"); };`,
		);

		const verdicts = await runEntityRules({
			compiled,
			op: "update",
			rows: [
				// status present and IDENTICAL, another field edited — must allow.
				{
					committed: { status: "draft", amount: 1 },
					patch: { status: "draft", amount: 2 },
				},
				// status actually different — must deny.
				{
					committed: { status: "draft", amount: 1 },
					patch: { status: "issued", amount: 1 },
				},
				// undefined and null are the same absence, not a change.
				{ committed: {}, patch: { status: null } },
				// Structural, so a nested object equal by value is unchanged.
				{
					committed: { status: { a: [1, 2] } },
					patch: { status: { a: [1, 2] } },
				},
				{
					committed: { status: { a: [1, 2] } },
					patch: { status: { a: [1, 3] } },
				},
			],
		});

		expect(verdicts.map((v) => v.outcome)).toEqual([
			"allow",
			"deny",
			"allow",
			"allow",
			"deny",
		]);
	});

	it("unions repeated escalate calls on the same row", async () => {
		// The defect: the runner ASSIGNED the verdict on every `escalate`, so a
		// rule that escalated `a` and then `b` reported only `b` — and `a` rode
		// along in the same write without review, because the granting validator
		// only ever sees the verdict's surviving field list.
		const compiled = await compileEntityRule(
			`export default (row) => {
				row.escalate(["a"], "r1");
				row.escalate("b", "r2");
			};`,
		);

		const [verdict] = await runEntityRules({
			compiled,
			op: "update",
			rows: [{ committed: {}, patch: { a: 1, b: 2 } }],
		});

		expect(verdict).toEqual({
			outcome: "escalate",
			fields: ["a", "b"],
			reason: "r1; r2",
		});
	});

	it("dedupes a field escalated twice, keeping first-seen order", async () => {
		const compiled = await compileEntityRule(
			`export default (row) => {
				row.escalate(["a", "b"], "r1");
				row.escalate(["b", "c"], "r1");
				row.escalate("a", "r3");
			};`,
		);

		const [verdict] = await runEntityRules({
			compiled,
			op: "update",
			rows: [{ committed: {}, patch: {} }],
		});

		expect(verdict).toEqual({
			outcome: "escalate",
			fields: ["a", "b", "c"],
			reason: "r1; r3",
		});
	});

	it("deny wins over an earlier escalate on the same row", async () => {
		const compiled = await compileEntityRule(
			`export default (row) => {
				row.escalate(["a"], "needs review");
				row.deny("illegal");
			};`,
		);

		const [verdict] = await runEntityRules({
			compiled,
			op: "update",
			rows: [{ committed: {}, patch: { a: 1 } }],
		});

		expect(verdict).toEqual({ outcome: "deny", reason: "illegal" });
	});

	it("fails closed when the rule throws an untagged error", async () => {
		const compiled = await compileEntityRule(
			`export default () => { throw new Error("boom"); };`,
		);

		const [verdict] = await runEntityRules({
			compiled,
			op: "update",
			rows: [{ committed: {}, patch: { a: 1 } }],
		});

		expect(verdict.outcome).toBe("deny");
		expect(verdict).toMatchObject({ reason: expect.stringMatching(/boom/) });
	});

	it("fails closed when the rule never finishes", async () => {
		const compiled = await compileEntityRule(
			`export default () => { while (true) {} };`,
		);

		const [verdict] = await runEntityRules({
			compiled,
			op: "update",
			timeoutMs: 250,
			rows: [{ committed: {}, patch: { a: 1 } }],
		});

		expect(verdict.outcome).toBe("deny");
	}, 20_000);

	it("fails closed when the module exports no function", async () => {
		const compiled = await compileEntityRule(`export const notDefault = 1;`);

		const [verdict] = await runEntityRules({
			compiled,
			op: "update",
			rows: [{ committed: {}, patch: { a: 1 } }],
		});

		expect(verdict.outcome).toBe("deny");
	});

	it("returns no verdicts for an empty batch without touching an isolate", async () => {
		expect(
			await runEntityRules({
				compiled: "not even valid JS",
				op: "update",
				rows: [],
			}),
		).toEqual([]);
	});

	it("chunks past MAX_RULE_BATCH and keeps every row's verdict in order", async () => {
		// Deny on odd index so a dropped or reordered chunk is visible in the
		// result rather than merely changing a count.
		const compiled = await compileEntityRule(
			`export default (row) => { if (row.next.n % 2 === 1) row.deny("odd " + row.next.n); };`,
		);
		const total = MAX_RULE_BATCH + 3;

		const verdicts = await runEntityRules({
			compiled,
			op: "update",
			rows: Array.from({ length: total }, (_, n) => ({
				committed: {},
				patch: { n },
			})),
		});

		expect(verdicts).toHaveLength(total);
		expect(verdicts[0]).toEqual({ outcome: "allow" });
		expect(verdicts[1]).toEqual({ outcome: "deny", reason: "odd 1" });
		// total is odd, so the final row is even-indexed and allowed; the row
		// before it is the last deny. Both are past the chunk boundary.
		expect(verdicts[total - 1]).toEqual({ outcome: "allow" });
		expect(verdicts[total - 2]).toEqual({
			outcome: "deny",
			reason: `odd ${total - 2}`,
		});
		expect(verdicts.filter((v) => v.outcome === "deny")).toHaveLength(
			Math.floor(total / 2),
		);
	}, 30_000);
});
