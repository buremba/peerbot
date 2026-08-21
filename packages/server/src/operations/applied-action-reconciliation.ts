import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import type { ArtifactStore } from "../gateway/files/artifact-store";
import {
	type ApprovalReviewer,
	terminalizeApprovalRunCompleted,
} from "../tools/admin/approval-events";
import {
	deleteMaterializedArtifacts,
	materializeActionOutputAttachments,
	prepareActionOutputForDurableApply,
} from "../utils/inline-attachments";

type AppliedRunRow = {
	status: string;
	approval_status: string;
	action_key: string | null;
	action_output: Record<string, unknown> | null;
};

type AppliedActionCard = {
	title: string;
	content: string;
	reviewer: ApprovalReviewer | null;
};

async function loadAppliedRun(
	db: DbClient,
	runId: number,
	organizationId: string,
): Promise<AppliedRunRow | null> {
	const rows = await db<AppliedRunRow>`
    SELECT status, approval_status, action_key, action_output
    FROM runs
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND run_type = 'action'
    LIMIT 1
  `;
	return rows[0] ?? null;
}

function collectArtifactIds(
	value: unknown,
	found = new Set<string>(),
): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectArtifactIds(item, found);
	} else if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (key === "artifact_id" && typeof item === "string") found.add(item);
			else collectArtifactIds(item, found);
		}
	}
	return found;
}

function referencesEveryArtifact(
	output: Record<string, unknown> | null,
	artifactIds: string[],
): boolean {
	if (artifactIds.length === 0) return true;
	const referenced = collectArtifactIds(output);
	return artifactIds.every((artifactId) => referenced.has(artifactId));
}

/** Persist the bounded raw result before any post-apply filesystem work. */
export async function persistAppliedActionOutput(params: {
	runId: number;
	organizationId: string;
	output: Record<string, unknown>;
	expectedWorkerId?: string;
	db?: DbClient;
}): Promise<AppliedRunRow | null> {
	const db = params.db ?? getDb();
	const output = prepareActionOutputForDurableApply(params.output);
	const workerGuard = params.expectedWorkerId
		? db`AND claimed_by = ${params.expectedWorkerId}`
		: db``;
	const updated = await db<AppliedRunRow>`
    UPDATE runs
    SET action_output = ${db.json(output)}, last_heartbeat_at = current_timestamp
    WHERE id = ${params.runId}
      AND organization_id = ${params.organizationId}
      AND run_type = 'action'
      AND status = 'running'
      AND approval_status IN ('auto', 'approved')
      AND action_output IS NULL
      ${workerGuard}
    RETURNING status, approval_status, action_key, action_output
  `;
	if (updated[0]) return updated[0];
	return loadAppliedRun(db, params.runId, params.organizationId);
}

/**
 * Finish an already-applied action from its durable output. This function never
 * invokes connector, MCP, or HTTP execution. Concurrent reconcilers may publish
 * duplicate candidates, but only one guarded terminal update wins and every
 * losing candidate is quarantined/deleted.
 */
export async function reconcileAppliedActionRun(params: {
	runId: number;
	organizationId: string;
	card?: AppliedActionCard;
	db?: DbClient;
	artifactStore?: Pick<ArtifactStore, "publish" | "delete">;
}): Promise<
	| { status: "completed"; output: Record<string, unknown>; eventId?: number }
	| { status: "in_progress" }
	| {
			status: "terminal";
			runStatus: string;
			output: Record<string, unknown> | null;
	  }
> {
	const db = params.db ?? getDb();
	const before = await loadAppliedRun(db, params.runId, params.organizationId);
	if (!before)
		return { status: "terminal", runStatus: "missing", output: null };
	if (before.status === "completed") {
		return { status: "completed", output: before.action_output ?? {} };
	}
	if (before.status !== "running" || !before.action_output) {
		return before.status === "running"
			? { status: "in_progress" }
			: {
					status: "terminal",
					runStatus: before.status,
					output: before.action_output,
				};
	}

	const materialized = await materializeActionOutputAttachments(
		params.runId,
		before.action_output,
		params.artifactStore,
	);
	const cleanupCandidate = async () => {
		await deleteMaterializedArtifacts(
			materialized.publishedArtifactIds,
			params.artifactStore,
		);
	};

	// Checkpoint the exact materialized references while the run is still
	// running. That makes the filesystem publication durably owned before the
	// terminal update: a DB error after this point must leave the artifacts in
	// place so a retry can terminalize without republishing or rerunning the
	// connector. The old-output guard elects one concurrent materializer; every
	// loser removes only its own candidates.
	let checkpointed: AppliedRunRow[];
	try {
		checkpointed = await db<AppliedRunRow>`
      UPDATE runs
      SET action_output = ${db.json(materialized.output)},
          last_heartbeat_at = current_timestamp
      WHERE id = ${params.runId}
        AND organization_id = ${params.organizationId}
        AND run_type = 'action'
        AND status = 'running'
        AND action_output = ${db.json(before.action_output)}
      RETURNING status, approval_status, action_key, action_output
    `;
	} catch (error) {
		let owner: AppliedRunRow | null;
		try {
			owner = await loadAppliedRun(db, params.runId, params.organizationId);
		} catch {
			// The checkpoint outcome is unknowable. Deleting here could remove an
			// artifact already referenced by the committed row, so fail closed and
			// preserve it for reconciliation once Postgres is reachable again.
			throw error;
		}
		if (
			materialized.publishedArtifactIds.length === 0 ||
			!referencesEveryArtifact(
				owner?.action_output ?? null,
				materialized.publishedArtifactIds,
			)
		) {
			try {
				await cleanupCandidate();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Action output checkpoint failed and candidate artifact cleanup also failed",
				);
			}
		}
		throw error;
	}
	if (!checkpointed[0]) {
		const winner = await loadAppliedRun(
			db,
			params.runId,
			params.organizationId,
		);
		if (
			materialized.publishedArtifactIds.length > 0 &&
			referencesEveryArtifact(
				winner?.action_output ?? null,
				materialized.publishedArtifactIds,
			)
		) {
			if (winner?.status === "completed") {
				return { status: "completed", output: winner.action_output ?? {} };
			}
			return { status: "in_progress" };
		}
		await cleanupCandidate();
		if (winner?.status === "completed") {
			return { status: "completed", output: winner.action_output ?? {} };
		}
		return winner?.status === "running"
			? { status: "in_progress" }
			: {
					status: "terminal",
					runStatus: winner?.status ?? "missing",
					output: winner?.action_output ?? null,
				};
	}

	try {
		if (before.approval_status === "approved") {
			if (!params.card) {
				return { status: "in_progress" };
			}
			const eventId = await terminalizeApprovalRunCompleted(
				params.runId,
				params.organizationId,
				materialized.output,
				{ title: params.card.title, content: params.card.content },
				params.card.reviewer,
				db,
			);
			if (eventId !== null) {
				return { status: "completed", output: materialized.output, eventId };
			}
		} else if (before.approval_status === "auto") {
			const updated = await db`
        UPDATE runs
        SET status = 'completed', completed_at = current_timestamp,
            action_output = ${db.json(materialized.output)}
        WHERE id = ${params.runId}
          AND organization_id = ${params.organizationId}
          AND run_type = 'action'
          AND status = 'running'
          AND approval_status = 'auto'
        RETURNING id
      `;
			if (updated.length > 0) {
				return { status: "completed", output: materialized.output };
			}
		} else {
			return { status: "in_progress" };
		}
	} catch (error) {
		const afterError = await loadAppliedRun(
			db,
			params.runId,
			params.organizationId,
		).catch(() => null);
		if (
			afterError?.status === "completed" &&
			referencesEveryArtifact(
				afterError.action_output,
				materialized.publishedArtifactIds,
			)
		) {
			return { status: "completed", output: afterError.action_output ?? {} };
		}
		// The running row already owns these exact artifact references. Preserve
		// them on an ambiguous/failed terminal write; the next reconciliation can
		// finish from action_output without another external apply or publication.
		throw error;
	}

	const after = await loadAppliedRun(db, params.runId, params.organizationId);
	if (
		after?.status === "completed" &&
		referencesEveryArtifact(
			after.action_output,
			materialized.publishedArtifactIds,
		)
	) {
		return { status: "completed", output: after.action_output ?? {} };
	}
	if (after?.status === "completed") {
		await cleanupCandidate();
		return { status: "completed", output: after.action_output ?? {} };
	}
	return after?.status === "running"
		? { status: "in_progress" }
		: {
				status: "terminal",
				runStatus: after?.status ?? "missing",
				output: after?.action_output ?? null,
			};
}
