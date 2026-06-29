import { getDb } from "../../db/client.js";
import { buildApiConversationId } from "./api-conversation-id.js";
import { paginateSessionMessages } from "./session-message-page.js";

/**
 * Read the latest N completed watcher-run transcripts for one watcher, newest
 * first, ready to be stitched into a single read-only thread on the client.
 *
 * Watcher sessions are org-EXEMPT in their conversation id (built as
 * `{agentId}_watcher_{watcherId}_run_{runId}`, no org segment — see
 * `routes/public/agent.ts`), yet the persisted `agent_transcript_snapshot` row
 * still carries the real `organization_id`. So we match rows by org + the
 * org-less id prefix, and key each run off the `_run_<id>` suffix.
 */
export async function readWatcherRunThreads(args: {
	agentId: string;
	watcherId: number;
	organizationId: string;
	limit: number;
}): Promise<{
	runs: Array<{
		runId: number;
		completedAt: string;
		messages: ReturnType<typeof paginateSessionMessages>["messages"];
	}>;
}> {
	const { agentId, watcherId, organizationId, limit } = args;
	// `{agentId}_watcher_{watcherId}` — the org-less prefix the worker wrote.
	const prefix = buildApiConversationId({
		agentId,
		userId: `watcher_${watcherId}`,
	});

	const sql = getDb();
	const rows = await sql<{
		conversation_id: string;
		created_at: Date;
		snapshot_jsonl: string;
	}>`
    SELECT DISTINCT ON (conversation_id)
      conversation_id, created_at, snapshot_jsonl
    FROM public.agent_transcript_snapshot
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND conversation_id LIKE ${`${prefix}_run_%`}
      AND terminal_status = 'completed'
    ORDER BY conversation_id, created_at DESC
  `;

	// DISTINCT ON gives the latest snapshot per run; order across runs by recency.
	const recent = rows
		.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
		.slice(0, limit);

	const runs = recent.map((row) => {
		const runId = Number(row.conversation_id.match(/_run_(\d+)$/)?.[1] ?? 0);
		const { messages } = paginateSessionMessages(row.snapshot_jsonl, "", 200, {
			excludeVerbose: true,
			sessionIdFallback: row.conversation_id,
		});
		return {
			runId,
			completedAt: row.created_at.toISOString(),
			messages,
		};
	});

	return { runs };
}
