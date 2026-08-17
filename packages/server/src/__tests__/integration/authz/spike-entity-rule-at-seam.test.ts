/**
 * SPIKE — can a per-type code rule run at the entity row-write seam, and what
 * does it cost?
 *
 * Three questions, in order of how badly a "no" would hurt:
 *
 *   1. CONTROL FLOW — can deny / escalate / allow round-trip through the isolate
 *      without any host bridge? (If no, every rule needs an `ivm.Reference` and
 *      the cheap tier evaporates.)
 *   2. TRANSACTION SAFETY — can the isolate run while a write transaction is
 *      open and a row lock is held, and still commit? (If no, the whole seam
 *      position is wrong and rules have to move post-commit, which makes them
 *      advisory rather than enforcing.)
 *   3. COST — what does one rule actually add to a write?
 *
 * Run under Node, not Bun: `isolated-vm` is a V8 native addon and Bun's JSC
 * shim cannot dlopen it.
 */

import { describe, expect, it } from "vitest";
import { runEntityRule } from "../../../authz/entity-rule-executor";
import { getTestDb } from "../../setup/test-db";

/**
 * A rule module as an author would write it. `check` receives the wrapper's
 * guest-side api; `deny`/`escalate` are ordinary calls.
 */
const INVOICE_RULE = `
const __lobuRule = {
  check: async (ctx) => {
    if (ctx.committed.status === "posted" && ctx.changed("header_net"))
      ctx.deny("a posted invoice is immutable");

    const exits = { draft: ["issued"], issued: ["posted", "void"] };
    if (ctx.changed("status") && !exits[ctx.committed.status]?.includes(ctx.next.status))
      ctx.deny("cannot go " + ctx.committed.status + " -> " + ctx.next.status);

    if (ctx.next.status === "posted" && !ctx.next.einvoice_uuid)
      ctx.deny("posting requires an e-invoice UUID");

    if (ctx.changed("header_net") && ctx.next.header_net > 50000)
      ctx.escalate(["header_net"], "over the 50k limit");

    if (ctx.actor.kind === "agent" && ctx.changed("customer_id"))
      ctx.deny("reassigning an invoice is a human decision");
  },
};
`;

const AGENT = { kind: "agent" as const, id: "agent-1" };
const HUMAN = { kind: "user" as const, id: "user-1" };

function run(
	committed: Record<string, unknown>,
	patch: Record<string, unknown>,
	actor = AGENT,
) {
	return runEntityRule({
		compiled: INVOICE_RULE,
		committed,
		patch,
		actor,
		op: "update",
	});
}

describe("SPIKE 1 — control flow with no host bridge", () => {
	it("allows a legal transition", async () => {
		const v = await run(
			{ status: "draft", header_net: 1000 },
			{ status: "issued" },
		);
		expect(v).toEqual({ outcome: "allow" });
	});

	it("denies an illegal transition, and the reason survives the boundary", async () => {
		const v = await run(
			{ status: "draft", header_net: 1000 },
			{ status: "posted", einvoice_uuid: "x" },
		);
		expect(v.outcome).toBe("deny");
		expect(v).toMatchObject({ reason: "cannot go draft -> posted" });
	});

	it("denies a cross-field invariant violation", async () => {
		const v = await run({ status: "issued" }, { status: "posted" });
		expect(v).toMatchObject({
			outcome: "deny",
			reason: "posting requires an e-invoice UUID",
		});
	});

	it("escalates a threshold breach, carrying the field list", async () => {
		const v = await run({ status: "draft", header_net: 10 }, { header_net: 90_000 });
		expect(v).toEqual({
			outcome: "escalate",
			fields: ["header_net"],
			reason: "over the 50k limit",
		});
	});

	it("scopes a denial by actor kind — and the same write passes for a human", async () => {
		const patch = { customer_id: 77 };
		const asAgent = await run({ status: "draft" }, patch, AGENT);
		const asHuman = await run({ status: "draft" }, patch, HUMAN);
		expect(asAgent.outcome).toBe("deny");
		expect(asHuman.outcome).toBe("allow");
	});

	it("fails CLOSED when the rule throws", async () => {
		const v = await runEntityRule({
			compiled: `const __lobuRule = { check: async () => { throw new Error("boom"); } };`,
			committed: {},
			patch: {},
			actor: AGENT,
			op: "update",
		});
		expect(v.outcome).toBe("deny");
		expect((v as { reason: string }).reason).toContain("rule failed");
	});

	it("fails CLOSED when the rule never terminates", async () => {
		const v = await runEntityRule({
			compiled: `const __lobuRule = { check: async () => { while (true) {} } };`,
			committed: {},
			patch: {},
			actor: AGENT,
			op: "update",
			timeoutMs: 150,
		});
		expect(v.outcome).toBe("deny");
	}, 20_000);
});

describe("SPIKE 2 — running inside an open write transaction", () => {
	it("runs with a row lock held, and the transaction still commits", async () => {
		const db = getTestDb();

		await db`
      CREATE TABLE IF NOT EXISTS spike_rule_rows (
        id bigint PRIMARY KEY, status text NOT NULL, header_net numeric
      )`;
		await db`DELETE FROM spike_rule_rows WHERE id = 9001`;
		await db`INSERT INTO spike_rule_rows (id, status, header_net) VALUES (9001, 'draft', 1000)`;

		const verdicts: unknown[] = [];

		await db.begin(async (tx) => {
			// Same ordering as the real seam: lock, read committed, THEN evaluate.
			const [row] = await tx<{ status: string; header_net: string }[]>`
        SELECT status, header_net FROM spike_rule_rows WHERE id = 9001 FOR UPDATE`;

			const verdict = await runEntityRule({
				compiled: INVOICE_RULE,
				committed: { status: row.status, header_net: Number(row.header_net) },
				patch: { status: "issued" },
				actor: AGENT,
				op: "update",
			});
			verdicts.push(verdict);

			expect(verdict.outcome).toBe("allow");
			await tx`UPDATE spike_rule_rows SET status = 'issued' WHERE id = 9001`;
		});

		const [after] = await db<
			{ status: string }[]
		>`SELECT status FROM spike_rule_rows WHERE id = 9001`;

		expect(verdicts[0]).toEqual({ outcome: "allow" });
		expect(after.status).toBe("issued");

		await db`DROP TABLE spike_rule_rows`;
	}, 30_000);
});

describe("SPIKE 3 — cost", () => {
	it("reports cold vs steady-state per-write latency", async () => {
		// COLD — first sight of this source. Pays mkdtemp + esbuild + read back.
		const coldSource = INVOICE_RULE.replace("__lobuRule", "__lobuRule /*cold*/");
		const t0 = performance.now();
		await runEntityRule({
			compiled: coldSource,
			committed: { status: "draft" },
			patch: { status: "issued" },
			actor: AGENT,
			op: "update",
		});
		const cold = performance.now() - t0;

		// STEADY STATE — the shape a write path actually sees, where one rule
		// module per entity type is compiled once and then reused for every write.
		await run({ status: "draft", header_net: 1000 }, { status: "issued" });

		const N = 50;
		const samples: number[] = [];
		for (let i = 0; i < N; i++) {
			const t = performance.now();
			await run({ status: "draft", header_net: 1000 }, { status: "issued" });
			samples.push(performance.now() - t);
		}
		samples.sort((a, b) => a - b);
		const pct = (p: number) => samples[Math.min(N - 1, Math.floor(N * p))];

		console.log(
			`\n  cold (first compile of a source): ${cold.toFixed(1)}ms\n` +
				`  steady state (n=${N}):  p50 ${pct(0.5).toFixed(2)}ms  p95 ${pct(0.95).toFixed(2)}ms  min ${samples[0].toFixed(2)}ms  max ${samples[N - 1].toFixed(2)}ms\n` +
				`  Cold is paid once per rule module per process, at first write after deploy.\n`,
		);

		// Deliberately reports rather than asserts a ratio: whether steady state
		// beats cold depends on the compiled-source memo, which lives in its own
		// PR (#2838) and is asserted there by compile CALL COUNT. A timing ratio
		// here would be both a duplicate and a flake — a warm run is ~3ms, which
		// is inside normal CI jitter.
		expect(samples.length).toBe(N);
		expect(cold).toBeGreaterThan(0);
	}, 120_000);
});

/**
 * SPIKE 4 — does this scale?
 *
 * The single-threaded 3.2ms says nothing about production, where many rows are
 * written at once. Two distinct risks, easy to conflate:
 *
 *   - LATENCY under load: does per-rule time degrade with concurrency?
 *   - EVENT-LOOP STARVATION: `isolated-vm` runs guest code on the calling
 *     thread. Enough concurrent isolates and the Node event loop stops being
 *     scheduled at all — which takes down the whole process, not just writes.
 *     This is keyed on the PROCESS, not the row, so per-row locking does not
 *     bound it.
 *
 * The heartbeat is the instrument that matters. A timer set to fire every 5ms
 * records its ACTUAL gaps; if the loop is starved, ticks stop landing and the
 * max gap explodes. Throughput alone would hide this completely.
 */
describe("SPIKE 4 — scaling", () => {
	it("reports throughput and event-loop health vs concurrency", async () => {
		// Warm the compile memo so no sample pays for esbuild.
		await run({ status: "draft" }, { status: "issued" });

		const DURATION_MS = 700;
		const HEARTBEAT_MS = 5;
		const levels = [1, 2, 4, 8, 16];
		const rows: string[] = [];

		for (const workers of levels) {
			const gaps: number[] = [];
			let last = performance.now();
			const timer = setInterval(() => {
				const now = performance.now();
				gaps.push(now - last);
				last = now;
			}, HEARTBEAT_MS);

			const latencies: number[] = [];
			const deadline = performance.now() + DURATION_MS;
			let ops = 0;

			await Promise.all(
				Array.from({ length: workers }, async () => {
					while (performance.now() < deadline) {
						const t = performance.now();
						await run({ status: "draft", header_net: 1000 }, { status: "issued" });
						latencies.push(performance.now() - t);
						ops++;
					}
				}),
			);

			clearInterval(timer);

			latencies.sort((a, b) => a - b);
			const at = (p: number) =>
				latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
			const expectedTicks = Math.floor(DURATION_MS / HEARTBEAT_MS);
			const maxGap = gaps.length ? Math.max(...gaps) : Number.NaN;

			rows.push(
				`  ${String(workers).padStart(2)}  ` +
					`${(ops / (DURATION_MS / 1000)).toFixed(0).padStart(6)}  ` +
					`${at(0.5).toFixed(2).padStart(7)}  ${at(0.95).toFixed(2).padStart(7)}  ` +
					`|  ${String(gaps.length).padStart(3)}/${expectedTicks}  ` +
					`${(Number.isNaN(maxGap) ? 0 : maxGap).toFixed(1).padStart(7)}`,
			);
		}

		console.log(
			`\n  workers  ops/s   p50_ms   p95_ms  |  hb_ticks  hb_max_ms\n` +
				`  ${"-".repeat(58)}\n${rows.join("\n")}\n\n` +
				`  hb_ticks = event-loop heartbeats that landed vs expected (5ms timer).\n` +
				`  Ticks collapsing or hb_max exploding = the loop is starved and the\n` +
				`  PROCESS is degraded, not just this write.\n`,
		);

		expect(rows.length).toBe(levels.length);
	}, 180_000);
});

/**
 * SPIKE 5 — one isolate per ROW, or one per BATCH?
 *
 * SPIKE 4 says the per-row model tops out near 300 evals/sec per process and
 * degrades linearly under concurrency. That is survivable for interactive
 * writes and fatal for the bulk path: a connector sync upserting 10k entities
 * would spend ~30s of serialized isolate time and starve the loop throughout.
 *
 * But the seam is ALREADY batch-shaped — `validateEntityRowPatch({ ids: [] })`
 * takes many rows and holds one transaction. So the isolate can be too: hoist
 * the ~3ms fixed cost (compile lookup, isolate create, context, dispose) out of
 * the row loop and pay it once per (type, batch) instead of once per row.
 *
 * The rule semantics do not change — it still runs once per row. Only the
 * instantiation is shared.
 */
const BATCH_WRAPPER = `
export default async (ctx) => {
  const out = [];
  for (const row of ctx.rows) {
    let verdict = { outcome: "allow" };
    const api = {
      committed: row.committed,
      patch: row.patch,
      next: { ...row.committed, ...row.patch },
      actor: ctx.actor,
      op: ctx.op,
      changed: (f) => Object.prototype.hasOwnProperty.call(row.patch, f),
      deny: (reason) => { const e = new Error(String(reason)); e.__lobuDeny = true; throw e; },
      escalate: (fields, reason) => {
        verdict = { outcome: "escalate", fields: [].concat(fields), reason: String(reason) };
      },
    };
    try {
      await __lobuRule.check(api);
    } catch (err) {
      if (err && err.__lobuDeny) verdict = { outcome: "deny", reason: err.message };
      else throw err;
    }
    out.push(verdict);
  }
  return out;
};`;

describe("SPIKE 5 — per-row vs per-batch isolates", () => {
	it("compares cost of evaluating a batch row-by-row vs in one isolate", async () => {
		const { runScript } = await import("../../../sandbox/run-script");
		const stubSdk = { log: () => undefined } as unknown as never;

		const makeRows = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				committed: { status: "draft", header_net: 1000 + i },
				patch: { status: "issued" },
			}));

		// Warm both source variants so neither pays for esbuild.
		await run({ status: "draft" }, { status: "issued" });
		await runScript({
			source: INVOICE_RULE + BATCH_WRAPPER,
			sdk: stubSdk,
			context: { rows: makeRows(1), actor: AGENT, op: "update" },
			limits: { timeoutMs: 5_000 },
		});

		const out: string[] = [];
		// Above 200 the per-row leg is measured on a 200-row sample and scaled —
		// running 5000 sequential isolates just to confirm a straight line costs
		// ~17s and tells us nothing new. The BATCH leg is always measured whole,
		// because its shape is the open question.
		const PER_ROW_SAMPLE = 200;
		for (const size of [1, 10, 50, 200, 500, 1000, 5000]) {
			const rows = makeRows(size);

			const sampled = Math.min(size, PER_ROW_SAMPLE);
			const t1 = performance.now();
			for (const r of rows.slice(0, sampled)) await run(r.committed, r.patch);
			const perRow = ((performance.now() - t1) / sampled) * size;

			const t2 = performance.now();
			const res = await runScript({
				source: INVOICE_RULE + BATCH_WRAPPER,
				sdk: stubSdk,
				context: { rows, actor: AGENT, op: "update" },
				limits: { timeoutMs: 30_000 },
			});
			const perBatch = performance.now() - t2;

			const verdicts = res.returnValue as Array<{ outcome: string }>;
			expect(res.success).toBe(true);
			expect(verdicts).toHaveLength(size);
			expect(verdicts.every((v) => v.outcome === "allow")).toBe(true);

			out.push(
				`  ${String(size).padStart(3)}  ${perRow.toFixed(1).padStart(8)}  ` +
					`${perBatch.toFixed(1).padStart(9)}  ${(perRow / perBatch).toFixed(1).padStart(7)}x  ` +
					`${(perBatch / size).toFixed(3).padStart(9)}`,
			);
		}

		console.log(
			`\n  rows   per-row   per-batch   speedup   ms/row(batch)\n` +
				`  ${"-".repeat(52)}\n${out.join("\n")}\n\n` +
				`  Same rule, same verdicts. Only the isolate instantiation is shared.\n`,
		);

		expect(out.length).toBe(7);
	}, 180_000);
});
