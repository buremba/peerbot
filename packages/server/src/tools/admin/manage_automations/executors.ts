/**
 * Executor resolution for Automations.
 *
 * An Automation is an org-level goal with one durable contract (prompt, outputs,
 * reaction script, budget) and exactly ONE executor:
 *
 *  - `agent_id` — a managed Lobu agent executes runs (server dispatch lane)
 *  - `device_worker_id` — the pinned device worker's local CLI executes them
 *    (device lane); `agent_kind` picks the local runtime, null = device
 *    default
 *
 * Triggers are the "when" and carry no executor of their own.
 *
 * Resolution rules enforced here (create/update):
 *
 *  - Every automated Automation (any event/schedule trigger) MUST have an
 *    executor — an automated activation with no executor is a zombie: there
 *    is no lane that could ever run it (the scheduler/event SELECTs gate on
 *    the row-level columns).
 *  - An Automation with NO triggers is manual-only: executor is optional. Manual
 *    activations are open — any connected MCP client may execute and complete
 *    them (write-tier `complete_window`), so they are never addressed.
 */
import type {
  AutomationEventTrigger,
  AutomationScheduleTrigger,
  AutomationWorkspaceEventTrigger,
} from "@lobu/core/contracts/tools/manage-automations";
import type { DbClient } from "../../../db/client";
import { ToolUserError } from "../../../utils/errors";
import type { ToolContext } from "../../registry";
import { assertDeviceWorkerAccess } from "../automation-device-access";
import { assertAgentExists } from "./shared";

export type AutomationTriggerInput =
  | AutomationEventTrigger
  | AutomationWorkspaceEventTrigger
  | AutomationScheduleTrigger;

/** Automation-level executor (columns on the automations row). */
export interface AutomationExecutorDefaults {
  agentId?: string | null;
  deviceWorkerId?: string | null;
  agentKind?: string | null;
}

export type ResolvedExecutor =
  | { kind: "agent"; agentId: string }
  | {
      kind: "device";
      deviceWorkerId: string;
      agentKind: string | null;
    };

/** Resolve the Automation's executor.
 * Precedence is DEVICE PIN FIRST: legacy dual rows carried both agent_id and
 * device_worker_id and always ran on the device lane (#802) — agent-first
 * fallback would silently flip those runs to server dispatch. */
export function resolveAutomationExecutor(
  defaults: AutomationExecutorDefaults
): ResolvedExecutor | null {
  if (defaults.deviceWorkerId) {
    return {
      kind: "device",
      deviceWorkerId: defaults.deviceWorkerId,
      agentKind: defaults.agentKind ?? null,
    };
  }
  if (defaults.agentId) {
    return { kind: "agent", agentId: defaults.agentId };
  }
  return null;
}

/**
 * Structural matrix check. Rules:
 *  - Automated Automations (any event/schedule trigger) MUST have an executor.
 *    Triggers carry no executor of their own, and the scheduler/event SELECTs
 *    gate on the row-level columns — an executor-less automated Automation
 *    would validate but never fire.
 *  - Manual-only Automations (no triggers) pass with or without an executor.
 */
export function assertAutomationExecutorsResolve(
  triggers: AutomationTriggerInput[] | null | undefined,
  defaults: AutomationExecutorDefaults
): void {
  const automated = (triggers ?? []).some(
    (trigger) => trigger.kind === "event" || trigger.kind === "schedule"
  );
  if (!automated) return;
  if (!resolveAutomationExecutor(defaults)) {
    throw new ToolUserError(
      "Automated Automations need an executor: set agent_id (managed agent) or device_worker_id (device). Manual-only Automations (no triggers) may omit both."
    );
  }
}

/**
 * DB-level authorization for every executor the Automation references: the
 * device pin (ALWAYS, even when an agent shadows it in resolution — storing a
 * pin the caller may not target is itself the exploit) and the agent.
 */
export async function assertAutomationExecutorsAuthorized(
  sql: DbClient,
  organizationId: string,
  defaults: AutomationExecutorDefaults,
  ctx: ToolContext
): Promise<void> {
  if (defaults.deviceWorkerId) {
    await assertDeviceWorkerAccess(sql, defaults.deviceWorkerId, ctx);
  }
  if (defaults.agentId) {
    await assertAgentExists(sql, organizationId, defaults.agentId);
  }
}
