/**
 * The Automation driving the current call, as ambient request scope.
 *
 * Audit rows are written from 28 call sites across 15 files, and every one of
 * them should record WHO caused the change. Threading a producer id through all
 * of them would make provenance depend on each writer remembering to pass it —
 * and a forgotten site does not fail loudly, it silently records an audit row
 * claiming nobody did this. So the driving Automation is carried in request
 * scope instead, the same way `orgContext` carries the tenant.
 *
 * Reading absent as "no Automation" is correct rather than lossy: a human in
 * Owletto, a cron tick, and a connector sync genuinely ARE root causes, and
 * that is exactly what a null producer means to the activation path.
 *
 * The scope carries the driving RUN as well as the Automation, because the
 * audit-write path needs the run's causal ancestry to bound a mutual
 * A -> B -> A cascade — an audit row that starts a fresh root every time makes
 * the depth cap unreachable.
 *
 * Kept dependency-free so `insert-event.ts` can read it without pulling any
 * automation runtime into the write path.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface ActingAutomationScope {
  automationId: number;
  /**
   * The automation run driving this call, when the lane exposes one. Reaction
   * sessions carry it; agent tool calls do not (see `notify.ts`), which is why
   * {@link ActingAutomationScope.windowId} exists as the second route to the
   * same run.
   */
  runId: number | null;
  /**
   * The automation-run window driving this call. Resolves to the same run via
   * `runs.window_id`, covering the agent and device lanes where only a
   * caller-declared `automation_source` is available.
   */
  windowId: number | null;
}

const actingAutomationContext =
  new AsyncLocalStorage<ActingAutomationScope>();

/**
 * Run `fn` attributing every audit row it writes to `automationId`.
 *
 * A null/undefined id runs `fn` unattributed rather than inheriting an
 * enclosing scope, so a nested unattributed call cannot silently borrow the
 * caller's provenance.
 */
export function runWithActingAutomation<T>(
  acting: {
    automationId: number | null | undefined;
    runId?: number | null;
    windowId?: number | null;
  },
  fn: () => T
): T {
  if (acting.automationId == null) {
    return actingAutomationContext.exit(fn);
  }
  return actingAutomationContext.run(
    {
      automationId: acting.automationId,
      runId: acting.runId ?? null,
      windowId: acting.windowId ?? null,
    },
    fn
  );
}

/** The Automation driving this call, or null outside any automation scope. */
export function getActingAutomationId(): number | null {
  return actingAutomationContext.getStore()?.automationId ?? null;
}

/**
 * The full acting scope, for callers that need the run behind the Automation.
 *
 * Audit-row activation uses it to INHERIT the driving run's causal path
 * instead of minting a fresh root — which is what bounds an A -> B -> A
 * cascade, since depth only accrues when ancestry is carried forward.
 */
export function getActingAutomationScope(): {
  automationId: number;
  runId: number | null;
  windowId: number | null;
} | null {
  return actingAutomationContext.getStore() ?? null;
}
