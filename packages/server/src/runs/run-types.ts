/**
 * Behavior run types and the execution mode derived from them (evals PR 2,
 * lobu#2564).
 *
 * A Behavior run executes for real. An eval run replays a window to score it
 * and must never touch the outside world. Rather than a second table or an
 * `is_eval` column, an eval is a `runs.run_type` value — which means the ~18
 * existing `run_type = 'behavior'` predicates across the scheduler, reapers,
 * coalescing and behavior-health exclude evals with no code change at all.
 * Only the execution path opts back in, via {@link BEHAVIOR_RUN_TYPES}.
 *
 * The mode is ALWAYS derived here from the run row and never accepted from a
 * caller: it is computed at session creation (where the run row is already
 * being read to decide whether the session may exist) and then carried as a
 * signed worker-token claim, so an agent cannot ask to be live.
 */

/** A Behavior run whose side effects really happen. */
export const BEHAVIOR_RUN_TYPE = "behavior";

/** A replay of a Behavior window for scoring. Side effects are captured. */
export const BEHAVIOR_EVAL_RUN_TYPE = "behavior_eval";

/**
 * Run types the Behavior execution path accepts: claim, session creation,
 * window completion, run completion — plus the run-thread read, so an eval's
 * transcript can be read back for scoring.
 *
 * Deliberately NOT used by scheduling, coalescing or health predicates —
 * those stay `= 'behavior'` so evals never compete with, suppress, or degrade
 * a real Behavior.
 *
 * Reaping splits, and the test is whether the reaper touches anything beyond
 * the stranded row itself:
 * - Included — `resetOrphanedWatcherRuns` and `markStaleRunsAsTimeout`. Both
 *   only release or terminate the run they reap. Excluding evals there does
 *   not protect the Behavior, it just strands the eval forever, and because
 *   the claim guards are same-lane that wedges every later eval of it.
 * - Excluded — `finalizeStalePendingWatcherRuns`, which advances
 *   `next_run_at`. An eval must never move the live schedule.
 */
export const BEHAVIOR_RUN_TYPES: readonly string[] = [
	BEHAVIOR_RUN_TYPE,
	BEHAVIOR_EVAL_RUN_TYPE,
];

/**
 * The same list, pre-formatted as a Postgres `text[]` literal.
 *
 * Bind THIS at every `run_type = ANY(...)` site, never {@link BEHAVIOR_RUN_TYPES}
 * itself: the pool runs with `fetch_types: false`, so a raw JS array is sent as
 * the bare string `behavior,behavior_eval` and Postgres rejects it at runtime
 * with `malformed array literal` — a query that typechecks and then always
 * throws. Safe to build by `join` because both values are compile-time
 * identifier constants with nothing to escape.
 */
export const BEHAVIOR_RUN_TYPES_PG = `{${BEHAVIOR_RUN_TYPES.join(",")}}`;

/**
 * `live` executes side effects; `capture` records what the agent tried to do
 * and performs none of it.
 */
export type ExecutionMode = "live" | "capture";

/**
 * Fail closed: anything that is not a known live Behavior run captures. A run
 * type this module has not heard of never gets to write to the outside world.
 */
export function executionModeForRunType(
	runType: string | null | undefined,
): ExecutionMode {
	return runType === BEHAVIOR_RUN_TYPE ? "live" : "capture";
}
