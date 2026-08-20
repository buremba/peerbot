/**
 * Tool: manage_operations
 *
 * Unified execution and discovery surface for connector-backed operations.
 * Operations can be backed by local connector actions, upstream MCP tools,
 * or OpenAPI-derived HTTP operations.
 */

import { action, defineActionTool } from "./action-tool";
import {
	handleApprove,
	handleApproveBatch,
	handleReject,
	handleRejectBatch,
} from "./manage_operations/handlers/approvals";
import { handleExecute } from "./manage_operations/handlers/execute";
import { handleListAvailable } from "./manage_operations/handlers/list-available";
import {
	handleGetRun,
	handleListActivity,
	handleListRuns,
} from "./manage_operations/handlers/runs";
import {
	ApproveAction,
	ApproveBatchAction,
	ExecuteAction,
	GetRunAction,
	ListActivityAction,
	ListAvailableAction,
	ListRunsAction,
	RejectAction,
	RejectBatchAction,
} from "./manage_operations/schemas";
import { queueApprovalNotificationCardRefresh } from "../../notifications/service";

const manageOperationsTool = defineActionTool("manage_operations", {
	list_available: action(ListAvailableAction, handleListAvailable),
	execute: action(ExecuteAction, handleExecute),
	list_runs: action(ListRunsAction, handleListRuns),
	get_run: action(GetRunAction, handleGetRun),
	list_activity: action(ListActivityAction, handleListActivity),
	approve: action(ApproveAction, handleApprove),
	reject: action(RejectAction, handleReject),
	approve_batch: action(ApproveBatchAction, handleApproveBatch),
	reject_batch: action(RejectBatchAction, handleRejectBatch),
});

const runManageOperations = manageOperationsTool.run;

/**
 * Approval-card settlement belongs after the shared state transition, not in
 * any one UI handler. This keeps Slack, web, MCP Apps, single decisions, and
 * batches convergent: whichever surface wins the durable run claim updates all
 * persisted chat copies from the same final state.
 */
export const manageOperations: typeof runManageOperations = async (
	args,
	env,
	ctx,
) => {
	const result = await runManageOperations(args, env, ctx);
	if (
		args.action === "approve" ||
		args.action === "reject" ||
		args.action === "approve_batch" ||
		args.action === "reject_batch"
	) {
		const record = result as Record<string, unknown>;
		const resultIds = Array.isArray(record.run_ids)
			? record.run_ids.map(Number)
			: Number.isFinite(Number(record.run_id))
				? [Number(record.run_id)]
				: [];
		queueApprovalNotificationCardRefresh(ctx.organizationId, resultIds);
	}
	return result;
};
export {
	ManageOperationsResultSchema,
	ManageOperationsSchema,
} from "./manage_operations/schemas";
export {
	type ApprovalReviewer,
	requireApprovalCard,
	supersedeActionEvent,
} from "./approval-events";
export { waitForDeviceActionRun } from "./device-action-wait";
export {
	formatActivityAttentionBlock,
	listOrgActivity,
} from "./manage_operations/activity-feed";
export {
	buildActionConfig,
} from "./manage_operations/handlers/execute";
export { qualifiedOperationKey } from "./manage_operations/handlers/shared";
