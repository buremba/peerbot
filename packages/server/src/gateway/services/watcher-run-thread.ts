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
	interactions: Array<{
		type: "tool-approval";
		runId: number;
		action: string | null;
		proposal: Record<string, unknown> | null;
		current: Record<string, unknown> | null;
		fields: Record<string, unknown> | null;
		attribution: string | null;
		resourceKind: string | null;
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
		WITH latest_per_run AS (
			SELECT DISTINCT ON (conversation_id)
			  conversation_id, created_at, snapshot_jsonl
			FROM public.agent_transcript_snapshot
			WHERE organization_id = ${organizationId}
			  AND agent_id = ${agentId}
			  AND conversation_id LIKE ${`${prefix}_run_%`}
			  AND terminal_status = 'completed'
			ORDER BY conversation_id, created_at DESC
		)
		SELECT conversation_id, created_at, snapshot_jsonl
		FROM latest_per_run
		ORDER BY created_at DESC
		LIMIT ${limit}
	`;

	const runs = rows.map((row) => {
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

	// Approval cards are durable events rather than transcript JSONL parts. A
	// pending approval may also belong to a run that has no completed snapshot,
	// so fetch it independently and let the client append it to the conversation.
	const approvalRows = await sql<{
		run_id: number;
		action: string | null;
		proposal: Record<string, unknown> | null;
		current: Record<string, unknown> | null;
		fields: Record<string, unknown> | null;
		attribution: string | null;
		resource_kind: string | null;
		tool: string | null;
	}>`
		SELECT e.run_id,
		       e.metadata->>'action' AS action,
		       e.metadata->'proposal' AS proposal,
		       e.metadata->'current' AS current,
		       e.metadata->'fields' AS fields,
		       e.metadata->>'attribution' AS attribution,
		       e.metadata->>'resourceKind' AS resource_kind,
		       e.metadata->>'tool' AS tool
		FROM current_event_records e
		JOIN runs r ON r.id = e.run_id
		JOIN watchers w
		  ON w.id = r.watcher_id
		 AND w.organization_id = r.organization_id
		WHERE e.organization_id = ${organizationId}
		  AND w.agent_id = ${agentId}
		  AND r.watcher_id = ${watcherId}
		  AND e.interaction_type = 'approval'
		  AND e.interaction_status = 'pending'
		ORDER BY e.run_id
	`;
	const interactions = approvalRows.map((row) => {
		const resourceKind =
			row.resource_kind ??
			(row.tool === "manage_watchers"
				? "watcher"
				: row.tool === "manage_agents"
					? "agent"
					: row.tool === "entity_field_change" || row.tool === "entity_change"
						? "entity"
						: null);
		const rawProposal = row.proposal ?? null;
		const proposal =
			resourceKind === "watcher" &&
			rawProposal &&
			typeof rawProposal === "object" &&
			(rawProposal as { args?: unknown }).args &&
			typeof (rawProposal as { args: unknown }).args === "object"
				? (rawProposal as { args: Record<string, unknown> }).args
				: rawProposal;
		return {
			type: "tool-approval" as const,
			runId: Number(row.run_id),
			action: row.action,
			proposal,
			current: row.current ?? null,
			fields: row.fields ?? null,
			attribution: row.attribution ?? null,
			resourceKind,
		};
	});

	return { runs, interactions };
}
