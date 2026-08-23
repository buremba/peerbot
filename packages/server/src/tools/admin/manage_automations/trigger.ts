/**
 * Trigger and reaction script action handlers for manage_automations:
 *   trigger, set_reaction_script
 */

import { getDb, type DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { isLobuGatewayRunning } from "../../../lobu/gateway";
import { ToolUserError } from "../../../utils/errors";
import logger from "../../../utils/logger";
import {
  dispatchPendingAutomationRuns,
  enqueueAutomationRunForAutomationInTransaction,
  getAutomationRunInfo,
  parseAutomationRunPayload,
} from "../../../automations/automation";
import {
  compileReactionScript,
  extractReactionInputSchema,
  validateReactionDefaultExport,
} from "../../../automations/reaction-executor";
import { assertAutomationInstructions } from "../../../automations/triggers";
import type {
  AutomationTrigger,
  AutomationTriggerExecution,
  AutomationTriggerResult,
} from "@lobu/core/contracts/tools/manage-automations";
import type { ToolContext } from "../../registry";
import { recordToolConfigChange } from "../helpers/config-audit";
import { requireExists } from "../helpers/db-helpers";
import type { ManageAutomationsArgs } from "../manage_automations";
import { resolveAutomationExecutor } from "./executors";

async function loadTriggerExecution(
  sql: DbClient,
  runId: number,
  automationId: string,
): Promise<AutomationTriggerExecution> {
  const [run] = await sql<{ approved_input: unknown }>`
    SELECT approved_input
    FROM runs
    WHERE id = ${runId}
      AND automation_id = ${Number(automationId)}
      AND run_type = 'automation'
    LIMIT 1
  `;
  const payload = parseAutomationRunPayload(run?.approved_input);
  if (!payload || payload.automation_id !== Number(automationId)) {
    throw new Error("Automation run is missing a valid dispatch payload.");
  }
  const executor = resolveAutomationExecutor({
    agentId: payload.agent_id,
    deviceWorkerId: payload.device_worker_id,
    agentKind: payload.agent_kind,
  });
  if (executor?.kind === "agent") {
    return {
      lane: "managed_agent",
      owner: "lobu",
      agent_id: executor.agentId,
      next_action: { kind: "handled_elsewhere" },
    };
  }
  if (executor?.kind === "device") {
    return {
      lane: "device_worker",
      owner: "device",
      device_worker_id: executor.deviceWorkerId,
      agent_kind: executor.agentKind,
      next_action: { kind: "handled_elsewhere" },
    };
  }
  return {
    lane: "external_client",
    owner: "caller",
    next_action: {
      kind: "complete_window",
      read: {
        method: "knowledge.read",
        input: { automation_id: payload.automation_id, run_id: runId },
      },
      // biome-ignore lint/suspicious/noThenProperty: Public protocol field required by the trigger handoff contract.
      then: "automations.completeWindow",
    },
  };
}

// ============================================
// handleTrigger
// ============================================

export async function handleTrigger(
  args: ManageAutomationsArgs,
  _env: Env,
): Promise<AutomationTriggerResult> {
  const sql = getDb();

  if (!args.automation_id) {
    throw new ToolUserError("automation_id is required for trigger action", 400);
  }
  const automationId = args.automation_id;

  const queued = await sql.begin(async (tx) => {
    const run = await enqueueAutomationRunForAutomationInTransaction(
      Number(automationId),
      "manual",
      tx,
    );
    const execution = await loadTriggerExecution(
      tx,
      run.runId,
      automationId,
    );
    if (execution.lane === "managed_agent" && !isLobuGatewayRunning()) {
      throw new Error("Embedded Lobu is not available.");
    }
    return { ...run, execution };
  });
  const dispatch = await dispatchPendingAutomationRuns({
    db: sql,
    runIds: [queued.runId],
  });
  const runInfo = await getAutomationRunInfo(queued.runId, sql);

  if (dispatch.failed > 0) {
    throw new Error(
      runInfo?.error_message || "Failed to dispatch Automation run.",
    );
  }

  return {
    action: "trigger",
    automation_id: automationId,
    run_id: queued.runId,
    status: runInfo?.status ?? queued.status,
    created: queued.created,
    execution: queued.execution,
  };
}

// ============================================
// handleSetReactionScript
// ============================================

export async function handleSetReactionScript(
  args: ManageAutomationsArgs,
  _env: Env,
  ctx: ToolContext,
): Promise<{
  action: "set_reaction_script";
  automation_id: string;
  has_script: boolean;
  message: string;
}> {
  const sql = getDb();

  if (!args.automation_id) {
    throw new ToolUserError("automation_id is required for set_reaction_script", 400);
  }

  await requireExists(sql, "automations", args.automation_id, "Automation");

  // Reaction script is a group-shared field — every assignment in the
  // group runs the same reactions after completion. Resolve the group once
  // and cascade across all assignments so we don't silently fork.
  const groupRows = await sql`
    SELECT automation_group_id FROM automations WHERE id = ${args.automation_id} LIMIT 1
  `;
  const groupId = Number(groupRows[0].automation_group_id);

  const script = args.reaction_script;

  if (!script || script.trim() === "") {
    // Clearing the reaction can orphan a prompt-less Automation: removing the
    // only instruction source leaves a schedule/window/manual Automation with
    // nothing to run on. Re-run the instruction rule against every assignment's
    // final state (triggers per-assignment; prompt/skills group-shared through
    // the current version) and reject the clear if it would leave any
    // assignment invalid.
    const groupState = await sql`
      SELECT w.id, w.triggers, cv.prompt, cv.skills
      FROM automations w
      LEFT JOIN automation_versions cv ON cv.id = w.current_version_id
      WHERE w.automation_group_id = ${groupId}
    `;
    for (const assignment of groupState) {
      try {
        assertAutomationInstructions(
          (assignment.triggers ?? []) as AutomationTrigger[],
          assignment.prompt as string | null | undefined,
          (assignment.skills ?? null) as Array<{ name: string; content: string }> | null,
          null
        );
      } catch (err) {
        if (err instanceof ToolUserError) {
          throw new ToolUserError(
            `Cannot remove the reaction script: ${err.message}`,
            422
          );
        }
        throw err;
      }
    }
    await sql`
      UPDATE automations
      SET reaction_script = NULL, reaction_script_compiled = NULL,
          reaction_input_schema = NULL
      WHERE automation_group_id = ${groupId}
    `;
    recordToolConfigChange(ctx, {
      resourceKind: "automation",
      resourceId: args.automation_id,
      op: "updated",
      summary: `Automation ${args.automation_id} reaction script removed`,
      state: {
        id: args.automation_id,
        automation_group_id: groupId,
        reaction_script: null,
        reaction_input_schema: null,
      },
      changedFields: ["reaction_script"],
    });
    return {
      action: "set_reaction_script",
      automation_id: String(args.automation_id),
      has_script: false,
      message: "Reaction script removed.",
    };
  }

  const compiledCode = await compileReactionScript(script);
  await validateReactionDefaultExport(compiledCode);
  // Derive the reaction's extraction contract from its exported `input` schema,
  // so the worker is told the exact shape the reaction will Value.Parse. NULL
  // when the reaction declares no `input` (free-form `{ summary }` fallback).
  const reactionInputSchema = await extractReactionInputSchema(script);

  await sql`
    UPDATE automations
    SET reaction_script = ${script}, reaction_script_compiled = ${compiledCode},
        reaction_input_schema = ${reactionInputSchema ? sql.json(reactionInputSchema) : null}
    WHERE automation_group_id = ${groupId}
  `;

  logger.info(
    `[manage_automations] Set reaction script for automation ${args.automation_id}`,
  );

  recordToolConfigChange(ctx, {
    resourceKind: "automation",
    resourceId: args.automation_id,
    op: "updated",
    summary: `Automation ${args.automation_id} reaction script updated`,
    // Snapshot of the fields just written (row not refetched); compiled code
    // is intentionally omitted to keep the state small.
    state: {
      id: args.automation_id,
      automation_group_id: groupId,
      reaction_script: script,
      reaction_input_schema: reactionInputSchema ?? null,
    },
    changedFields: ["reaction_script"],
  });

  return {
    action: "set_reaction_script",
    automation_id: String(args.automation_id),
    has_script: true,
    message:
      "Reaction script compiled and saved. It will auto-execute on future complete_window calls.",
  };
}
