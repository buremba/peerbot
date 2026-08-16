/**
 * Trigger and reaction script action handlers for manage_automations:
 *   trigger, set_reaction_script
 */

import { getDb } from "../../../db/client";
import type { Env } from "../../../index";
import { isLobuGatewayRunning } from "../../../lobu/gateway";
import { ToolUserError } from "../../../utils/errors";
import logger from "../../../utils/logger";
import {
  getAutomationRunInfo,
  queueAndDispatchAutomationRun,
} from "../../../automations/automation";
import {
  compileReactionScript,
  extractReactionInputSchema,
} from "../../../automations/reaction-executor";
import { assertAutomationInstructions } from "../../../automations/triggers";
import type { AutomationTrigger } from "@lobu/core/contracts/tools/manage-automations";
import type { ToolContext } from "../../registry";
import { recordToolConfigChange } from "../helpers/config-audit";
import { requireExists } from "../helpers/db-helpers";
import type { ManageAutomationsArgs } from "../manage_automations";

// ============================================
// handleTrigger
// ============================================

export async function handleTrigger(
  args: ManageAutomationsArgs,
  _env: Env,
): Promise<{
  action: "trigger";
  automation_id: string;
  run_id: number;
  status: string;
}> {
  const sql = getDb();

  if (!args.automation_id) {
    throw new ToolUserError("automation_id is required for trigger action", 400);
  }

  if (!isLobuGatewayRunning()) {
    throw new Error("Embedded Lobu is not available.");
  }
  const dispatchResult = await queueAndDispatchAutomationRun(
    Number(args.automation_id),
    "manual",
    sql,
  );

  if (dispatchResult.dispatch.failed > 0) {
    const failedRun = await getAutomationRunInfo(dispatchResult.runId, sql);
    throw new Error(
      failedRun?.error_message || "Failed to dispatch Automation run.",
    );
  }

  return {
    action: "trigger",
    automation_id: args.automation_id,
    run_id: dispatchResult.runId,
    status: dispatchResult.status,
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
  // group runs the same reactions on its windows. Resolve the group once
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
