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

type ReconciliationResult =
	| { status: "completed"; output: Record<string, unknown>; eventId?: number }
	| { status: "in_progress" }
	| {
			status: "terminal";
			runStatus: string;
			output: Record<string, unknown> | null;
	  };

type ReconciliationContext = {
	db: DbClient;
	runId: number;
	organizationId: string;
	artifactStore?: Pick<ArtifactStore, "publish" | "delete">;
};

type MaterializedOutput = Awaited<
	ReturnType<typeof materializeActionOutputAttachments>
>;

type TerminalWriteResult =
	| { applied: false }
	| { applied: true; eventId?: number };

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

function resultForRun(run: AppliedRunRow | null): ReconciliationResult {
	if (run?.status === "completed") {
		return { status: "completed", output: run.action_output ?? {} };
	}
	if (run?.status === "running") return { status: "in_progress" };
	return {
		status: "terminal",
		runStatus: run?.status ?? "missing",
		output: run?.action_output ?? null,
	};
}

async function deleteCandidate(
	context: ReconciliationContext,
	materialized: MaterializedOutput,
): Promise<void> {
	await deleteMaterializedArtifacts(
		materialized.publishedArtifactIds,
		context.artifactStore,
	);
}

function ownsCandidate(
	run: AppliedRunRow | null,
	materialized: MaterializedOutput,
): boolean {
	return referencesEveryArtifact(
		run?.action_output ?? null,
		materialized.publishedArtifactIds,
	);
}

/**
 * Elect exactly one publisher by replacing the raw apply marker. A loser
 * deletes only the artifacts it published; an ambiguous DB error keeps any
 * candidate that the committed row may already own.
 */
async function checkpointMaterializedOutput(
	context: ReconciliationContext,
	rawOutput: Record<string, unknown>,
	materialized: MaterializedOutput,
): Promise<{ owner: true } | { owner: false; result: ReconciliationResult }> {
	let checkpointed: AppliedRunRow[];
	try {
		checkpointed = await context.db<AppliedRunRow>`
      UPDATE runs
      SET action_output = ${context.db.json(materialized.output)},
          last_heartbeat_at = current_timestamp
      WHERE id = ${context.runId}
        AND organization_id = ${context.organizationId}
        AND run_type = 'action'
        AND status = 'running'
        AND action_output = ${context.db.json(rawOutput)}
      RETURNING status, approval_status, action_key, action_output
    `;
	} catch (error) {
		let observed: AppliedRunRow | null;
		try {
			observed = await loadAppliedRun(
				context.db,
				context.runId,
				context.organizationId,
			);
		} catch {
			// The write outcome is unknowable. Preserve the candidate because the
			// committed row may reference it once Postgres is reachable again.
			throw error;
		}
		if (
			materialized.publishedArtifactIds.length === 0 ||
			!ownsCandidate(observed, materialized)
		) {
			try {
				await deleteCandidate(context, materialized);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Action output checkpoint failed and candidate artifact cleanup also failed",
				);
			}
		}
		throw error;
	}

	if (checkpointed[0]) return { owner: true };

	const winner = await loadAppliedRun(
		context.db,
		context.runId,
		context.organizationId,
	);
	if (
		materialized.publishedArtifactIds.length > 0 &&
		ownsCandidate(winner, materialized)
	) {
		return { owner: false, result: resultForRun(winner) };
	}
	await deleteCandidate(context, materialized);
	return { owner: false, result: resultForRun(winner) };
}

async function writeTerminalState(
	context: ReconciliationContext,
	run: AppliedRunRow,
	output: Record<string, unknown>,
	card: AppliedActionCard | undefined,
): Promise<TerminalWriteResult> {
	if (run.approval_status === "approved") {
		if (!card) return { applied: false };
		const eventId = await terminalizeApprovalRunCompleted(
			context.runId,
			context.organizationId,
			output,
			{ title: card.title, content: card.content },
			card.reviewer,
			context.db,
		);
		return eventId === null ? { applied: false } : { applied: true, eventId };
	}
	if (run.approval_status !== "auto") return { applied: false };
	const updated = await context.db`
    UPDATE runs
    SET status = 'completed', completed_at = current_timestamp,
        action_output = ${context.db.json(output)}
    WHERE id = ${context.runId}
      AND organization_id = ${context.organizationId}
      AND run_type = 'action'
      AND status = 'running'
      AND approval_status = 'auto'
    RETURNING id
  `;
	return { applied: updated.length > 0 };
}

async function observeTerminalWrite(
	context: ReconciliationContext,
	materialized: MaterializedOutput,
): Promise<ReconciliationResult> {
	const observed = await loadAppliedRun(
		context.db,
		context.runId,
		context.organizationId,
	);
	if (
		observed?.status === "completed" &&
		!ownsCandidate(observed, materialized)
	) {
		await deleteCandidate(context, materialized);
	}
	return resultForRun(observed);
}

/** Terminalize a checkpointed output without ever replaying its external action. */
async function terminalizeCheckpointedOutput(
	context: ReconciliationContext,
	run: AppliedRunRow,
	materialized: MaterializedOutput,
	card: AppliedActionCard | undefined,
): Promise<ReconciliationResult> {
	if (run.approval_status === "approved" && !card) {
		return { status: "in_progress" };
	}
	if (run.approval_status !== "approved" && run.approval_status !== "auto") {
		return { status: "in_progress" };
	}

	try {
		const write = await writeTerminalState(
			context,
			run,
			materialized.output,
			card,
		);
		if (write.applied) {
			return {
				status: "completed",
				output: materialized.output,
				...(write.eventId === undefined ? {} : { eventId: write.eventId }),
			};
		}
	} catch (error) {
		const observed = await loadAppliedRun(
			context.db,
			context.runId,
			context.organizationId,
		).catch(() => null);
		if (
			observed?.status === "completed" &&
			ownsCandidate(observed, materialized)
		) {
			return resultForRun(observed);
		}
		// The running row owns these references. Preserve them so a retry can
		// terminalize without re-running the connector or republishing media.
		throw error;
	}

	return observeTerminalWrite(context, materialized);
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
}): Promise<ReconciliationResult> {
	const context: ReconciliationContext = {
		db: params.db ?? getDb(),
		runId: params.runId,
		organizationId: params.organizationId,
		artifactStore: params.artifactStore,
	};
	const before = await loadAppliedRun(
		context.db,
		context.runId,
		context.organizationId,
	);
	if (!before || before.status !== "running" || !before.action_output) {
		return resultForRun(before);
	}

	const materialized = await materializeActionOutputAttachments(
		params.runId,
		before.action_output,
		context.artifactStore,
	);
	const checkpoint = await checkpointMaterializedOutput(
		context,
		before.action_output,
		materialized,
	);
	if (!checkpoint.owner) return checkpoint.result;
	return terminalizeCheckpointedOutput(
		context,
		before,
		materialized,
		params.card,
	);
}
