/**
 * Capture-mode guard for internal worker routes (evals PR 2, lobu#2564).
 *
 * The SDK lane already captures: `sandbox/run-script.ts` skips and records any
 * method whose `METHOD_METADATA` access is not `read`, and `tools/sdk_run.ts`
 * forces that path on for a capture run. But the agent framework also calls a
 * handful of internal routes DIRECTLY, without going through the SDK — sending
 * a real chat message, posting an interaction card, delivering files into the
 * conversation, executing in a sandbox, generating billable media. Those are
 * the ones that would still reach the outside world during an eval replay.
 *
 * This guard is the one thing those routes need. It reads the signed
 * `executionMode` claim off the already-verified worker token — no DB lookup,
 * no re-derivation from the conversationId — and, when the run is a capture
 * run, records the attempt and answers with a success-shaped body so the agent
 * continues its turn normally. A capture run that got an error back would
 * mostly be measuring its own retry logic, which is not the behaviour we want
 * to score.
 */

import type { Context } from "hono";
import logger from "../../../utils/logger.js";
import { getVerifiedWorker } from "../shared/helpers.js";
import type { WorkerContext } from "./types.js";

/**
 * True when this worker's run must not perform side effects. Sourced from the
 * signed token claim set at session creation from `runs.run_type`.
 */
function isCaptureRun(c: Context<WorkerContext>): boolean {
	return getVerifiedWorker(c).executionMode === "capture";
}

/**
 * Short-circuit a mutating internal route when the run is an eval replay.
 * Returns a Response to return immediately, or null to proceed for real.
 *
 * `action` names the side effect that did not happen (e.g.
 * `conversations.send`); `details` is the payload worth scoring later. Both go
 * to the run log, which is what an eval reads back to judge what the agent
 * TRIED to do.
 *
 * `responseBody` overrides the default `{ success, captured, ... }` body for
 * routes whose caller parses a specific contract off a 2xx rather than just
 * checking `ok` — e.g. `runtime.exec`, where the worker reads
 * `{ stdout, exitCode }` and an absent exitCode is reported to the agent as
 * the command failing (exit 1), which would send a capture run into retry
 * loops instead of continuing its turn.
 */
export function captureSideEffect(
	c: Context<WorkerContext>,
	action: string,
	details: Record<string, unknown>,
	responseBody?: Record<string, unknown>,
): Response | null {
	if (!isCaptureRun(c)) return null;
	const worker = getVerifiedWorker(c);
	logger.info(
		{
			evalCapture: true,
			action,
			details,
			agentId: worker.agentId,
			organizationId: worker.organizationId,
			conversationId: worker.conversationId,
		},
		`[eval-capture] suppressed ${action} for a capture run`,
	);
	return c.json(
		responseBody ?? {
			success: true,
			captured: true,
			action,
			message: "Recorded but not performed: this run is an evaluation replay.",
		},
	);
}
