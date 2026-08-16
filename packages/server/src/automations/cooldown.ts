import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import logger from "../utils/logger";

/**
 * `automations.min_cooldown_seconds` debounce for event-triggered Automations.
 *
 * An Automation activates on an event through two substrates: background targets
 * become durable `automation` runs via `createAutomationEventRun`, and
 * `reply_to_source` targets are handed to the chat transport and never write a
 * run row at all. A predicate over `runs` would therefore be a silent no-op on
 * exactly one half of the feature, so both paths claim the same cursor
 * (`automations.last_event_activation_at`) through this module.
 *
 * The claim must be serialized, or two concurrent deliveries both read "no
 * recent activation" and both fire. It reuses the advisory lock
 * `createAutomationEventRun` already takes per Automation rather than introducing
 * a second one: the lock is transaction-scoped, so the read and the cursor
 * write cannot interleave with another replica's.
 */
const AUTOMATION_ACTIVATION_LOCK_NAMESPACE = "automation_event_run";

/**
 * Serialize activation decisions for one Automation. Transaction-scoped: the
 * lock is released when `tx` commits or rolls back.
 */
export async function lockAutomationForActivation(
  tx: DbClient,
  automationId: number,
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtext(${AUTOMATION_ACTIVATION_LOCK_NAMESPACE}),
      ${automationId}
    )
  `;
}

/**
 * Consume this Automation's cooldown window, returning whether the activation
 * may proceed. Callers MUST already hold `lockAutomationForActivation` on the
 * same transaction — the read and the write below are only atomic together.
 *
 * An Automation with `min_cooldown_seconds = 0` (the NOT NULL default) is always
 * allowed and never writes the cursor, so the common path costs one indexed
 * read and no row contention.
 *
 * Returns false for an Automation that no longer exists: a deleted Automation has
 * nothing to activate.
 */
export async function claimAutomationCooldown(
  tx: DbClient,
  automationId: number,
): Promise<boolean> {
  const rows = await tx`
    SELECT
      min_cooldown_seconds,
      last_event_activation_at IS NOT NULL
        AND last_event_activation_at >
            clock_timestamp() - make_interval(secs => min_cooldown_seconds)
        AS within_cooldown
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    logger.warn(
      { automationId },
      "[cooldown] Automation row missing while claiming an activation — suppressing",
    );
    return false;
  }
  const cooldownSeconds = Number(row.min_cooldown_seconds ?? 0);
  if (!(cooldownSeconds > 0)) return true;
  if (row.within_cooldown === true) {
    logger.info(
      { automationId, cooldownSeconds },
      "[cooldown] Suppressing Automation activation inside its min_cooldown_seconds window",
    );
    return false;
  }
  await tx`
    UPDATE automations
    SET last_event_activation_at = clock_timestamp()
    WHERE id = ${automationId}
  `;
  return true;
}

/**
 * Claim the cooldown for a caller that has no ambient transaction — the chat
 * reply path, which does not create a run row. Opens its own short transaction
 * so the lock scope stays tight.
 *
 * The window is consumed at the moment of the claim, not when the turn is
 * delivered: a caller that throws after claiming burns one window. That is the
 * right trade for a debounce (at worst one event is dropped) and the opposite
 * choice — claiming after delivery — would let a concurrent burst through.
 * Database failures propagate to the caller; they must never be reported as an
 * ordinary cooldown suppression.
 */
export async function claimAutomationCooldownStandalone(
  automationId: number,
  db?: DbClient,
): Promise<boolean> {
  const sql = db ?? getDb();
  try {
    return await sql.begin(async (tx: DbClient) => {
      await lockAutomationForActivation(tx, automationId);
      return await claimAutomationCooldown(tx, automationId);
    });
  } catch (error) {
    logger.error(
      { error, automationId },
      "[cooldown] Could not claim an Automation cooldown window — activation failed",
    );
    throw error;
  }
}
