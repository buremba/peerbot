import type { DbClient } from "../../db/client";
import { getDb } from "../../db/client";
import { insertEvent } from "../../utils/insert-event";

/**
 * The human who decided an approval. Threaded from the approve/reject handler
 * into every event of the post-decision chain so each state records who
 * authorized it. `null` denotes a later system-driven transition.
 */
export interface ApprovalReviewer {
	userId: string;
	name: string | null;
}

/**
 * Fail-closed guard for a managed approval DECISION's card. {@link
 * supersedeActionEvent} returns `undefined` when the run has NO approval card
 * (`current_event_records` has no matching `interaction_type='approval'` row) —
 * which is legitimate only for auto/no-approval worker actions that never had a
 * card. A managed approval DECISION (approve/reject/expire) must never commit
 * its runs write without the card, or the run goes terminal while the timeline
 * stays stuck at the prior card. Callers throw on `undefined` so the enclosing
 * transaction rolls the runs write back.
 */
export function requireApprovalCard(
	runId: number,
	eventId: number | undefined,
	transition: string,
): asserts eventId is number {
	if (eventId === undefined) {
		throw new Error(
			`Cannot transition approval run ${runId} to '${transition}': its approval card is missing`,
		);
	}
}

/**
 * Atomically persist a claimed run's terminal 'completed' state AND its
 * 'completed' card. The runs write is guarded (status='running' AND
 * approval_status='approved'), so concurrent terminalizations — a human retry
 * and the stale-run reaper — cannot double-finalize: exactly one UPDATE wins,
 * the loser matches zero rows and writes no card. The card guard runs INSIDE
 * the tx, so a missing card rolls the completed write back (fail-closed).
 *
 * Returns the completed card event id, or null when the run was no longer in
 * the claimed state (already terminalized concurrently) — the caller returns a
 * "decided concurrently" outcome instead of writing anything.
 */
export async function terminalizeApprovalRunCompleted(
	runId: number,
	organizationId: string,
	output: Record<string, unknown>,
	card: { title: string; content: string },
	reviewer: ApprovalReviewer | null,
	db: DbClient = getDb(),
): Promise<number | null> {
	return db.begin(async (tx) => {
		const rows = await tx`
			UPDATE runs
			SET status = 'completed', completed_at = NOW(),
				action_output = ${tx.json(output)}
			WHERE id = ${runId}
				AND organization_id = ${organizationId}
				AND status = 'running'
				AND approval_status = 'approved'
			RETURNING id
		`;
		if (rows.length === 0) return null;
		const cardId = await supersedeActionEvent(
			runId,
			organizationId,
			"completed",
			card.title,
			card.content,
			{ output },
			reviewer,
			tx,
		);
		requireApprovalCard(runId, cardId, "completed");
		return cardId;
	});
}

/**
 * Append the next durable state of an approval card, optionally on the
 * caller's transaction handle. Returns undefined when the run has no current
 * approval card so managed transitions can fail closed before committing the
 * matching `runs` write.
 */
export async function supersedeActionEvent(
	runId: number,
	organizationId: string,
	status: string,
	title: string,
	content: string,
	extraMetadata: Record<string, unknown> = {},
	reviewer: ApprovalReviewer | null = null,
	db: DbClient = getDb(),
	interactionInput?: Record<string, unknown> | null,
): Promise<number | undefined> {
	const sql = db;
	const originalEvent = await sql`
    SELECT id, entity_ids, connection_id, connector_key, metadata, author_name,
      behavior_id, behavior_version_id, interaction_input_schema, interaction_input
    FROM current_event_records
    WHERE run_id = ${runId}
      AND organization_id = ${organizationId}
      AND semantic_type = 'operation'
      AND interaction_type = 'approval'
    LIMIT 1
  `;
	if (originalEvent.length === 0) return undefined;

	const orig = originalEvent[0] as any;
	// Carry the reviewer forward. A decision supplies one; later system
	// transitions inherit the reviewer stamped on the prior state.
	const priorMetadata = (orig.metadata ?? {}) as Record<string, unknown>;
	const reviewedById =
		reviewer?.userId ??
		(priorMetadata.reviewed_by_id as string | undefined) ??
		null;
	const reviewedByName =
		reviewer?.name ??
		(priorMetadata.reviewed_by_name as string | undefined) ??
		null;

	const nextEvent = await insertEvent(
		{
			entityIds: Array.isArray(orig.entity_ids)
				? orig.entity_ids.map(Number)
				: [],
			organizationId,
			originId: `run_${runId}_${status}_${Date.now()}`,
			title,
			content,
			semanticType: "operation",
			connectorKey: orig.connector_key,
			connectionId: orig.connection_id,
			runId,
			behaviorId:
				orig.behavior_id == null ? null : Number(orig.behavior_id),
			behaviorVersionId:
				orig.behavior_version_id == null
					? null
					: Number(orig.behavior_version_id),
			interactionType: "approval",
			interactionStatus:
				status === "confirmed"
					? "approved"
					: status === "rejected"
						? "rejected"
						: status === "completed"
							? "completed"
							: status === "failed"
								? "failed"
								: "pending",
			interactionInputSchema:
				(orig.interaction_input_schema as Record<string, unknown> | null) ??
				null,
			interactionInput:
				interactionInput === undefined
					? ((orig.interaction_input as Record<string, unknown> | null) ?? null)
					: interactionInput,
			interactionOutput:
				((extraMetadata.output ?? extraMetadata.action_output) as
					| Record<string, unknown>
					| undefined) ?? null,
			interactionError:
				(extraMetadata.error_message as string | undefined) ?? null,
			supersedesEventId: Number(orig.id),
			createdBy: reviewedById,
			metadata: {
				...priorMetadata,
				status,
				...(reviewedById ? { reviewed_by_id: reviewedById } : {}),
				...(reviewedByName ? { reviewed_by_name: reviewedByName } : {}),
				...(extraMetadata.output
					? { action_output: extraMetadata.output }
					: {}),
				...(extraMetadata.error_message
					? { error_message: extraMetadata.error_message }
					: {}),
				...extraMetadata,
				...(priorMetadata.resourceKind === "watcher" ||
				extraMetadata.resourceKind === "watcher"
					? { resourceKind: "behavior" }
					: {}),
			},
			authorName: orig.author_name ?? null,
		},
		{ sql },
	);

	return Number(nextEvent.id);
}
