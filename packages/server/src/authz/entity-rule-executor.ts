/**
 * SPIKE — per-type entity write rules, executed at the row-write seam.
 *
 * Thesis under test: the automation-reaction pipeline (author a sibling .ts →
 * compile at apply → store → run in an isolate) already does everything write
 * rules need, so a rule is that pipeline pointed at a different trigger. This
 * file is the `reaction-executor.ts` analogue, minus everything a rule does not
 * need.
 *
 * What a rule does NOT need, and why that matters:
 *
 *   - No ClientSDK. `deny` and `escalate` are pure control flow, so they live
 *     entirely guest-side (see WRAPPER) and cross no bridge. The reaction path
 *     builds a jail + four `ivm.Reference` bridges + a dispatch manifest; that
 *     harness is the whole gap between a 0.63ms bare isolate and the 4.5ms I
 *     measured through `runScript`. A rule with no reads pays none of it.
 *   - No `getDb()`. Reads, when they land, take the caller's transaction handle.
 *     Acquiring a second connection inside `withEntityWriteTransaction` is the
 *     exact shape of the #2818 deadlock.
 *
 * The stub SDK below is a placeholder for a real `sdkMode: "none"`, which does
 * not exist yet — `SDKMode` is `"read" | "full"`. Adding it is what makes the
 * read budget enforceable by construction instead of by convention.
 */

import type { ClientSDK } from "../sandbox/client-sdk";
import { runScript } from "../sandbox/run-script";

/** Default wall-clock budget for one rule. Deliberately tight: this runs with a row lock held. */
const RULE_TIMEOUT_MS = 250;

export type EntityRuleVerdict =
	| { outcome: "allow" }
	| { outcome: "deny"; reason: string }
	| { outcome: "escalate"; fields: string[]; reason: string };

export interface EntityRuleInput {
	/** Compiled JS for the type's rule module. Produced at apply time by `compileSource`. */
	compiled: string;
	/** The row as committed, read under the lock. Reserved keys are `$name`, `$slug`, … */
	committed: Record<string, unknown>;
	/** The EFFECTIVE patch — post field-merge, so approval-held fields are already gone. */
	patch: Record<string, unknown>;
	actor: { kind: "user" | "agent" | "automation"; id: string | null };
	op: "create" | "update" | "delete";
	timeoutMs?: number;
}

/**
 * Guest-side wrapper generated around the author's module.
 *
 * This is the piece that removes the need for host bridges. `deny` throws a
 * tagged error the wrapper catches; `escalate` mutates a local. Both are
 * ordinary JS inside the isolate, so the whole verdict crosses the boundary
 * once, as a plain object, on return.
 *
 * At apply time this wraps the author's real module. Here it is applied to
 * already-compiled source so the spike can skip esbuild.
 */
export function wrapRuleSource(compiledRuleModule: string): string {
	return `${compiledRuleModule}
const __rule = (typeof rules !== "undefined" ? rules : undefined) ?? __lobuRule;
export default async (ctx) => {
  let verdict = { outcome: "allow" };
  const api = {
    committed: ctx.committed,
    patch: ctx.patch,
    next: { ...ctx.committed, ...ctx.patch },
    actor: ctx.actor,
    op: ctx.op,
    changed: (f) => Object.prototype.hasOwnProperty.call(ctx.patch, f),
    deny: (reason) => {
      const err = new Error(String(reason));
      err.__lobuDeny = true;
      throw err;
    },
    escalate: (fields, reason) => {
      verdict = {
        outcome: "escalate",
        fields: Array.isArray(fields) ? fields : [fields],
        reason: String(reason),
      };
    },
  };
  try {
    await __rule.check(api);
  } catch (err) {
    if (err && err.__lobuDeny) return { outcome: "deny", reason: err.message };
    throw err;
  }
  return verdict;
};`;
}

/**
 * Run one type's rule against one row's pending write.
 *
 * Returns a verdict; does NOT throw on deny. The caller decides whether a deny
 * becomes an `EntityRowValidationError` (enforcing) or a log line (inert), which
 * is what makes the inert-then-arm rollout a caller-side flag rather than a
 * second code path.
 */
export async function runEntityRule(
	input: EntityRuleInput,
): Promise<EntityRuleVerdict> {
	// Placeholder for `sdkMode: "none"`. A rule that declares no reads never
	// dispatches, so nothing behind this stub is reachable from the guest.
	const noSdk = { log: () => undefined } as unknown as ClientSDK;

	const result = await runScript({
		source: wrapRuleSource(input.compiled),
		sdk: noSdk,
		context: {
			committed: input.committed,
			patch: input.patch,
			actor: input.actor,
			op: input.op,
		},
		limits: { timeoutMs: input.timeoutMs ?? RULE_TIMEOUT_MS },
	});

	if (!result.success) {
		// A rule that crashes or times out fails CLOSED. It ran with a row lock
		// held and we cannot tell a bug from a deliberate infinite loop, so the
		// write does not proceed on the strength of a rule that did not finish.
		const detail = result.error
			? `${result.error.name}: ${result.error.message}`
			: "rule did not complete";
		return { outcome: "deny", reason: `rule failed: ${detail}` };
	}

	const verdict = result.returnValue as EntityRuleVerdict | undefined;
	if (!verdict || typeof verdict !== "object" || !("outcome" in verdict)) {
		return { outcome: "deny", reason: "rule returned no verdict" };
	}
	return verdict;
}
