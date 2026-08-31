import type { DbClient } from "../db/client";
import { getDb, pgTextArray } from "../db/client";
import { listPendingToolsForRun } from "../gateway/auth/mcp/pending-tool-store";
import { generateDeploymentName } from "../gateway/orchestration/deployment-identity";
import { revokeTurnIfPendingInTransaction } from "../gateway/orchestration/turn-liveness";
import { classifyRunOutcome } from "../runs/run-outcome";
import { supersedeActionEvent } from "../tools/admin/approval-events";
import {
	AUTOMATION_EVAL_RUN_TYPE,
	AUTOMATION_RUN_TYPE,
	AUTOMATION_RUN_TYPES_PG,
} from "../runs/run-types.js";
import logger from "../utils/logger";
import {
	ACTIVE_RUN_STATUSES,
	APPROVAL_RUN_TYPES,
	runStatusLiteral,
} from "../utils/run-statuses";
import { isPermanentAutomationAgentError } from "./failure-classification";
import {
	advanceScheduleAfterTerminalFailure,
	providerQuotaResetNotBefore,
} from "./schedule-cursor";
import {
	recordScheduledConfigurationFailure,
	recordScheduledExecutionFailure,
} from "./scheduled-failure-policy";

type AutomationTerminalResult =
	| { ok: true }
	| {
			ok: false;
			error: string;
			errorCode?: string;
			/** Raw provider text used only to parse a quota reset boundary. */
			quotaResetError?: string;
		};

/**
 * How many times an automation run that finished its agent turn WITHOUT calling
 * `complete_window` is re-dispatched before being marked failed. The agent
 * read its inputs and replied but skipped the finalize tool call — a soft,
 * usually-non-deterministic miss (the model "forgot" the closing step). A
 * bounded re-dispatch gives it a fresh turn to finalize. Default 1 (one extra
 * attempt); 0 disables. Each re-dispatch is a full agent turn, so keep it low.
 *
 * NOTE: this is a re-dispatch (a fresh session via the existing dispatch loop),
 * not a warm in-session nudge — the agent-worker is platform-agnostic and has
 * no notion of automations/complete_window, so a worker-side self-nudge would
 * break that isolation. This constant is the GLOBAL default; an automation can
 * override it via execution_config.finalize_nudges (see
 * resolveFinalizeNudgeBudget). A declarative defineAutomation surface for it is
 * the remaining follow-up (the CLI doesn't expose execution_config yet).
 */
const MAX_FINALIZE_NUDGES: number = (() => {
	const raw = process.env.LOBU_AUTOMATION_FINALIZE_NUDGES;
	if (raw === undefined) return 1;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.min(5, Math.floor(n)) : 1;
})();

/**
 * Finalize-nudge budget for a run: the automation's per-automation override
 * (execution_config.finalize_nudges, 0-5) when set, else the global default.
 * Clamped defensively in case a raw DB value sits outside the schema's range.
 *
 * Shared by the cloud dispatch path and the device `complete-automation` exit
 * report so both honor the same per-Automation / global budget.
 */
export function resolveFinalizeNudgeBudget(
	executionConfig: Record<string, unknown> | null | undefined
): number {
	const override = executionConfig?.finalize_nudges;
	if (typeof override === "number" && Number.isFinite(override)) {
		return Math.min(5, Math.max(0, Math.floor(override)));
	}
	return MAX_FINALIZE_NUDGES;
}

/**
 * Device-held finalize retry: keep the run `running` under the same claim and
 * bump `approved_input.finalize_nudge_count` so the Mac app can re-spawn the
 * local CLI with a nudge. Unlike {@link requeueAutomationRunForFinalizeNudge}
 * (cloud: release claim → pending), this does not clear `claimed_by`.
 *
 * Returns false when the row is no longer `running` under this worker's claim,
 * or when the stored count already moved past the caller's read. The count
 * predicate is a compare-and-swap: two duplicate exit reports (a Mac retry
 * after a timed-out response) both read the same `finalize_nudge_count` and
 * both pass the caller's `attemptsSoFar < budget` check, so without it both
 * would be granted a resume and the run would get one more spawn than the
 * budget allows. Callers derive `nextNudgeCount` as read + 1, so
 * `nextNudgeCount - 1` is the expected prior value. The count is only ever
 * written with `to_jsonb(int)`, so the cast is safe.
 */
export async function bumpDeviceFinalizeNudge(
	sql: DbClient,
	automationId: number,
	runId: number,
	workerId: string,
	nextNudgeCount: number,
	outputTail: string | null
): Promise<"bumped" | "blocked" | "missed"> {
	return sql.begin(async (tx) => {
		await tx`
			SELECT id FROM automations
			WHERE id = ${automationId}
			FOR UPDATE
		`;
		const locked = await tx`
			SELECT id FROM runs
			WHERE id = ${runId}
			  AND status = 'running'
			  AND claimed_by = ${workerId}
			FOR UPDATE
		`;
		if (locked.length === 0) return "missed";
		const approvalFailure = await describePendingApproval(tx, runId, 0);
		if (approvalFailure) {
			await markAutomationRunFailedInTransaction(tx, runId, approvalFailure);
			return "blocked";
		}
		const rows = (await tx`
    UPDATE runs
    SET approved_input = jsonb_set(
          COALESCE(approved_input, '{}'::jsonb),
          '{finalize_nudge_count}',
          to_jsonb(${nextNudgeCount}::int)
        ),
        output_tail = ${outputTail},
        error_message = ${`Device CLI attempt ${nextNudgeCount}: completeWindow not called — resume allowed`}
    WHERE id = ${runId}
      AND status = 'running'
      AND claimed_by = ${workerId}
      AND COALESCE((approved_input->>'finalize_nudge_count')::int, 0)
          = ${nextNudgeCount - 1}
    RETURNING id
  `) as unknown as Array<{ id: number }>;
		return rows.length > 0 ? "bumped" : "missed";
	});
}

/**
 * Mark an Automation run completed, recording who executed it when the caller
 * knows.
 *
 * `complete_window` used to default `runs.model_used` to the literal
 * 'external-client' whenever its caller omitted `model`, and the platform's own
 * Lobu agent omits it — so server-dispatched runs were labelled as though an
 * outside MCP client had executed them. That label reads as an observation and
 * is not one: triaging the July 2026 Automation collapse from this column
 * produced exactly that wrong conclusion.
 *
 * `fallbackModel` is the caller's assertion about the executor and is applied
 * ONLY over the placeholder or a NULL — a model the agent genuinely reported
 * always wins. Callers that cannot prove who executed the run must omit it
 * rather than guess: `reconcileAutomationRuns` sweeps active runs without
 * filtering on `dispatched_message_id`, so it can reach runs an external client
 * created, and stamping those would invert the very bug this fixes.
 *
 * (SQL comments are kept out of the template literal: a backtick inside one
 * terminates the string and fails the esbuild transform, not just at runtime.)
 */
export async function markAutomationRunCompleted(
	sql: DbClient,
	runId: number,
	fallbackModel?: string,
	expectedMessageId?: string,
	claimedBy?: string,
): Promise<void> {
	await sql`
    UPDATE runs
    SET status = 'completed',
        outcome = ${classifyRunOutcome({ status: "completed" })},
        completed_at = current_timestamp,
        error_message = NULL,
        model_used = COALESCE(
          NULLIF(model_used, 'external-client'),
          ${fallbackModel ?? null},
          model_used
        )
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
	  AND (${expectedMessageId ?? null}::text IS NULL OR dispatched_message_id = ${expectedMessageId ?? null})
	  AND (${claimedBy ?? null}::text IS NULL OR claimed_by = ${claimedBy ?? null})
  `;
}

/**
 * Event turns and evals complete from the message result rather than through
 * complete_window. Lock the parent before inspecting descendants so an
 * approval INSERT's FOR SHARE gate either commits first and is observed, or
 * waits until this terminal transition commits and then fails its active check.
 */
async function terminalizeSuccessfulTurn(
	sql: DbClient,
	runId: number,
	budget: number,
	expectedMessageId?: string,
	claimedBy?: string,
): Promise<boolean> {
	return sql.begin(async (tx) => {
		await lockOwningAutomationForRun(tx, runId);
		const locked = await tx`
			SELECT id FROM runs
			WHERE id = ${runId}
			  AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
			  AND (${expectedMessageId ?? null}::text IS NULL OR dispatched_message_id = ${expectedMessageId ?? null})
			  AND (${claimedBy ?? null}::text IS NULL OR claimed_by = ${claimedBy ?? null})
			FOR UPDATE
		`;
		if (locked.length === 0) return false;
		const approvalFailure = await describePendingApproval(tx, runId, budget);
		if (approvalFailure) {
			return markAutomationRunFailedInTransaction(
				tx,
				runId,
				approvalFailure,
			);
		}
		await markAutomationRunCompleted(tx, runId, "lobu-agent", expectedMessageId, claimedBy);
		return true;
	});
}

async function markAutomationRunFailed(
	sql: DbClient,
	runId: number,
	message: string,
	notBefore?: Date | null,
	errorCode?: string | null,
	expectedMessageId?: string,
	claimedBy?: string,
): Promise<boolean> {
	return sql.begin(async (tx) => {
		return markAutomationRunFailedInTransaction(
			tx,
			runId,
			message,
			notBefore,
			errorCode,
			expectedMessageId,
			claimedBy,
		);
	});
}

export async function markAutomationRunFailedInTransaction(
	tx: DbClient,
	runId: number,
	message: string,
	notBefore?: Date | null,
	errorCode?: string | null,
	expectedMessageId?: string,
	claimedBy?: string,
	permanentConfigurationFailure = false,
): Promise<boolean> {
	// completeWindow owns the Automation before its run. Failure, retry, and
	// queue-dead-letter paths must take the same order or a valid completion can
	// deadlock against terminalization and lose its transaction.
	await lockOwningAutomationForRun(tx, runId);
	const [failed] = await tx<{
		automation_id: string | number | null;
		organization_id: string | null;
		run_type: string;
		dispatch_source: string | null;
	}>`
      UPDATE runs
      SET status = 'failed',
          outcome = ${classifyRunOutcome({ status: "failed", errorCode, errorMessage: message })},
          completed_at = current_timestamp,
          error_message = ${message}
      WHERE id = ${runId}
        AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        AND (
          ${expectedMessageId ?? null}::text IS NULL
          OR dispatched_message_id = ${expectedMessageId ?? null}
        )
		AND (${claimedBy ?? null}::text IS NULL OR claimed_by = ${claimedBy ?? null})
	  RETURNING automation_id, organization_id, run_type,
	            approved_input->>'dispatch_source' AS dispatch_source
	`;
	if (!failed) return false;
	if (failed.organization_id) {
		await cleanupAutomationParentLineageInTransaction(
			tx,
			runId,
			failed.organization_id,
			failed.automation_id == null ? null : Number(failed.automation_id),
		);
	}
	// Only a REAL Automation failure moves the schedule. An eval replay copies
	// the source run's dispatch_source verbatim, so without this gate a
	// failing eval (a quota 429, a scoring rerun) would advance — or park for
	// a day — the live Automation's cron cursor it is merely replaying.
	if (failed.run_type === AUTOMATION_RUN_TYPE) {
		const automationId =
			failed.automation_id == null ? null : Number(failed.automation_id);
		if (
			permanentConfigurationFailure ||
			isPermanentAutomationAgentError(errorCode, message)
		) {
			await recordScheduledConfigurationFailure(
				tx,
				automationId,
				failed.dispatch_source,
			);
		} else {
			await recordScheduledExecutionFailure(
				tx,
				automationId,
				failed.dispatch_source,
			);
		}
		await advanceScheduleAfterTerminalFailure(
			tx,
			automationId,
			failed.dispatch_source,
			notBefore,
		);
	}
	return true;
}

export async function lockOwningAutomationForRun(
	tx: DbClient,
	runId: number,
): Promise<void> {
	await tx`
		SELECT a.id
		FROM automations a
		JOIN runs r
		  ON r.automation_id = a.id
		 AND r.organization_id = a.organization_id
		WHERE r.id = ${runId}
		FOR UPDATE OF a
	`;
}

/** Revoke every exact continuation owned by a terminal Automation parent. */
export async function cleanupAutomationParentLineageInTransaction(
	tx: DbClient,
	runId: number,
	organizationId: string,
	automationId: number | null,
): Promise<void> {
	if (automationId != null) {
		await tx`
			DELETE FROM oauth_states
			WHERE scope = 'pending-tool'
			  AND payload->>'organizationId' = ${organizationId}
			  AND right(
			    payload->>'conversationId',
			    length(
			      '_automation_' || ${automationId}::text ||
			      '_run_' || ${runId}::text
			    )
			  ) = '_automation_' || ${automationId}::text ||
			      '_run_' || ${runId}::text
		`;
	}
	const linkedChildren = await tx<{
		id: number | string;
		queue_name: string;
		message_id: string | null;
		agent_id: string | null;
		user_id: string | null;
		conversation_id: string | null;
		channel_id: string | null;
		platform: string | null;
	}>`
		SELECT id, queue_name,
		       action_input->>'messageId' AS message_id,
		       action_input->>'agentId' AS agent_id,
		       action_input->>'userId' AS user_id,
		       action_input->>'conversationId' AS conversation_id,
		       action_input->>'channelId' AS channel_id,
		       action_input->>'platform' AS platform
		FROM public.runs
		WHERE parent_run_id = ${runId}
		  AND run_type = 'chat_message'
	`;
	const cancelledApprovals = await tx<{
		id: number | string;
		action_key: string | null;
	}>`
		UPDATE public.runs
		SET status = 'cancelled',
		    approval_status = 'rejected',
		    completed_at = now(),
		    error_message = ${`Cancelled because Automation parent ${runId} terminalized.`}
		WHERE parent_run_id = ${runId}
		  AND organization_id = ${organizationId}
		  AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
		  AND approval_status = 'pending'
		  AND status = 'pending'
		RETURNING id, action_key
	`;
	for (const approval of cancelledApprovals) {
		await supersedeActionEvent(
			Number(approval.id),
			organizationId,
			"rejected",
			`${approval.action_key ?? "approval"} — cancelled`,
			"The owning headless Automation run terminalized before this approval was decided.",
			{ reason: "automation_parent_terminalized", parent_run_id: runId },
			null,
			tx,
		);
	}
	for (const child of linkedChildren) {
			const deploymentName = child.queue_name.startsWith("thread_message_")
				? child.queue_name.slice("thread_message_".length)
				: child.agent_id && child.conversation_id
					? generateDeploymentName({
							organizationId,
							agentId: child.agent_id,
							userId: child.user_id ?? undefined,
							platform: child.platform ?? undefined,
							channelId: child.channel_id ?? undefined,
							conversationId: child.conversation_id,
						})
					: "";
			if (deploymentName && child.message_id) {
				await revokeTurnIfPendingInTransaction(tx, {
					deploymentName,
					messageId: child.message_id,
					organizationId,
				});
			}
	}
	await tx`
		UPDATE public.runs
		SET status = 'cancelled',
		    completed_at = now(),
		    error_message = ${`Cancelled because Automation parent ${runId} terminalized.`}
		WHERE parent_run_id = ${runId}
		  AND run_type = 'chat_message'
		  AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
	`;
}

/**
 * Terminalize an Automation parent when one of its durable queue children
 * exhausts retries (or fails with a non-retryable OrchestratorError). The
 * caller supplies its current transaction so child and parent cannot diverge
 * across a process crash.
 */
export async function failAutomationParentRunFromQueue(
	tx: DbClient,
	parentRunId: number,
	childRunId: number,
	message: string,
): Promise<boolean> {
	const [child] = await tx<{
		message_id: string | null;
	}>`
		SELECT action_input->>'messageId' AS message_id
		FROM public.runs
		WHERE id = ${childRunId}
		  AND parent_run_id = ${parentRunId}
		LIMIT 1
	`;
	const messageId = child?.message_id?.trim();
	if (!child || !messageId) return false;

	const failed = await markAutomationRunFailedInTransaction(
		tx,
		parentRunId,
		`Automation worker queue run ${childRunId} failed: ${message}`,
		undefined,
		undefined,
		messageId,
	);
	if (!failed) return false;
	await tx`
		UPDATE public.runs
		SET status = 'cancelled',
		    completed_at = now(),
		    error_message = ${`Cancelled because Automation parent ${parentRunId} terminalized.`}
		WHERE parent_run_id = ${parentRunId}
		  AND id <> ${childRunId}
		  AND run_type = 'chat_message'
		  AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
	`;
	return true;
}

/**
 * Reset an automation run that missed `complete_window` back to `pending` so the
 * automation dispatch loop (`dispatchPendingAutomationRuns` → `claimAutomationRun`)
 * re-dispatches it for one more agent turn. Mirrors `resetOrphanedAutomationRuns`
 * (the proven re-dispatch shape) and records the attempt in
 * `approved_input.finalize_nudge_count` so it is strictly bounded. Status-
 * guarded so it can't resurrect an already-terminal run (replica-safe).
 */
async function requeueAutomationRunForFinalizeNudge(
	sql: DbClient,
	runId: number,
	nextNudgeCount: number,
	expectedMessageId?: string,
	claimedBy?: string,
): Promise<boolean> {
	return sql.begin(async (tx) => {
		await lockOwningAutomationForRun(tx, runId);
	const rows = await tx`
    UPDATE runs
    SET status = 'pending',
        claimed_by = NULL,
        claimed_at = NULL,
        dispatched_message_id = NULL,
        error_message = NULL,
        approved_input = jsonb_set(
		  COALESCE(approved_input, '{}'::jsonb) - 'dispatch_message_id',
          '{finalize_nudge_count}',
          to_jsonb(${nextNudgeCount}::int)
        )
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
	  AND (${expectedMessageId ?? null}::text IS NULL OR dispatched_message_id = ${expectedMessageId ?? null})
	  AND (${claimedBy ?? null}::text IS NULL OR claimed_by = ${claimedBy ?? null})
	  AND COALESCE((approved_input->>'finalize_nudge_count')::int, 0) = ${nextNudgeCount - 1}
	RETURNING id
	  `;
	return rows.length > 0;
	});
}

export async function resolveAutomationRunsByMessageIds(
	messageIds: Iterable<string>,
	result: AutomationTerminalResult,
	db?: DbClient
): Promise<{ resolved: number }> {
	const ids = Array.from(new Set(Array.from(messageIds).filter(Boolean)));
	if (ids.length === 0) return { resolved: 0 };

	const sql = db ?? getDb();
	const rows = await sql`
		SELECT r.id, r.run_type, r.approved_input, r.dispatched_message_id,
		       r.claimed_by, w.execution_config
    FROM runs r
    LEFT JOIN automations w ON w.id = r.automation_id
    WHERE r.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
      AND r.dispatched_message_id = ANY(${pgTextArray(ids)}::text[])
      AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

	let resolved = 0;
	for (const row of rows) {
		const typedRow = row as {
			id: unknown;
			run_type: string;
			approved_input: Record<string, unknown> | null;
			execution_config: Record<string, unknown> | null;
			dispatched_message_id: string | null;
			claimed_by: string | null;
		};
		const runId = Number(typedRow.id);
		if (!Number.isFinite(runId)) continue;

		if (!result.ok) {
			const notBefore = providerQuotaResetNotBefore(
				result.quotaResetError ?? result.error,
				result.errorCode
			);
			if (
				await markAutomationRunFailed(
					sql,
					runId,
					result.error,
					notBefore,
					result.errorCode,
					typedRow.dispatched_message_id ?? undefined,
					typedRow.claimed_by ?? undefined
				)
			) {
				resolved++;
			}
			continue;
		}

		const budget = resolveFinalizeNudgeBudget(typedRow.execution_config);
		if (typedRow.approved_input?.trigger_execution === "turn") {
			if (await terminalizeSuccessfulTurn(sql, runId, budget, typedRow.dispatched_message_id ?? undefined, typedRow.claimed_by ?? undefined)) resolved++;
			continue;
		}

		// Capture-mode evals persist their preview instead of a live result.
		if (typedRow.run_type === AUTOMATION_EVAL_RUN_TYPE) {
			if (await terminalizeSuccessfulTurn(sql, runId, budget, typedRow.dispatched_message_id ?? undefined, typedRow.claimed_by ?? undefined)) resolved++;
			continue;
		}

		const approvalFailure = await describePendingApproval(sql, runId, budget);
		if (approvalFailure) {
			if (await markAutomationRunFailed(sql, runId, approvalFailure, undefined, undefined, typedRow.dispatched_message_id ?? undefined, typedRow.claimed_by ?? undefined)) {
				resolved++;
			}
			continue;
		}

		// Any live run still active when its reply finishes did not call
		// complete_window: that call completes the run atomically with its result.
		const nudgeCount = Number(
			typedRow.approved_input?.finalize_nudge_count ?? 0
		);
		if (Number.isFinite(nudgeCount) && nudgeCount < budget) {
			const nudged = await requeueAutomationRunForFinalizeNudge(sql, runId, nudgeCount + 1, typedRow.dispatched_message_id ?? undefined, typedRow.claimed_by ?? undefined);
			if (!nudged) continue;
			logger.info(
				{ run_id: runId, attempt: nudgeCount + 1, max: budget },
				"[automations] Agent finished without complete_window — re-dispatching for finalize nudge"
			);
			resolved++;
			continue;
		}
		if (
			await markAutomationRunFailed(
				sql,
				runId,
				await describeFinalizeMiss(sql, runId, budget),
				undefined, undefined, typedRow.dispatched_message_id ?? undefined, typedRow.claimed_by ?? undefined
			)
		) {
			resolved++;
		}
	}

	return { resolved };
}

async function describeFinalizeMiss(
	sql: DbClient,
	runId: number,
	budget: number
): Promise<string> {
	const attempts = budget > 0 ? ` after ${budget + 1} attempt(s)` : "";
	const agentMiss =
		"Agent reply finished without calling run_sdk (client.automations.completeWindow)" +
		attempts;
	const approvalFailure = await describePendingApproval(sql, runId, budget);
	if (approvalFailure) return approvalFailure;
	return (
		agentMiss +
		". No active tool approval was found, so check that the assigned agent has the " +
		"lobu-memory MCP attached and that query_sdk / run_sdk are available to it."
	);
}

export async function describePendingApproval(
	sql: DbClient,
	runId: number,
	budget: number,
): Promise<string | null> {
	const attempts = budget > 0 ? ` after ${budget + 1} attempt(s)` : "";
	const pending = await listPendingToolsForRun(runId, sql);
	const childApprovals = await sql<{
		action_key: string | null;
		run_type: string;
	}>`
		SELECT action_key, run_type
		FROM runs
		WHERE parent_run_id = ${runId}
		  AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
		  AND NOT (
		    run_type = 'internal'
		    AND action_key = ANY('{entity_field_change,entity_change}'::text[])
		    AND COALESCE(run_metadata->>'automation_review_artifact', 'false') = 'true'
		  )
		  AND approval_status = 'pending'
		  AND status = 'pending'
		ORDER BY id ASC
	`;

	if (pending.length > 0 || childApprovals.length > 0) {
		const tools = [
			...pending.map((p) => `${p.mcpId}/${p.toolName}`),
			...childApprovals.map(
				(child) => child.action_key ?? `${child.run_type} approval`,
			),
		].join(", ");
		return (
			`Automation run blocked on tool approval${attempts}: ${tools} queued for ` +
			"human approval. Headless Automation runs " +
			"cannot answer approval cards; configure standing tool access or an " +
			"unattended-safe operation policy, then retry the Automation."
		);
	}
	return null;
}
