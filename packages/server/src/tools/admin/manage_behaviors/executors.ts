/**
 * Executor resolution for Behaviors — the "when -> who" matrix.
 *
 * A Behavior is an org-level goal with one durable contract (prompt, outputs,
 * reaction script, budget). Its triggers may route activations to different
 * executors via a per-trigger `respond_with` override:
 *
 *  - `{ kind: "agent", agent_id }` — managed Lobu agent (server dispatch lane)
 *  - `{ kind: "device", device_worker_id, agent_kind? }` — device worker lane
 *  - omitted — fall back to the Behavior's own executor
 *    (`agent_id` / `device_worker_id`)
 *
 * Resolution rules enforced here (create/update):
 *
 *  - Every event/schedule trigger MUST resolve to an executor — its own
 *    override or the Behavior default. An automated activation with no
 *    executor is a zombie: there is no lane that could ever run it.
 *  - A Behavior with NO triggers is manual-only: executor is optional. Manual
 *    activations are open — any connected MCP client may execute and complete
 *    them (write-tier `complete_window`), so they are never addressed.
 */
import type {
  BehaviorEventTrigger,
  BehaviorRespondWith,
  BehaviorScheduleTrigger,
} from "@lobu/core/contracts/tools/manage-behaviors";
import type { DbClient } from "../../../db/client";
import { ToolUserError } from "../../../utils/errors";
import type { ToolContext } from "../../registry";
import { assertDeviceWorkerAccess } from "../behavior-device-access";
import { assertAgentExists } from "./shared";

export type BehaviorTriggerInput =
  | BehaviorEventTrigger
  | BehaviorScheduleTrigger;

/** Behavior-level executor defaults (columns on the watchers row). */
export interface BehaviorExecutorDefaults {
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

/** Resolve one trigger's executor: its own override, else the defaults.
 * Default precedence is DEVICE PIN FIRST: legacy dual rows carried both
 * agent_id and device_worker_id and always ran on the device lane (#802) —
 * agent-first fallback would silently flip those runs to server dispatch. */
export function resolveTriggerExecutor(
  trigger: { respond_with?: BehaviorRespondWith } | null | undefined,
  defaults: BehaviorExecutorDefaults
): ResolvedExecutor | null {
  const override = trigger?.respond_with;
  if (override) {
    return override.kind === "agent"
      ? { kind: "agent", agentId: override.agent_id }
      : {
          kind: "device",
          deviceWorkerId: override.device_worker_id,
          agentKind: override.agent_kind ?? null,
        };
  }
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

/** The Behavior-level default executor (what an override-less trigger uses). */
export function resolveBehaviorExecutor(
  defaults: BehaviorExecutorDefaults
): ResolvedExecutor | null {
  return resolveTriggerExecutor(null, defaults);
}

function describeTrigger(trigger: BehaviorTriggerInput, index: number): string {
  if (trigger.kind === "event") {
    return `event trigger ${index + 1} (${trigger.connector_key})`;
  }
  return `schedule trigger ${index + 1} (${trigger.cron})`;
}

/**
 * Structural matrix check. Rules:
 *  - Automated Behaviors (any event/schedule trigger) MUST have a
 *    Behavior-level executor (agent_id or device_worker_id). Per-trigger
 *    respond_with is a pure OVERRIDE of which executor runs — it can never be
 *    the sole source of one, because the scheduler/event SELECTs gate on the
 *    row-level columns; an override-only Behavior would validate but never
 *    fire.
 *  - Every automated trigger must resolve (always true once the default
 *    exists; kept for clarity and future trigger-level validation).
 *  - Manual-only Behaviors (no triggers) pass with or without an executor.
 */
export function assertBehaviorExecutorsResolve(
  triggers: BehaviorTriggerInput[] | null | undefined,
  defaults: BehaviorExecutorDefaults
): void {
  const automated = (triggers ?? []).filter(
    (trigger): trigger is BehaviorTriggerInput =>
      trigger.kind === "event" || trigger.kind === "schedule"
  );
  if (automated.length === 0) return;
  if (!resolveBehaviorExecutor(defaults)) {
    throw new ToolUserError(
      "Automated Behaviors need a Behavior-level executor: set agent_id (managed agent) or device_worker_id (device). Trigger respond_with overrides which executor runs, but cannot be the only one. Manual-only Behaviors (no triggers) may omit both."
    );
  }
  automated.forEach((trigger, index) => {
    if (!resolveTriggerExecutor(trigger, defaults)) {
      throw new ToolUserError(
        `${describeTrigger(trigger, index)} has no executor: set respond_with on the trigger or agent_id/device_worker_id on the Behavior.`
      );
    }
  });
}

/**
 * DB-level authorization for every executor the Behavior references: the
 * Behavior-level device pin (ALWAYS, even when an agent default shadows it in
 * resolution — storing a pin the caller may not target is itself the exploit),
 * the Behavior-level agent, and every per-trigger override. Deduped.
 */
export async function assertBehaviorExecutorsAuthorized(
  sql: DbClient,
  organizationId: string,
  triggers: BehaviorTriggerInput[] | null | undefined,
  defaults: BehaviorExecutorDefaults,
  ctx: ToolContext
): Promise<void> {
  const executors: ResolvedExecutor[] = [];
  if (defaults.deviceWorkerId) {
    executors.push({
      kind: "device",
      deviceWorkerId: defaults.deviceWorkerId,
      agentKind: defaults.agentKind ?? null,
    });
  }
  if (defaults.agentId) {
    executors.push({ kind: "agent", agentId: defaults.agentId });
  }
  for (const trigger of triggers ?? []) {
    if (trigger.kind !== "event" && trigger.kind !== "schedule") continue;
    const override = trigger.respond_with;
    if (!override) continue;
    executors.push(
      override.kind === "agent"
        ? { kind: "agent", agentId: override.agent_id }
        : {
            kind: "device",
            deviceWorkerId: override.device_worker_id,
            agentKind: override.agent_kind ?? null,
          }
    );
  }

  const seenAgents = new Set<string>();
  const seenDevices = new Set<string>();
  for (const executor of executors) {
    if (executor.kind === "agent") {
      if (seenAgents.has(executor.agentId)) continue;
      seenAgents.add(executor.agentId);
      await assertAgentExists(sql, organizationId, executor.agentId);
    } else {
      if (seenDevices.has(executor.deviceWorkerId)) continue;
      seenDevices.add(executor.deviceWorkerId);
      await assertDeviceWorkerAccess(sql, executor.deviceWorkerId, ctx);
    }
  }
}
