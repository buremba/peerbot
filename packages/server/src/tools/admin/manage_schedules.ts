/**
 * Tool: manage_schedules
 *
 * User-facing CRUD over `scheduled_jobs`. Recurring or one-shot. Two
 * built-in action types out of the box:
 *
 *   - `send_notification` — at the scheduled time, run the notify-tool's
 *     server-side path: resolve recipients, insert event + targets.
 *     Same shape as the immediate `notify` tool, minus the synchronous
 *     in-line fire.
 *   - `wake_agent` — at the scheduled time, post a synthetic user message
 *     to an agent's thread. Lets an agent schedule its own follow-up
 *     ("wake me in an hour and check X") and survives crashes / deploys.
 *
 * Attribution is captured from the calling ToolContext: a user-driven
 * create stores `created_by_user`; an agent-driven create (via the
 * gateway's agent loop) gets `created_by_agent` set. The agent can later
 * list / pause its own schedules without holding extra state.
 */

import type { Static } from '@sinclair/typebox';
import {
  CancelAction,
  CreateAction,
  ListAction,
  ManageSchedulesSchema,
  PauseAction,
  UpdateAction,
} from '@lobu/core/contracts/tools/manage-schedules';
import { action, defineActionTool } from './action-tool';
import {
  createScheduledJob,
  type DeliveryAuthzDenyReason,
  deleteScheduledJob,
  getScheduledJob,
  isDeliverableChatPlatform,
  listScheduledJobs,
  pauseScheduledJob,
  type ScheduledDeliveryContext,
  type ScheduledJobRow,
  updateScheduledJob,
  validateDeliveryAuthorization,
} from '../../scheduled/scheduled-jobs-service';
import type { ToolContext, ToolSourceContext } from '../registry';
import logger from '../../utils/logger';
import { nextRunAt as nextCronTickAt } from '../../utils/cron';
import { getErrorMessage } from "@lobu/core";

// ============================================
// Handler
// ============================================

interface ToolResult {
  schedule?: ReturnType<typeof serializeSchedule>;
  schedules?: Array<ReturnType<typeof serializeSchedule>>;
  ok?: boolean;
  error?: string;
}

const manageSchedulesTool = defineActionTool('manage_schedules', {
  create: action(CreateAction, handleCreate),
  list: action(ListAction, handleList),
  update: action(UpdateAction, handleUpdate),
  pause: action(PauseAction, handlePause),
  cancel: action(CancelAction, handleCancel),
});

export { ManageSchedulesSchema };
export const manageSchedules = manageSchedulesTool.run;

async function handleCreate(
  args: Static<typeof CreateAction>,
  ctx: ToolContext
): Promise<ToolResult> {
  const runAtDate = new Date(args.run_at);
  if (Number.isNaN(runAtDate.getTime())) {
    return { error: `run_at is not a valid ISO timestamp: ${args.run_at}` };
  }
  // If cron is set, sanity-check it by computing the next tick from now.
  if (args.cron) {
    try {
      nextCronTickAt(args.cron);
    } catch (err) {
      return {
        error: `cron expression rejected: ${getErrorMessage(err)}`,
      };
    }
  }
  // action_type comes from the payload's discriminant `type`.
  const actionType = args.payload.type;
  // Persist only the schema-owned action fields. TypeBox permits additional
  // properties by default, so never copy the raw payload wholesale into a
  // durable scheduler row.
  const actionArgs = actionArgsForPayload(args.payload);

  const delivery = await resolveTrustedDeliveryContext(args.payload, ctx);
  if (delivery.error) return { error: delivery.error };

  const job = await createScheduledJob({
    organizationId: ctx.organizationId,
    actionType,
    actionArgs,
    deliveryContext: delivery.context,
    description: args.description,
    cron: args.cron ?? null,
    runAt: runAtDate,
    createdByUser: ctx.userId ?? null,
    createdByAgent: ctx.agentId ?? null,
    sourceRunId: args.source_run_id ?? null,
    sourceEventId: args.source_event_id ?? null,
    sourceThreadId: args.source_thread_id ?? null,
  });
  return { schedule: serializeSchedule(job) };
}

async function handleList(
  args: Static<typeof ListAction>,
  ctx: ToolContext
): Promise<ToolResult> {
  const rows = await listScheduledJobs({
    organizationId: ctx.organizationId,
    createdByAgent: args.agent_id ?? null,
    createdByUser: args.user_id ?? null,
    actionType: args.action_type ?? null,
    includePaused: args.include_paused ?? true,
  });
  return { schedules: rows.map(serializeSchedule) };
}

async function handleUpdate(
  args: Static<typeof UpdateAction>,
  ctx: ToolContext
): Promise<ToolResult> {
  let runAt: Date | undefined;
  if (args.run_at !== undefined) {
    runAt = new Date(args.run_at);
    if (Number.isNaN(runAt.getTime())) {
      return { error: `run_at is not a valid ISO timestamp: ${args.run_at}` };
    }
  }
  // A string cron is validated (empty string rejected); explicit null clears
  // the cadence (recurring → one-shot); omitted leaves it unchanged.
  if (typeof args.cron === 'string') {
    if (args.cron.trim() === '') {
      return {
        error: 'cron must be a non-empty expression, or null to clear the cadence.',
      };
    }
    try {
      nextCronTickAt(args.cron);
    } catch (err) {
      return { error: `cron expression rejected: ${getErrorMessage(err)}` };
    }
  }

  // A new prompt / model merges into the existing durable payload (keeping
  // agent_id / thread_id / reason) rather than replacing it wholesale. An
  // empty-string model clears the override (falls back to agent/org default).
  let actionArgs: Record<string, unknown> | undefined;
  if (args.prompt !== undefined || args.model !== undefined) {
    const existing = await getScheduledJob(ctx.organizationId, args.id);
    if (!existing) {
      return { error: `Schedule '${args.id}' not found in this organization.` };
    }
    if (existing.action_type !== 'wake_agent') {
      return { error: 'prompt/model can only be updated on a wake_agent schedule.' };
    }
    const merged: Record<string, unknown> = { ...existing.action_args };
    if (args.prompt !== undefined) merged.prompt = args.prompt;
    if (args.model !== undefined) {
      const model = args.model.trim();
      if (model) merged.model = model;
      else delete merged.model;
    }
    actionArgs = merged;
  }

  const job = await updateScheduledJob({
    organizationId: ctx.organizationId,
    id: args.id,
    description: args.description,
    cron: args.cron,
    runAt,
    actionArgs,
  });
  if (!job) return { error: `Schedule '${args.id}' not found in this organization.` };
  return { schedule: serializeSchedule(job), ok: true };
}

async function handlePause(
  args: Static<typeof PauseAction>,
  ctx: ToolContext
): Promise<ToolResult> {
  const ok = await pauseScheduledJob(ctx.organizationId, args.id, args.paused ?? true);
  if (!ok) return { error: `Schedule '${args.id}' not found in this organization.` };
  const job = await getScheduledJob(ctx.organizationId, args.id);
  return { schedule: job ? serializeSchedule(job) : undefined, ok: true };
}

async function handleCancel(
  args: Static<typeof CancelAction>,
  ctx: ToolContext
): Promise<ToolResult> {
  const ok = await deleteScheduledJob(ctx.organizationId, args.id);
  if (!ok) return { error: `Schedule '${args.id}' not found in this organization.` };
  logger.info({ schedule_id: args.id, org: ctx.organizationId }, '[manage_schedules] cancelled');
  return { ok: true };
}

function actionArgsForPayload(
  payload: Static<typeof CreateAction>['payload']
): Record<string, unknown> {
  if (payload.type === 'wake_agent') {
    return {
      agent_id: payload.agent_id,
      prompt: payload.prompt,
      ...(payload.thread_id ? { thread_id: payload.thread_id } : {}),
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(payload.model?.trim() ? { model: payload.model.trim() } : {}),
    };
  }
  return {
    title: payload.title,
    ...(payload.body !== undefined ? { body: payload.body } : {}),
    ...(payload.recipients !== undefined ? { recipients: payload.recipients } : {}),
    ...(payload.resource_url !== undefined ? { resource_url: payload.resource_url } : {}),
  };
}

function sourceToDeliveryContext(
  source: ToolSourceContext | null | undefined
): ScheduledDeliveryContext | null {
  // Only platforms the fire-time dispatch can actually deliver into; an
  // unsupported source platform stores no delivery_context (api fallback)
  // rather than a dead one that silently never posts.
  if (!source?.platform || !isDeliverableChatPlatform(source.platform)) return null;
  if (!source.connectionId || !source.channelId || !source.conversationId) return null;
  return {
    platform: source.platform,
    conversationId: source.conversationId,
    channelId: source.channelId,
    teamId: source.teamId ?? null,
    connectionId: source.connectionId,
    userId: source.userId ?? null,
  };
}

const DELIVERY_DENY_MESSAGE: Record<DeliveryAuthzDenyReason, string> = {
  'connection-missing':
    'Cannot schedule chat delivery: source connection no longer exists.',
  'platform-changed':
    'Cannot schedule chat delivery: source connection platform changed.',
  'connection-inactive':
    'Cannot schedule chat delivery: source connection is not active.',
  'agent-mismatch':
    'Cannot schedule chat delivery for a different agent on this connection.',
  'channel-unbound':
    'Cannot schedule chat delivery: channel is not bound to the target agent.',
};

async function resolveTrustedDeliveryContext(
  payload: Static<typeof CreateAction>['payload'],
  ctx: ToolContext
): Promise<{ context: ScheduledDeliveryContext | null; error?: string }> {
  if (payload.type !== 'wake_agent') return { context: null };

  const context = sourceToDeliveryContext(ctx.sourceContext);
  if (!context) return { context: null };

  const result = await validateDeliveryAuthorization({
    organizationId: ctx.organizationId,
    agentId: payload.agent_id,
    delivery: context,
  });
  if (!result.authorized) {
    return { context: null, error: DELIVERY_DENY_MESSAGE[result.reason] };
  }
  return { context };
}

function serializeSchedule(row: ScheduledJobRow) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    action_type: row.action_type,
    action_args: row.action_args,
    delivery_context: row.delivery_context,
    cron: row.cron,
    next_run_at: row.next_run_at,
    last_fired_at: row.last_fired_at,
    last_fired_run_id: row.last_fired_run_id,
    paused: row.paused,
    description: row.description,
    created_by_user: row.created_by_user,
    created_by_agent: row.created_by_agent,
    source_run_id: row.source_run_id,
    source_event_id: row.source_event_id,
    source_thread_id: row.source_thread_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
