import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import logger from "../utils/logger";

/**
 * `behaviors.min_cooldown_seconds` debounce for event-triggered Behaviors.
 *
 * A Behavior activates on an event through two substrates: background targets
 * become durable `behavior` runs via `createBehaviorEventRun`, and
 * `reply_to_source` targets are handed to the chat transport and never write a
 * run row at all. A predicate over `runs` would therefore be a silent no-op on
 * exactly one half of the feature, so both paths claim the same cursor
 * (`behaviors.last_event_activation_at`) through this module.
 *
 * The claim must be serialized, or two concurrent deliveries both read "no
 * recent activation" and both fire. It reuses the advisory lock
 * `createBehaviorEventRun` already takes per Behavior rather than introducing
 * a second one: the lock is transaction-scoped, so the read and the cursor
 * write cannot interleave with another replica's.
 */
const BEHAVIOR_ACTIVATION_LOCK_NAMESPACE = "behavior_event_run";

/**
 * Serialize activation decisions for one Behavior. Transaction-scoped: the
 * lock is released when `tx` commits or rolls back.
 */
export async function lockBehaviorForActivation(
  tx: DbClient,
  behaviorId: number,
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtext(${BEHAVIOR_ACTIVATION_LOCK_NAMESPACE}),
      ${behaviorId}
    )
  `;
}

/**
 * Consume this Behavior's cooldown window, returning whether the activation
 * may proceed. Callers MUST already hold `lockBehaviorForActivation` on the
 * same transaction — the read and the write below are only atomic together.
 *
 * A Behavior with `min_cooldown_seconds = 0` (the NOT NULL default) is always
 * allowed and never writes the cursor, so the common path costs one indexed
 * read and no row contention.
 *
 * Returns false for a Behavior that no longer exists: a deleted Behavior has
 * nothing to activate.
 */
export async function claimBehaviorCooldown(
  tx: DbClient,
  behaviorId: number,
): Promise<boolean> {
  const rows = await tx`
    SELECT
      min_cooldown_seconds,
      last_event_activation_at IS NOT NULL
        AND last_event_activation_at >
            clock_timestamp() - make_interval(secs => min_cooldown_seconds)
        AS within_cooldown
    FROM behaviors
    WHERE id = ${behaviorId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    logger.warn(
      { behaviorId },
      "[cooldown] Behavior row missing while claiming an activation — suppressing",
    );
    return false;
  }
  const cooldownSeconds = Number(row.min_cooldown_seconds ?? 0);
  if (!(cooldownSeconds > 0)) return true;
  if (row.within_cooldown === true) {
    logger.info(
      { behaviorId, cooldownSeconds },
      "[cooldown] Suppressing Behavior activation inside its min_cooldown_seconds window",
    );
    return false;
  }
  await tx`
    UPDATE behaviors
    SET last_event_activation_at = clock_timestamp()
    WHERE id = ${behaviorId}
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
export async function claimBehaviorCooldownStandalone(
  behaviorId: number,
  db?: DbClient,
): Promise<boolean> {
  const sql = db ?? getDb();
  try {
    return await sql.begin(async (tx: DbClient) => {
      await lockBehaviorForActivation(tx, behaviorId);
      return await claimBehaviorCooldown(tx, behaviorId);
    });
  } catch (error) {
    logger.error(
      { error, behaviorId },
      "[cooldown] Could not claim a Behavior cooldown window — activation failed",
    );
    throw error;
  }
}
