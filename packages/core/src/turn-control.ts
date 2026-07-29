/**
 * Turn-control classification: does an inbound message target the turn that is
 * ALREADY running, or does it start a new one?
 *
 * This lives in core because two independent sides need the same answer and
 * must not drift. The worker uses it to decide whether to steer or cancel an
 * active turn instead of queueing a fresh one; the gateway's dispatch gate uses
 * it to decide whether a message may be delivered to a worker that has a live
 * turn. A second copy of this logic in either place would let the gate withhold
 * exactly the messages the worker was waiting to act on.
 *
 * Both predicates are pure functions of the payload's metadata, so either side
 * can evaluate them without touching worker state.
 */

import type { MessagePayload } from "./worker/wire.js";

/**
 * Sources whose messages are machine-generated work, never a human follow-up
 * steering a conversation. Steering these into a live turn would splice
 * automation text into someone else's model context.
 */
const AUTOMATION_SOURCES = new Set([
  "watcher-run",
  "scheduled-job",
  "connector-repair",
  "internal",
  "automation",
]);

/**
 * Whether this message may be steered into an active turn rather than queued as
 * its own. Mirrors the worker's steering preconditions exactly — a message that
 * returns false here will start a NEW turn, so the dispatch gate must treat it
 * as new work.
 */
export function isSteerableHumanMessage(payload: MessagePayload): boolean {
  if (
    payload.platformMetadata?.behaviorId &&
    payload.platformMetadata?.behaviorActiveRunPolicy !== "steer"
  ) {
    return false;
  }
  // `/new` must run after the active turn: it flushes memory, deletes the
  // transcript, and purges durable snapshots. Steering it into the current Pi
  // session would treat the control command as ordinary text and preserve the
  // history the user explicitly asked to reset.
  if (payload.platformMetadata?.sessionReset === true) return false;
  // A `!`-bash message is a control action, not model input: steering it into an
  // active turn would feed the raw `!cmd` text to the model instead of running
  // it. Queue it as its own turn (the worker intercept runs the shell).
  if (payload.platformMetadata?.bangBash) return false;
  const source = payload.platformMetadata?.source;
  if (typeof source === "string" && AUTOMATION_SOURCES.has(source)) {
    return false;
  }
  const files = payload.platformMetadata?.files;
  return !Array.isArray(files) || files.length === 0;
}

/** Whether this message is an explicit request to abort the active turn. */
export function isExplicitCancelMessage(payload: MessagePayload): boolean {
  const metadata = payload.platformMetadata;
  if (metadata?.control === "cancel") return true;
  const intent = metadata?.intent;
  if (
    typeof intent === "object" &&
    intent !== null &&
    (intent as Record<string, unknown>).kind === "cancel"
  ) {
    return true;
  }
  return payload.messageText.trim().toLowerCase() === "/cancel";
}

/**
 * Whether this message acts on the turn already running on the worker — either
 * steering it or cancelling it — rather than asking for new work.
 *
 * The dispatch gate uses this as its exemption: such a message must reach the
 * worker even when that worker is stale, because withholding it does not
 * protect anything. The live turn is ALREADY executing with the stale
 * credentials, and deferring only means the user's follow-up or cancel silently
 * does nothing until the turn ends.
 */
export function targetsActiveTurn(payload: MessagePayload): boolean {
  return isExplicitCancelMessage(payload) || isSteerableHumanMessage(payload);
}
