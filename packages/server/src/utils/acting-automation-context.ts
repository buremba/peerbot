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
 * Kept dependency-free so `insert-event.ts` can read it without pulling any
 * automation runtime into the write path.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface ActingAutomationScope {
  automationId: number;
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
  automationId: number | null | undefined,
  fn: () => T
): T {
  if (automationId == null) {
    return actingAutomationContext.exit(fn);
  }
  return actingAutomationContext.run({ automationId }, fn);
}

/** The Automation driving this call, or null outside any automation scope. */
export function getActingAutomationId(): number | null {
  return actingAutomationContext.getStore()?.automationId ?? null;
}
