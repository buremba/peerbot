/**
 * Executes a type's compiled write rules at the entity row-write seam.
 *
 * BATCH-SHAPED BY CONSTRUCTION. One isolate evaluates every row in the batch,
 * not one isolate per row. A per-row design was built and measured first: it
 * tops out near 300 evals/sec, i.e. tens of seconds for a 5,000-row sync.
 *
 * Measured here on node 22, warm (all figures re-measured after the compile memo
 * in `run-script.ts` landed — an earlier revision of this comment quoted numbers
 * from a prototype and was wrong by 3x):
 *
 *   1 row          ~2.0ms      first call for a given rule ~14ms (one esbuild)
 *   50 rows        ~1.6ms
 *   1,000 rows     ~3.2ms      one full batch
 *   5,000 rows    ~29.7ms      five batches
 *
 * So roughly 1.6ms fixed per batch and ~0.002ms marginal per row. The rule still
 * runs once per row; only the instantiation is shared.
 *
 * `validateEntityRowPatch` is already batch-shaped (`ids: number[]`), so this
 * matches a shape the seam already had.
 *
 * A rule needs no ClientSDK: `deny` and `escalate` are pure control flow and
 * live entirely guest-side (see {@link RULE_RUNNER}), so nothing crosses an
 * `ivm.Reference`. The stub below stands in for an `sdkMode: "none"` that does
 * not exist yet — `SDKMode` is `"read" | "full"` — which is also what would make
 * a read budget enforceable by construction rather than by convention.
 */

import type { ClientSDK } from "../sandbox/client-sdk";
import { runScript } from "../sandbox/run-script";
import { compileSource } from "../utils/compiler-core";

/**
 * Wall-clock budget for one BATCH. Generous relative to the ~3ms + 0.002ms/row
 * cost curve, because it is spent holding row locks; {@link MAX_RULE_BATCH}
 * bounds how much work can sit behind it.
 */
const RULE_BATCH_TIMEOUT_MS = 2_000;

/**
 * Rows per isolate invocation. One batch blocks the event loop for its whole
 * duration, so this bounds a single uninterrupted block at ~3.2ms.
 *
 * 1,000 rather than a larger number because cost grows FASTER than linearly with
 * batch size — chunking is cheaper than one big call, not just kinder to the
 * event loop. Measured over the same 5,000 rows: at 2,000/batch the total was
 * 42.5ms with ~14-19ms blocks; at 1,000/batch it is 29.7ms with ~3.2ms blocks.
 * Unbounded batching would be worse on both axes.
 */
export const MAX_RULE_BATCH = 1_000;

export type EntityRuleVerdict =
	| { outcome: "allow" }
	| { outcome: "deny"; reason: string }
	| { outcome: "escalate"; fields: string[]; reason: string };

export interface EntityRuleRow {
	/** The row as committed, read under the lock. `{}` for a create. */
	committed: Record<string, unknown>;
	/** The EFFECTIVE patch — post field-merge, so approval-held fields are gone. */
	patch: Record<string, unknown>;
}

export interface EntityRuleBatch {
	/** Compiled JS for the type's rule module (`entity_types.rules_compiled`). */
	compiled: string;
	rows: EntityRuleRow[];
	/**
	 * `delete` is deliberately absent: a soft delete reaches this seam as an
	 * ordinary patch whose one governed column is `$deleted` flipping to true, so
	 * a rule judges it as an `update` and `changed("$deleted")` is what tells it
	 * apart. A hard delete (`force_delete_tree`) removes the row outright and
	 * never reaches this seam at all, so a `delete` op would be a contract only
	 * half the deletes could honour.
	 */
	op: "create" | "update";
	timeoutMs?: number;
}

/**
 * Guest-side runner wrapped around the author's module.
 *
 * This is what removes the need for host bridges. `deny` throws a tagged error
 * the runner catches; `escalate` accumulates into a local — repeated calls on
 * one row UNION their fields (deduped, first-seen order) and join their reasons
 * with `"; "`, so every escalated field reaches the verdict. A later `deny`
 * still wins, because it throws past whatever was accumulated. Both are
 * ordinary JS inside the isolate, so the whole verdict array crosses the
 * boundary once, on return.
 *
 * `changed(field)` compares VALUES between `committed` and `next`. It cannot be
 * key presence: the seam hands a rule the fully merged value set, not a delta, so
 * `hasOwnProperty` is true for every metadata key on every metadata write, and a
 * rule asking `changed("status")` would fire on an unrelated edit to any other
 * field. That was a real defect — an update touching only `amount` was denied by
 * a rule that only guards `status` — reproduced end to end before this comparison
 * replaced it.
 *
 * `ctx.actor` is deliberately ABSENT in this version. This seam judges "is the
 * resulting state legal", which has no principal in it — the permission question
 * (may this principal write this field) is answered earlier by `runMutationGate`.
 * Threading an actor here would also mean changing every caller of
 * `validateEntityRowPatch`, several of which are platform bookkeeping with no
 * actor at all. Actor-scoped denial is a deliberate follow-up, not an oversight.
 */
const RULE_RUNNER = `
const __lobuRule = __lobuRuleModule.default;
// Structural compare over JSON so nested objects and arrays behave, with
// undefined and null collapsed: a field absent from committed and written as
// null has not changed. See this module's doc for why it is not key presence.
const __lobuNorm = (v) => (v === undefined ? null : v);
const __lobuDiffers = (a, b) =>
  JSON.stringify(__lobuNorm(a)) !== JSON.stringify(__lobuNorm(b));
export default async (ctx) => {
  if (typeof __lobuRule !== "function") {
    throw new Error("entity rule must export default a function");
  }
  const verdicts = [];
  for (const row of ctx.rows) {
    let verdict = { outcome: "allow" };
    const escalatedFields = [];
    const escalatedReasons = [];
    const next = { ...row.committed, ...row.patch };
    const api = {
      committed: row.committed,
      patch: row.patch,
      next,
      op: ctx.op,
      changed: (f) => __lobuDiffers(row.committed[f], next[f]),
      deny: (reason) => {
        const err = new Error(String(reason));
        err.__lobuDeny = true;
        throw err;
      },
      escalate: (fields, reason) => {
        // UNION, not assignment. A rule may escalate several times for
        // different field sets; overwriting would keep only the last set, and
        // the earlier fields would ride through the same write unreviewed,
        // because the granting validator only ever sees this list.
        //
        // Both accumulators are per-row locals, never re-parsed out of the
        // verdict: deduping reasons by splitting the joined string on "; "
        // would tear a reason that itself contains "; " into segments, and
        // then silently drop a later distinct reason equal to one segment.
        for (const f of Array.isArray(fields) ? fields : [fields]) {
          if (!escalatedFields.includes(f)) escalatedFields.push(f);
        }
        const r = String(reason);
        if (!escalatedReasons.includes(r)) escalatedReasons.push(r);
        verdict = {
          outcome: "escalate",
          fields: escalatedFields.slice(),
          reason: escalatedReasons.join("; "),
        };
      },
    };
    try {
      await __lobuRule(api);
    } catch (err) {
      if (err && err.__lobuDeny) verdict = { outcome: "deny", reason: err.message };
      else throw err;
    }
    verdicts.push(verdict);
  }
  return verdicts;
};`;

/**
 * Compile an author's rule source into the artifact stored in
 * `entity_types.rules_compiled` — the exact string {@link runEntityRules}
 * later hands to `runScript`.
 *
 * The author's module is built as an IIFE bound to a global, NOT as a module,
 * and the ESM runner above is appended. That split is load-bearing: `runScript`
 * compiles its `source` itself, so the stored artifact has to survive a second
 * esbuild pass. Concatenating an already-CJS module with the runner's
 * `export default` would hand esbuild one file containing two module formats,
 * and the author's `module.exports` would resolve against the wrapper's own
 * exports rather than their module. As an IIFE the author's half is plain
 * statements, so the runner is the only module syntax in the file and the
 * second pass is unambiguous.
 *
 * Compiling at apply time (not write time) is the point of storing this at all.
 * Note `runScript` still runs the stored artifact through esbuild once per
 * distinct source per process, memoized by content hash in `run-script.ts`; what
 * apply-time compilation removes is the author's TypeScript, npm resolution and
 * bundling from the write path, not literally every esbuild call.
 */
export async function compileEntityRule(source: string): Promise<string> {
	const { compiledCode } = await compileSource(source, {
		tmpPrefix: ".entity-rule-compile-",
		label: "EntityRuleCompiler",
		buildOptions: {
			format: "iife",
			globalName: "__lobuRuleModule",
			target: "esnext",
			platform: "node",
			external: [],
		},
	});
	return `${compiledCode}\n${RULE_RUNNER}`;
}

/**
 * Evaluate one type's rule against a batch of rows.
 *
 * Returns one verdict per row, positionally. Never throws on a rule's own deny —
 * the caller decides whether a deny becomes an error (enforcing) or a log line
 * (inert), which keeps the inert-then-arm rollout a caller-side flag rather than
 * a second code path.
 *
 * A rule that crashes or times out FAILS CLOSED. It ran holding row locks and we
 * cannot distinguish a bug from a deliberate infinite loop, so the write does not
 * proceed on the strength of a rule that did not finish.
 */
export async function runEntityRules(
	batch: EntityRuleBatch,
): Promise<EntityRuleVerdict[]> {
	if (batch.rows.length === 0) return [];
	if (batch.rows.length > MAX_RULE_BATCH) {
		const out: EntityRuleVerdict[] = [];
		for (let i = 0; i < batch.rows.length; i += MAX_RULE_BATCH) {
			out.push(
				...(await runEntityRules({
					...batch,
					rows: batch.rows.slice(i, i + MAX_RULE_BATCH),
				})),
			);
		}
		return out;
	}

	// Placeholder for `sdkMode: "none"`. A rule declares no reads, so nothing
	// behind this stub is reachable from the guest.
	const noSdk = { log: () => undefined } as unknown as ClientSDK;

	const result = await runScript({
		source: batch.compiled,
		sdk: noSdk,
		context: { rows: batch.rows, op: batch.op },
		limits: { timeoutMs: batch.timeoutMs ?? RULE_BATCH_TIMEOUT_MS },
	});

	if (!result.success) {
		const detail = result.error
			? `${result.error.name}: ${result.error.message}`
			: "rule did not complete";
		return batch.rows.map(() => ({
			outcome: "deny" as const,
			reason: `rule failed: ${detail}`,
		}));
	}

	const verdicts = result.returnValue;
	if (!Array.isArray(verdicts) || verdicts.length !== batch.rows.length) {
		return batch.rows.map(() => ({
			outcome: "deny" as const,
			reason: "rule returned no usable verdict",
		}));
	}
	return verdicts as EntityRuleVerdict[];
}
