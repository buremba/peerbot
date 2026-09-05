/**
 * ClientSDK `operations` namespace. Thin wrapper over `manageOperations`.
 *
 * `execute` is the only method flagged `access: 'external'` — dry-run mode
 * (PR-2) intercepts these calls instead of sending them.
 */

import type { ActionInput } from "@lobu/core/contracts/tools/action-input";
import type { ManageOperationsArgs } from "@lobu/core/contracts/tools/manage-operations";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

export type OperationsListAvailableInput = ActionInput<
	ManageOperationsArgs,
	"list_available"
>;
export type OperationsExecuteInput = ActionInput<
	ManageOperationsArgs,
	"execute"
>;
export type OperationsListRunsInput = ActionInput<
	ManageOperationsArgs,
	"list_runs"
>;
export type OperationsApproveInput = ActionInput<
	ManageOperationsArgs,
	"approve"
>;
export type OperationsRejectInput = ActionInput<ManageOperationsArgs, "reject">;

export interface OperationsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	listAvailable(input?: OperationsListAvailableInput): Promise<unknown>;
	execute(input: OperationsExecuteInput): Promise<unknown>;
	listRuns(input?: OperationsListRunsInput): Promise<unknown>;
	getRun(run_id: number): Promise<unknown>;
	approve(input: OperationsApproveInput): Promise<unknown>;
	reject(input: OperationsRejectInput): Promise<unknown>;
}

export function buildOperationsNamespace(
	ctx: ToolContext,
	env: Env,
): OperationsNamespace {
	const { manage, method } = createActionCaller(
		manageOperations,
		env,
		ctx,
		"operations",
	);

	return {
		manage,
		listAvailable: method("list_available", { publicMethod: "listAvailable" }),
		execute: method("execute"),
		listRuns: method("list_runs", { publicMethod: "listRuns" }),
		getRun: method("get_run", {
			publicMethod: "getRun",
			mapArgs: (run_id) => ({
				run_id: idArg("operations.getRun", "run_id", run_id, "number"),
			}),
		}),
		approve: method("approve"),
		reject: method("reject"),
	};
}
