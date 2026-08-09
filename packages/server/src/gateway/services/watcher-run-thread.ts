import { getDb, pgBigintArray } from "../../db/client.js";
import { paginateSessionMessages } from "./session-message-page.js";
import { BEHAVIOR_RUN_TYPES_PG } from "../../runs/run-types.js";

/**
 * Read the latest N durable watcher runs for one watcher, newest first, ready
 * to be stitched into a single read-only thread on the client. A transcript is
 * optional derived data: runs without one must still surface their approvals.
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
		status: string;
		task: string | null;
		pendingActionCount: number;
		autoAppliedCount: number;
		messages: ReturnType<typeof paginateSessionMessages>["messages"];
		actions: Array<{
			type: "tool-approval";
			eventId: number;
			runId: number;
			action: string | null;
			proposal: Record<string, unknown> | null;
			current: Record<string, unknown> | null;
			fields: Record<string, unknown> | null;
			attribution: string | null;
			resourceKind: string | null;
			reason: string | null;
			status: string;
			reviewedByName: string | null;
			windowId: number | null;
		}>;
		automaticActions: Array<{
			type: "entity-merge-result";
			operationId: number;
			status: "active" | "undone";
			canUndo: boolean;
			loser: {
				id: number;
				name: string;
				entityType: string;
				slug: string;
				parentEntityType: string | null;
				parentSlug: string | null;
			};
			winner: {
				id: number;
				name: string;
				entityType: string;
				slug: string;
				parentEntityType: string | null;
				parentSlug: string | null;
			};
			evidence: Array<{ kind: string; identifier: string }>;
			appliedAt: string;
		}>;
	}>;
}> {
	const { agentId, watcherId, organizationId, limit } = args;
	const sql = getDb();
	const rows = await sql<{
		conversation_id: string | null;
		created_at: Date;
		snapshot_jsonl: string | null;
		run_id: number;
		status: string;
		window_id: number | null;
		prompt: string | null;
	}>`
		WITH selected_runs AS (
			SELECT r.*
			FROM runs r
			JOIN watchers w
			  ON w.id = r.watcher_id
			 AND w.organization_id = r.organization_id
			WHERE r.organization_id = ${organizationId}
			  AND r.watcher_id = ${watcherId}
			  AND w.agent_id = ${agentId}
			  AND r.run_type = ANY(${BEHAVIOR_RUN_TYPES_PG}::text[])
			ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.id DESC
			LIMIT ${limit}
		)
		SELECT snapshot.conversation_id,
		       COALESCE(snapshot.created_at, r.completed_at, r.created_at) AS created_at,
		       snapshot.snapshot_jsonl, r.id AS run_id, r.status, r.window_id,
		       -- run_metadata->>'prompt_rendered' only exists on historical runs
		       -- from the templating era; current runs read the version's
		       -- literal prompt.
		       COALESCE(r.run_metadata->>'prompt_rendered', version.prompt) AS prompt
		FROM selected_runs r
		LEFT JOIN LATERAL (
			SELECT transcript.conversation_id, transcript.created_at,
			       transcript.snapshot_jsonl
			FROM public.agent_transcript_snapshot transcript
			WHERE transcript.organization_id = ${organizationId}
			  AND transcript.agent_id = ${agentId}
			  -- NOT transcript.run_id = r.id. A Behavior execution writes two run
			  -- rows: the scheduler's behavior row (r, the one this thread is
			  -- built from) and the chat_message row the worker actually claims.
			  -- The worker knows only the run it claimed, so it posts the snapshot
			  -- against the dispatch run and run_id = r.id matched no snapshot in
			  -- production. The behavior run id reaches the worker solely inside
			  -- the conversationId, so that is the join key: POST /api/v1/agents
			  -- builds it as agentId + _watcher_<behaviorId> + _run_<runId> from a
			  -- server-VERIFIED behavior_run intent, and rejects any other caller
			  -- that tries to construct the shape (behavior-run-intent.ts). Equality
			  -- on (organization_id, agent_id, conversation_id) is the leading
			  -- prefix of agent_transcript_snapshot_latest, so this stays a seek.
			  AND transcript.conversation_id =
			      ${agentId} || '_watcher_' || ${watcherId}::text
			      || '_run_' || r.id::text
			  AND transcript.terminal_status = 'completed'
			ORDER BY transcript.created_at DESC
			LIMIT 1
		) snapshot ON true
		LEFT JOIN watcher_versions version
		  ON version.id = (r.approved_input->>'version_id')::bigint
		ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.id DESC
	`;

	const runs = rows.map((row) => {
		const runId = Number(row.run_id);
		const messages = row.snapshot_jsonl
			? paginateSessionMessages(row.snapshot_jsonl, "", 200, {
					excludeVerbose: true,
					sessionIdFallback: row.conversation_id ?? `watcher-run-${runId}`,
				}).messages
			: [];
		return {
			runId,
			completedAt: row.created_at.toISOString(),
			status: row.status,
			task: row.prompt,
			pendingActionCount: 0,
			autoAppliedCount: 0,
			messages,
			actions: [] as Array<{
				type: "tool-approval";
				eventId: number;
				runId: number;
				action: string | null;
				proposal: Record<string, unknown> | null;
				current: Record<string, unknown> | null;
				fields: Record<string, unknown> | null;
				attribution: string | null;
				resourceKind: string | null;
				reason: string | null;
				status: string;
				reviewedByName: string | null;
				windowId: number | null;
			}>,
			automaticActions: [] as Array<{
				type: "entity-merge-result";
				operationId: number;
				status: "active" | "undone";
				canUndo: boolean;
				loser: {
					id: number;
					name: string;
					entityType: string;
					slug: string;
					parentEntityType: string | null;
					parentSlug: string | null;
				};
				winner: {
					id: number;
					name: string;
					entityType: string;
					slug: string;
					parentEntityType: string | null;
					parentSlug: string | null;
				};
				evidence: Array<{ kind: string; identifier: string }>;
				appliedAt: string;
			}>,
		};
	});
	const runIds = runs.map((run) => run.runId);
	const windowIds = rows.flatMap((row) =>
		row.window_id == null ? [] : [Number(row.window_id)],
	);

	// Approval cards are durable events rather than transcript JSONL parts. Read
	// them separately, then attach each to its producing watcher run by durable
	// source_run_id (new rows) or window_id (legacy rows).
	const approvalRows = await sql<{
		event_id: number;
		run_id: number;
		action: string | null;
		proposal: Record<string, unknown> | null;
		current: Record<string, unknown> | null;
		fields: Record<string, unknown> | null;
		attribution: string | null;
		resource_kind: string | null;
		reason: string | null;
		tool: string | null;
		window_id: number | null;
		source_run_id: number | null;
		interaction_status: string;
		reviewed_by_name: string | null;
	}>`
		SELECT e.id AS event_id,
		       e.run_id,
		       e.metadata->>'action' AS action,
		       e.metadata->'proposal' AS proposal,
		       e.metadata->'current' AS current,
		       e.metadata->'fields' AS fields,
		       e.metadata->>'attribution' AS attribution,
		       e.metadata->>'resourceKind' AS resource_kind,
		       e.metadata->>'reason' AS reason,
		       e.metadata->>'tool' AS tool,
		       e.interaction_status,
		       e.metadata->>'reviewed_by_name' AS reviewed_by_name,
		       r.window_id,
		       CASE
		         WHEN r.action_input->>'source_run_id' ~ '^[0-9]+$'
		         THEN (r.action_input->>'source_run_id')::bigint
		         ELSE NULL
		       END AS source_run_id
		FROM current_event_records e
		JOIN runs r ON r.id = e.run_id
		JOIN watchers w
		  ON w.id = r.watcher_id
		 AND w.organization_id = r.organization_id
		WHERE e.organization_id = ${organizationId}
		  AND w.agent_id = ${agentId}
		  AND r.watcher_id = ${watcherId}
		  AND e.interaction_type = 'approval'
		  AND (
		    (
		      r.action_input->>'source_run_id' ~ '^[0-9]+$'
		      AND (r.action_input->>'source_run_id')::bigint = ANY(${pgBigintArray(runIds)}::bigint[])
		    )
		    OR r.window_id = ANY(${pgBigintArray(windowIds)}::bigint[])
		  )
		ORDER BY e.run_id
	`;
	const actions = approvalRows.map((row) => {
		// Normalize legacy stored `resource_kind: "watcher"` to the public "behavior".
		const rawResourceKind =
			row.resource_kind ??
			(row.tool === "manage_behaviors"
				? "behavior"
				: row.tool === "manage_agents"
					? "agent"
					: row.tool === "entity_field_change" || row.tool === "entity_change"
						? "entity"
						: null);
		const resourceKind =
			rawResourceKind === "watcher" ? "behavior" : rawResourceKind;
		const rawProposal = row.proposal ?? null;
		const proposal =
			resourceKind === "behavior" &&
			rawProposal &&
			typeof rawProposal === "object" &&
			(rawProposal as { args?: unknown }).args &&
			typeof (rawProposal as { args: unknown }).args === "object"
				? (rawProposal as { args: Record<string, unknown> }).args
				: rawProposal;
		return {
			parentRunId: row.source_run_id == null ? null : Number(row.source_run_id),
			windowId: row.window_id == null ? null : Number(row.window_id),
			type: "tool-approval" as const,
			eventId: Number(row.event_id),
			runId: Number(row.run_id),
			action: row.action,
			proposal,
			current: row.current ?? null,
			fields: row.fields ?? null,
			attribution: row.attribution ?? null,
			resourceKind,
			reason: row.reason ?? null,
			status: row.interaction_status,
			reviewedByName: row.reviewed_by_name,
		};
	});

	const runById = new Map(runs.map((run) => [run.runId, run]));
	const runByWindow = new Map<number, (typeof runs)[number]>();
	for (const row of rows) {
		if (row.window_id == null || runByWindow.has(Number(row.window_id)))
			continue;
		const run = runById.get(Number(row.run_id));
		if (run) runByWindow.set(Number(row.window_id), run);
	}
	for (const { parentRunId, ...action } of actions) {
		const run =
			(parentRunId == null ? undefined : runById.get(parentRunId)) ??
			(action.windowId == null ? undefined : runByWindow.get(action.windowId));
		if (!run) continue;
		run.actions.push(action);
		if (action.status === "pending") run.pendingActionCount += 1;
	}

	if (runIds.length > 0) {
		const autoRows = await sql<{
			source_run_id: number;
			operation_id: number;
			status: "active" | "undone";
			can_undo: boolean;
			evidence: Array<{ kind: string; identifier: string }>;
			created_at: Date;
			loser_id: number;
			loser_name: string;
			loser_type: string;
			loser_slug: string;
			loser_parent_type: string | null;
			loser_parent_slug: string | null;
			winner_id: number;
			winner_name: string;
			winner_type: string;
			winner_slug: string;
			winner_parent_type: string | null;
			winner_parent_slug: string | null;
		}>`
			SELECT operation.source_run_id, operation.id AS operation_id,
			       operation.status, operation.evidence, operation.created_at,
			       operation.status = 'active'
			         AND loser.merged_into = operation.winner_entity_id
			         AND winner.deleted_at IS NULL
			         AND NOT EXISTS (
			           SELECT 1
			           FROM entity_merge_operations later
			           WHERE later.organization_id = operation.organization_id
			             AND later.winner_entity_id = operation.winner_entity_id
			             AND later.status = 'active'
			             AND later.id > operation.id
			         ) AS can_undo,
			       loser.id AS loser_id, loser.name AS loser_name,
			       loser_type.slug AS loser_type, loser.slug AS loser_slug,
			       loser_parent_type.slug AS loser_parent_type,
			       loser_parent.slug AS loser_parent_slug,
			       winner.id AS winner_id, winner.name AS winner_name,
			       winner_type.slug AS winner_type, winner.slug AS winner_slug,
			       winner_parent_type.slug AS winner_parent_type,
			       winner_parent.slug AS winner_parent_slug
			FROM entity_merge_operations operation
			JOIN entities loser
			  ON loser.id = operation.loser_entity_id
			 AND loser.organization_id = operation.organization_id
			JOIN entity_types loser_type ON loser_type.id = loser.entity_type_id
			LEFT JOIN entities loser_parent
			  ON loser_parent.id = loser.parent_id
			 AND loser_parent.organization_id = operation.organization_id
			LEFT JOIN entity_types loser_parent_type ON loser_parent_type.id = loser_parent.entity_type_id
			JOIN entities winner
			  ON winner.id = operation.winner_entity_id
			 AND winner.organization_id = operation.organization_id
			JOIN entity_types winner_type ON winner_type.id = winner.entity_type_id
			LEFT JOIN entities winner_parent
			  ON winner_parent.id = winner.parent_id
			 AND winner_parent.organization_id = operation.organization_id
			LEFT JOIN entity_types winner_parent_type ON winner_parent_type.id = winner_parent.entity_type_id
			WHERE operation.organization_id = ${organizationId}
			  AND operation.source_run_id = ANY(${pgBigintArray(runIds)}::bigint[])
			  AND operation.decision = 'auto_merge'
			ORDER BY operation.created_at, operation.id
		`;
		for (const row of autoRows) {
			const run = runById.get(Number(row.source_run_id));
			if (!run) continue;
			run.autoAppliedCount += 1;
			run.automaticActions.push({
				type: "entity-merge-result",
				operationId: Number(row.operation_id),
				status: row.status,
				canUndo: row.can_undo,
				loser: {
					id: Number(row.loser_id),
					name: row.loser_name,
					entityType: row.loser_type,
					slug: row.loser_slug,
					parentEntityType: row.loser_parent_type,
					parentSlug: row.loser_parent_slug,
				},
				winner: {
					id: Number(row.winner_id),
					name: row.winner_name,
					entityType: row.winner_type,
					slug: row.winner_slug,
					parentEntityType: row.winner_parent_type,
					parentSlug: row.winner_parent_slug,
				},
				evidence: row.evidence ?? [],
				appliedAt: row.created_at.toISOString(),
			});
		}
	}

	return { runs };
}
