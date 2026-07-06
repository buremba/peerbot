import { Type } from "@sinclair/typebox";

// ============================================
// Schema
// ============================================

export const SendNotificationArgs = Type.Object({
  type: Type.Literal("send_notification"),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.Optional(Type.String({ maxLength: 1000 })),
  recipients: Type.Optional(
    Type.Union([
      Type.Literal("admins"),
      Type.Literal("all"),
      Type.Array(Type.String()),
    ])
  ),
  resource_url: Type.Optional(Type.String()),
});

export const WakeAgentArgs = Type.Object({
  type: Type.Literal("wake_agent"),
  agent_id: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1, maxLength: 4000 }),
  thread_id: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String({ maxLength: 200 })),
  /**
   * Optional per-schedule model override (a `provider/model` ref or "auto").
   * When set it wins over the agent's default and the org default at run
   * enqueue; when omitted the layered fallback (agent → org) resolves it.
   */
  model: Type.Optional(Type.String({ maxLength: 200 })),
});

export const ActionUnion = Type.Union([SendNotificationArgs, WakeAgentArgs]);

export const CreateAction = Type.Object({
  action: Type.Literal("create", {
    description:
      "Create a scheduled job (one-shot via run_at, or recurring with cron).",
  }),
  description: Type.String({ minLength: 1, maxLength: 200 }),
  /**
   * RFC3339 timestamp for the first (or only) firing. Required.
   * For one-shot schedules this is the only firing.
   */
  run_at: Type.String({
    description:
      "ISO timestamp for the first / only firing (e.g. '2026-05-15T09:00:00Z').",
  }),
  /**
   * Cron expression. When set, the job re-fires on this cron after
   * each firing. When omitted, the job is one-shot.
   */
  cron: Type.Optional(Type.String()),
  /** Handler-specific payload. The `type` field selects the handler. */
  payload: ActionUnion,
  /**
   * Optional source attribution — pass when the schedule was triggered
   * by another run / event / chat thread so the audit trail captures it.
   */
  source_run_id: Type.Optional(Type.Number()),
  source_event_id: Type.Optional(Type.Number()),
  source_thread_id: Type.Optional(Type.String()),
});

export const ListAction = Type.Object({
  action: Type.Literal("list", {
    description: "List scheduled jobs with optional filters.",
  }),
  agent_id: Type.Optional(Type.String()),
  user_id: Type.Optional(Type.String()),
  action_type: Type.Optional(Type.String()),
  include_paused: Type.Optional(Type.Boolean()),
});

export const UpdateAction = Type.Object({
  action: Type.Literal("update", {
    description: "Patch a schedule (next firing, cron, wake_agent prompt).",
  }),
  id: Type.String({ format: "uuid" }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  /** RFC3339 timestamp to reschedule the next firing. */
  run_at: Type.Optional(Type.String()),
  /**
   * New cron cadence, or `null` to clear it (recurring → one-shot). Omit to
   * leave the cadence unchanged.
   */
  cron: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** New `wake_agent` prompt (the only editable payload field). */
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  /**
   * New per-schedule model override (a `provider/model` ref or "auto"), or an
   * empty string to clear it (fall back to agent/org default). Omit to leave
   * the model unchanged.
   */
  model: Type.Optional(Type.String({ maxLength: 200 })),
});

export const PauseAction = Type.Object({
  action: Type.Literal("pause", {
    description: "Pause or resume a schedule.",
  }),
  id: Type.String({ format: "uuid" }),
  paused: Type.Optional(Type.Boolean({ default: true })),
});

export const CancelAction = Type.Object({
  action: Type.Literal("cancel", {
    description: "Permanently delete a schedule.",
  }),
  id: Type.String({ format: "uuid" }),
});

export const ManageSchedulesSchema = Type.Union([
  CreateAction,
  ListAction,
  UpdateAction,
  PauseAction,
  CancelAction,
]);
