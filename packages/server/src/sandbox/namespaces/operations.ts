/**
 * ClientSDK `operations` namespace. Thin wrapper over `manageOperations`.
 *
 * `execute` is the only method flagged `access: 'external'` — dry-run mode
 * (PR-2) intercepts these calls instead of sending them.
 */

import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface OperationsExecuteInput {
  connection_id: number;
  operation_key: string;
  input?: Record<string, unknown>;
  /**
   * Watcher provenance when this operation fires from a reaction. Both ids are
   * numeric.
   */
  watcher_source?: { watcher_id: number; window_id: number };
}

export interface OperationsNamespace {
  manage(input: Record<string, unknown>): Promise<unknown>;
  listAvailable(input?: { entity_id?: number }): Promise<unknown>;
  execute(input: OperationsExecuteInput): Promise<unknown>;
  listRuns(input?: {
    connection_id?: number;
    operation_key?: string;
    status?: string;
    approval_status?: string;
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
  const { manage, action } = createActionCaller(manageOperations, env, ctx);

  return {
    manage,
    listAvailable: (input) => action("list_available", input),
    execute: (input) => action("execute", input),
    listRuns: (input) => action("list_runs", input),
    getRun: (run_id) => action("get_run", { run_id }),
    approve: (input) => action("approve", input),
    reject: (input) => action("reject", input),
  };
}
