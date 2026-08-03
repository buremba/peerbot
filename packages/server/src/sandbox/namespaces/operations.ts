/**
 * ClientSDK `operations` namespace. Thin wrapper over `manageOperations`.
 *
 * `execute` is the only method flagged `access: 'external'` — dry-run mode
 * (PR-2) intercepts these calls instead of sending them.
 */

import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

export interface OperationsExecuteInput {
	connection_id: number;
	operation_key: string;
	input?: Record<string, unknown>;
	idempotency_key?: string;
	/**
	 * Watcher provenance when this operation fires from a reaction. Both ids are
	 * numeric.
	 */
	behavior_source?: { behavior_id: number; window_id: number };
}

export interface OperationsNamespace {
	manage(input: Record<string, unknown>): Promise<unknown>;
	listAvailable(input?: {
		connector_key?: string;
		connection_id?: number;
		entity_id?: number;
		kind?: "read" | "write";
		backend?: "local_action" | "mcp_tool" | "http_operation";
		query?: string;
		include_disconnected?: boolean;
		include_input_schema?: boolean;
		include_output_schema?: boolean;
		limit?: number;
		offset?: number;
	}): Promise<unknown>;
	execute(input: OperationsExecuteInput): Promise<unknown>;
	listRuns(input?: {
		connection_id?: number;
		connection_ids?: number[];
		feed_ids?: number[];
		device_worker_id?: string;
		connector_key?: string;
		operation_key?: string;
		status?: string;
		approval_status?: string;
		/**
		 * Omit to list every OPERATIONAL run type (sync, action, behavior, auth,
		 * …). Chat-message transport runs (streaming deltas) are excluded by
		 * default; pass run_types: ['chat_message'] for the trace view.
		 */
		run_types?: string[];
		behavior_ids?: number[];
		/** ISO 8601 inclusive lower bound on created_at. */
		created_after?: string;
		/** ISO 8601 exclusive upper bound on created_at. */
		created_before?: string;
		before_id?: number;
		before_created_at?: string;
		limit?: number;
		offset?: number;
	}): Promise<unknown>;
	getRun(run_id: number): Promise<unknown>;
	approve(input: {
		run_id: number;
		input?: Record<string, unknown>;
	}): Promise<unknown>;
	reject(input: { run_id: number; reason?: string }): Promise<unknown>;
}

export function buildOperationsNamespace(
	ctx: ToolContext,
	env: Env,
): OperationsNamespace {
	const { manage, action } = createActionCaller(
		manageOperations,
		env,
		ctx,
		"operations",
	);

	return {
		manage,
		listAvailable: (input) => action("list_available", input, "listAvailable"),
		execute: (input) => action("execute", input, "execute"),
		listRuns: (input) => action("list_runs", input, "listRuns"),
		getRun: (run_id) =>
			action(
				"get_run",
				{ run_id: idArg("operations.getRun", "run_id", run_id, "number") },
				"getRun",
			),
		approve: (input) => action("approve", input, "approve"),
		reject: (input) => action("reject", input, "reject"),
	};
}
