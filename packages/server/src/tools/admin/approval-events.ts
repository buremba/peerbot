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
    SELECT id, entity_ids, connection_id, connector_key, metadata, author_name, interaction_input_schema, interaction_input
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
