/**
 * Conversation branching ("Branch from here").
 *
 * Forks a thread into a NEW independent thread whose history is the prefix of
 * the source thread up to and including a chosen message. The original thread
 * is never mutated.
 *
 * Multi-replica correctness: a worker on a cold pod reconstructs history
 * EXCLUSIVELY from the latest `terminal_status='completed'` row in
 * `agent_transcript_snapshot` (see agent-worker `hydrateFromSnapshot`). So a
 * fork only has to INSERT a derived snapshot row under a fresh conversationId
 * — no workspace-file seeding is needed; the first worker on any replica
 * hydrates from Postgres.
 *
 * The forked row reuses the SOURCE row's `run_id` (the column has an FK to
 * `runs(id)` and is part of the UNIQUE (org, agent, conversation_id, run_id)
 * key). A different conversationId means no unique collision, the FK is
 * satisfied without minting a junk `runs` row, and the fork's first real run
 * writes a row with a higher monotonic `run_id` that supersedes this seed.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client.js";
import { buildApiConversationId } from "./api-conversation-id.js";

function newThreadId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 12);
}

interface ContentBlock {
	type?: string;
	id?: string;
	tool_use_id?: string;
}

/**
 * Accumulate open `tool_use` ids from one parsed session entry: assistant
 * `tool_use` blocks add an id; `tool_result` blocks (carried on `toolResult`
 * messages) clear the matching id. Used to keep a truncated prefix balanced.
 */
function updateOpenToolUses(parsed: unknown, open: Set<string>): void {
	const message = (parsed as { message?: { content?: unknown } } | null)
		?.message;
	const content = message?.content;
	if (!Array.isArray(content)) return;
	for (const block of content as ContentBlock[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "tool_use" && typeof block.id === "string") {
			open.add(block.id);
		}
		if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
			open.delete(block.tool_use_id);
		}
	}
}

/**
 * Truncate a `session.jsonl` blob to the prefix up to and including the line
 * whose entry `id === throughMessageId`. The leading `{type:"session"}` header
 * is always preserved (it sits at the top). When `throughMessageId` is omitted
 * the full blob is returned (a plain duplicate).
 *
 * After the chosen message the cut is extended forward over any trailing
 * entries needed to close open `tool_use` blocks, so the resulting prefix is a
 * valid resumable transcript (no dangling tool_use → no provider 400 on the
 * fork's first turn).
 *
 * Returns `null` when `throughMessageId` is given but matches no entry id.
 */
export function truncateSnapshotJsonl(
	snapshotJsonl: string,
	throughMessageId?: string,
): string | null {
	if (!throughMessageId) return snapshotJsonl;

	const rawLines = snapshotJsonl.split("\n");
	const parsedLines = rawLines.map((raw) => {
		const trimmed = raw.trim();
		if (!trimmed) return { raw, parsed: null as unknown };
		try {
			return { raw, parsed: JSON.parse(trimmed) as unknown };
		} catch {
			return { raw, parsed: null as unknown };
		}
	});

	let targetIdx = -1;
	for (let i = 0; i < parsedLines.length; i++) {
		const p = parsedLines[i].parsed as { type?: string; id?: string } | null;
		if (p && p.type !== "session" && p.id === throughMessageId) {
			targetIdx = i;
			break;
		}
	}
	if (targetIdx === -1) return null;

	const open = new Set<string>();
	for (let i = 0; i <= targetIdx; i++) {
		updateOpenToolUses(parsedLines[i].parsed, open);
	}

	let cut = targetIdx;
	for (let i = targetIdx + 1; i < parsedLines.length && open.size > 0; i++) {
		updateOpenToolUses(parsedLines[i].parsed, open);
		cut = i;
	}

	const kept = parsedLines
		.slice(0, cut + 1)
		.map((p) => p.raw)
		.join("\n");
	return kept.endsWith("\n") ? kept : `${kept}\n`;
}

export type ForkThreadResult =
	| { threadId: string }
	| { error: "no-snapshot" | "message-not-found" };

/**
 * Fork `sourceThreadId` into a new thread containing history up to and
 * including `throughMessageId`. Returns the new thread id, or an error
 * discriminant for the route to map to an HTTP status.
 */
export async function forkThread(args: {
	agentId: string;
	organizationId: string | undefined;
	userId: string;
	sourceThreadId: string;
	throughMessageId?: string;
}): Promise<ForkThreadResult> {
	const { agentId, organizationId, userId, sourceThreadId, throughMessageId } =
		args;
	// Forking is snapshot-mediated, and snapshots are org-scoped. The web home
	// chat always carries an org; without one there is nothing to fork.
	if (!organizationId) return { error: "no-snapshot" };

	const sql = getDb();
	const sourceConversationId = buildApiConversationId({
		agentId,
		userId,
		organizationId,
		threadId: sourceThreadId,
	});

	const rows = await sql<{ snapshot_jsonl: string; run_id: string }>`
    SELECT snapshot_jsonl, run_id
    FROM public.agent_transcript_snapshot
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND conversation_id = ${sourceConversationId}
      AND terminal_status = 'completed'
    ORDER BY run_id DESC
    LIMIT 1
  `;
	const source = rows[0];
	if (!source) return { error: "no-snapshot" };

	const truncated = truncateSnapshotJsonl(
		source.snapshot_jsonl,
		throughMessageId,
	);
	if (truncated === null) return { error: "message-not-found" };

	const newThread = newThreadId();
	const newConversationId = buildApiConversationId({
		agentId,
		userId,
		organizationId,
		threadId: newThread,
	});
	const byteSize = Buffer.byteLength(truncated, "utf-8");

	await sql`
    INSERT INTO public.agent_transcript_snapshot
      (organization_id, agent_id, conversation_id, run_id,
       snapshot_jsonl, byte_size, terminal_status)
    VALUES
      (${organizationId}, ${agentId}, ${newConversationId}, ${source.run_id},
       ${truncated}, ${byteSize}, 'completed')
  `;

	return { threadId: newThread };
}
