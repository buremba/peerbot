/**
 * Completion for an agent turn run.
 *
 * A shadow turn reports what the isolate produced and stops there: the
 * conversation's reply still comes from the subprocess lane, so nothing is
 * delivered. What it writes is the transcript the turn produced, onto the run
 * row, which is how the two lanes are compared while the shadow runs.
 *
 * An authoritative turn additionally delivers: it appends the turn to the
 * conversation's transcript snapshot and publishes the `thread_response` the
 * client is waiting on, both inside the same fenced terminal transition, the
 * way `device-chat.ts` does for the other non-subprocess lane. Which of the
 * two a run is, is the run's own `turn.shadow`, stamped by the producer.
 */
import { parseSessionEntries } from "@lobu/core";
import {
	type CompleteAgentTurnRequest,
	CompleteAgentTurnRequestSchema,
} from "@lobu/core/contracts/worker/protocol";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "hono";
import { type DbClient, getDb } from "../db/client";
import type { TurnReply } from "../gateway/orchestration/agent-turn-shadow";
import {
	insertThreadResponseRow,
	notifyThreadResponse,
} from "../gateway/orchestration/turn-liveness";
import {
	MAX_SNAPSHOT_BYTES,
	readSnapshotJsonl,
} from "../gateway/services/transcript-snapshot";
import type { Env } from "../index";
import { runLeaseFence } from "../runs/run-lease";
import { stripNul } from "../utils/strip-nul";
import { authorizeRunForWorker } from "./shared";

/** What of the turn's own text is kept on the run row for the shadow diff. */
const MAX_OUTPUT_TAIL = 2_000;

/**
 * Append this turn's user message and reply to the conversation's transcript
 * snapshot, in the session-jsonl shape `parseSessionEntries` reads back — the
 * same blob the shadow producer already loads for history.
 *
 * `content` is pi's block array, not a bare string: every other writer of this
 * table emits blocks, and the readers that flatten it (`transcriptText`,
 * `trimContent`) are the only reason a bare string would survive at all.
 *
 * The row is keyed by `run_id`, and the lease fence already refuses a second
 * completion of the same run, so this insert never conflicts in practice —
 * `DO NOTHING` matches `device-chat.ts` and keeps a durable transcript
 * unoverwritable if one ever does.
 */
async function appendTurnSnapshot(
	tx: DbClient,
	args: {
		organizationId: string;
		agentId: string;
		conversationId: string;
		runId: number;
		userText: string;
		assistantText: string;
	},
): Promise<void> {
	if (!args.agentId || !args.conversationId) return;
	const previous = await readSnapshotJsonl({
		organizationId: args.organizationId,
		agentId: args.agentId,
		conversationId: args.conversationId,
		client: tx,
	});
	const now = new Date().toISOString();
	const prior = parseSessionEntries(previous ?? "").entries;
	const userId = `agent-turn-${args.runId}-user`;
	const entry = (
		id: string,
		role: string,
		text: string,
		parentId: string | null,
	) =>
		JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: now,
			message: { role, content: [{ type: "text", text }] },
		});

	// The turn is one user message and one reply, so the chain is fixed: the
	// reply hangs off the user message when there is one, off the prior tail
	// when the turn carried no text.
	const render = (base: string, tailId: string | null) => {
		const lines: string[] = [];
		if (args.userText) lines.push(entry(userId, "user", args.userText, tailId));
		if (args.assistantText) {
			lines.push(
				entry(
					`agent-turn-${args.runId}-assistant`,
					"assistant",
					args.assistantText,
					args.userText ? userId : tailId,
				),
			);
		}
		return lines.length > 0 ? `${base}${lines.join("\n")}\n` : null;
	};
	const base = previous
		? previous.endsWith("\n")
			? previous
			: `${previous}\n`
		: "";
	let snapshot = render(base, prior[prior.length - 1]?.id ?? null);
	if (snapshot === null) return;
	if (Buffer.byteLength(snapshot, "utf8") > MAX_SNAPSHOT_BYTES) {
		// A long-running conversation must not make the current turn fail: this
		// insert is inside the terminal transaction, so an oversize row would
		// roll back the completion and the reply and hang the client forever.
		// Start a compact continuation; the prior run's row stays queryable.
		snapshot = render("", null) as string;
	}
	await tx`
    INSERT INTO public.agent_transcript_snapshot
      (organization_id, agent_id, conversation_id, run_id,
       snapshot_jsonl, byte_size, terminal_status)
    VALUES
      (${args.organizationId}, ${args.agentId}, ${args.conversationId}, ${args.runId},
       ${snapshot}, ${Buffer.byteLength(snapshot, "utf8")}, 'completed')
    ON CONFLICT (organization_id, agent_id, conversation_id, run_id)
    DO NOTHING
  `;
}

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
		organization_id: string;
		action_input: Record<string, unknown> | null;
	}>`
    SELECT status, claimed_by, organization_id, action_input
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

	// `turn.shadow` is the run's own statement about what its reply is FOR.
	// A shadow records and stops; an authoritative turn also delivers. The
	// producer stamps it, so a run cannot change its mind here.
	const envelope = (run.action_input ?? {}) as {
		turn?: {
			shadow?: unknown;
			agent_id?: unknown;
			conversation_id?: unknown;
			message_text?: unknown;
		};
		reply?: TurnReply;
	};
	const isShadow = envelope.turn?.shadow === true;
	// Delivery needs somewhere to deliver TO. A producer that stamped an
	// authoritative turn without a reply envelope would otherwise transition
	// the run to completed and drop the answer, leaving the client waiting
	// forever; refusing keeps the run claimable instead.
	if (!isShadow && !envelope.reply) {
		return c.json(
			{ error: "Authoritative agent turn has no reply envelope" },
			409,
		);
	}

	const organizationId = run.organization_id;
	const failed = body.status === "failed";
	const error =
		typeof body.error === "string" ? stripNul(body.error).trim() : "";
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

	// One fenced transition. When the turn is authoritative the snapshot and
	// the thread_response join it inside the same transaction, so a client can
	// never observe a completed run whose answer was not persisted.
	const transitioned = await sql.begin(async (tx) => {
		const terminal = await tx`
      UPDATE public.runs
      SET status = ${failed ? "failed" : "completed"},
          completed_at = current_timestamp,
          error_message = ${failed ? error || "agent turn failed" : null},
          output_tail = ${text ? text.slice(-MAX_OUTPUT_TAIL) : null},
          exit_reason = ${body.exit_reason ?? (failed ? "error_message" : "ok")},
          action_input = ${sql.json(result)}
      WHERE id = ${body.run_id}
        ${runLeaseFence(tx, body.worker_id)}
      RETURNING id
    `;
		if (terminal.length === 0) return false;
		if (isShadow) return true;

		const reply = envelope.reply as TurnReply;
		const agentId = String(envelope.turn?.agent_id ?? "");
		const conversationId = String(envelope.turn?.conversation_id ?? "");
		if (!failed) {
			await appendTurnSnapshot(tx, {
				organizationId,
				agentId,
				conversationId,
				runId: body.run_id,
				userText: String(envelope.turn?.message_text ?? ""),
				assistantText: text,
			});
		}
		await insertThreadResponseRow(
			tx,
			{
				messageId: reply.message_id,
				channelId: reply.channel_id,
				conversationId,
				userId: reply.user_id,
				teamId: reply.team_id ?? "api",
				platform: reply.platform,
				organizationId,
				platformMetadata: reply.platform_metadata,
				...(failed
					? { error: error || "agent turn failed" }
					: { finalText: text }),
				processedMessageIds: [reply.message_id],
				timestamp: Date.now(),
			},
			organizationId,
		);
		return true;
	});
	if (!transitioned) {
		return c.json({
			ok: true,
			status: failed ? "failed" : "completed",
			idempotent: true,
		});
	}
	// Outside the transaction, as device-chat does: the listener must not be
	// woken for a row a rollback would take back.
	if (!isShadow) await notifyThreadResponse();
	return c.json({ ok: true, status: failed ? "failed" : "completed" });
}
