/**
 * Completion for an agent turn run.
 *
 * A shadow turn reports what the isolate produced and stops there: the
 * conversation's reply still comes from the subprocess lane, so nothing here
 * writes a thread response, a transcript snapshot or a turn marker. What it
 * does write is the transcript the turn produced, onto the run row, which is
 * how the two lanes are compared while the shadow runs.
 *
 * When the lane becomes authoritative this is where the reply and the snapshot
 * join, on the same fenced terminal transition.
 */
import {
	type CompleteAgentTurnRequest,
	CompleteAgentTurnRequestSchema,
} from "@lobu/core/contracts/worker/protocol";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "hono";
import { getDb } from "../db/client";
import type { Env } from "../index";
import { runLeaseFence } from "../runs/run-lease";
import { stripNul } from "../utils/strip-nul";
import { authorizeRunForWorker } from "./shared";

/** What of the turn's own text is kept on the run row for the shadow diff. */
const MAX_OUTPUT_TAIL = 2_000;

export async function completeAgentTurnRun(c: Context<{ Bindings: Env }>) {
	let rawBody: unknown;
	try {
		rawBody = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	if (!Value.Check(CompleteAgentTurnRequestSchema, rawBody)) {
		return c.json({ error: "Invalid agent turn completion body" }, 400);
	}
	const body = rawBody as CompleteAgentTurnRequest;
	// Fleet-only lane, so this waves the token through and the run's own
	// claimed_by/status read below is what enforces ownership and idempotency.
	const denied = await authorizeRunForWorker(c, body.run_id, body.worker_id);
	if (denied) return denied;

	const sql = getDb();
	const rows = await sql<{
		status: string;
		claimed_by: string | null;
		action_input: Record<string, unknown> | null;
	}>`
    SELECT status, claimed_by, action_input
    FROM public.runs
    WHERE id = ${body.run_id}
      AND run_type = 'agent_turn'
    LIMIT 1
  `;
	const run = rows[0];
	if (!run) return c.json({ error: "Agent turn run not found" }, 404);
	if (run.claimed_by !== body.worker_id || run.status !== "running") {
		return c.json({
			ok: true,
			status: run.status === "completed" ? "completed" : "failed",
			idempotent: true,
		});
	}

	// `turn.shadow` is the run's own statement about what its reply is FOR, and
	// this is the gate that gives it force. Today every producer sets it, and
	// the only thing this endpoint does with a reply is record it. A turn that
	// declared itself authoritative would therefore have its reply silently
	// dropped, so refuse it instead: whichever PR wires the reply path lands
	// that publish and this branch together.
	const envelope = (run.action_input ?? {}) as { turn?: { shadow?: unknown } };
	if (envelope.turn?.shadow !== true) {
		return c.json(
			{
				error:
					"Agent turn runs are observational: this endpoint records a reply, it does not deliver one",
			},
			409
		);
	}

	const failed = body.status === "failed";
	const error = typeof body.error === "string" ? stripNul(body.error).trim() : "";
	const text = typeof body.text === "string" ? stripNul(body.text) : "";
	// The turn's own output goes back on the row it came from, so a shadow run
	// is diffable against the subprocess reply without a second table.
	const result = {
		...(run.action_input ?? {}),
		result: {
			text,
			stop_reason: body.stop_reason ?? null,
			usage: body.usage ?? null,
			transcript: body.transcript ?? [],
		},
	};

	const transitioned = await sql`
    UPDATE public.runs
    SET status = ${failed ? "failed" : "completed"},
        completed_at = current_timestamp,
        error_message = ${failed ? error || "agent turn failed" : null},
        output_tail = ${text ? text.slice(-MAX_OUTPUT_TAIL) : null},
        exit_reason = ${body.exit_reason ?? (failed ? "error_message" : "ok")},
        action_input = ${sql.json(result)}
    WHERE id = ${body.run_id}
      ${runLeaseFence(sql, body.worker_id)}
    RETURNING id
  `;
	if (transitioned.length === 0) {
		return c.json({ ok: true, status: failed ? "failed" : "completed", idempotent: true });
	}
	return c.json({ ok: true, status: failed ? "failed" : "completed" });
}
