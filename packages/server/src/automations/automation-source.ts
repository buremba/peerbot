/**
 * Who to attribute a durable write to, resolved once for every write surface.
 *
 * An acting Automation reaches a handler on two channels: `ctx.actingAutomationId`,
 * stamped by the reaction executor and therefore trustworthy, and a caller-declared
 * `automation_source` argument, which is ordinary user input. Every surface used to
 * merge them inline with `ctx.actingAutomationId ?? args.automation_source?.automation_id`,
 * which trusts the declared half without ever checking it names an Automation in
 * this organization. That has three consequences, all silent:
 *
 *   - a foreign id misattributes the write to another Automation, and where the
 *     value reaches `events.automation_id` it also inherits that Automation's
 *     causal chain (`workspace-event-enqueue.ts`)
 *   - a NONEXISTENT id fails the `events_automation_id_fkey` constraint, and
 *     because audit writes are fire-and-forget the row is dropped entirely
 *   - a declared window belonging to a different Automation batches this
 *     proposal into that Automation's approval card
 *
 * `notify.ts` has validated this field for exactly these reasons since it was
 * added; `execute.ts` started doing so in #2952. This module is that same rule
 * in one place, so a new write surface inherits it instead of re-deriving it.
 *
 * Kept free of tool and gateway imports so any write surface can reach it.
 */

import type { DbClient } from '../db/client';
import { getDb } from '../db/client';

/** The Automation a durable write is attributed to, after verification. */
export interface AutomationAttribution {
  automationId: number | null;
  windowId: number | null;
}

/** The `automation_source` shape every tool contract declares. */
export interface DeclaredAutomationSource {
  automation_id: number;
  window_id?: number | null;
}

/** The parts of a ToolContext this resolution reads. */
export interface ActingAutomationSession {
  organizationId: string;
  actingAutomationId?: number | null;
  actingWindowId?: number | null;
}

/**
 * Drop a declared source that does not name an Automation in this organization.
 *
 * Returns null rather than throwing: attribution is a provenance hint, and a bad
 * hint should cost the caller its attribution, not fail their tool call. The
 * window is not paired to the Automation here — `loadRunEventCausality` scopes
 * its run lookup to the producing Automation, so a foreign window inherits
 * nothing.
 */
export async function verifiedAutomationSource(
  declared: { automationId: number; windowId: number | null } | null,
  organizationId: string,
  // Resolved AFTER the guard, never as a default parameter: a default is
  // evaluated at call time, so `getDb()` would run on every call — including
  // the overwhelmingly common one with nothing declared, and including unit
  // suites that boot no database at all.
  db?: DbClient
): Promise<{ automationId: number; windowId: number | null } | null> {
  if (!declared) return null;
  const client = db ?? getDb();
  const rows = await client<{ id: number }>`
    SELECT id
    FROM automations
    WHERE id = ${declared.automationId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  return rows[0] ? declared : null;
}

/**
 * The Automation and window a write surface should record.
 *
 * The trusted session identity wins outright — including its window. Letting a
 * declared window through on a reaction session is what would let a script retag
 * its deferral into another Automation's approval batch, which is the precedence
 * every call site's comment already claimed without the code enforcing it.
 *
 * Off-session, the declared source is honored only once verified. An unverified
 * declaration yields no attribution at all rather than a half-applied one: a
 * window without its Automation names a batch nothing owns.
 */
export async function resolveAutomationAttribution(
  ctx: ActingAutomationSession,
  declared: DeclaredAutomationSource | null | undefined,
  db?: DbClient
): Promise<AutomationAttribution> {
  if (ctx.actingAutomationId != null) {
    return {
      automationId: ctx.actingAutomationId,
      windowId: ctx.actingWindowId ?? null,
    };
  }
  if (!declared) return { automationId: null, windowId: null };
  const verified = await verifiedAutomationSource(
    { automationId: declared.automation_id, windowId: declared.window_id ?? null },
    ctx.organizationId,
    db
  );
  return verified ?? { automationId: null, windowId: null };
}
