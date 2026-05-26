import { Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { ToolUserError } from '../../utils/errors';

/**
 * Per-watcher device-worker CLI execution settings (stored as the
 * `watchers.execution_config` jsonb). Standalone so the same shape both feeds
 * ManageWatchersSchema and compiles into a runtime validator — manage_watchers
 * args are otherwise NOT schema-validated at the call boundary, and an
 * unvalidated, type-wrong value would silently fail the device-worker's strict
 * payload decode (bricking every run of that watcher).
 */
export const WatcherExecutionConfigSchema = Type.Object(
  {
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        // Bounded: the device dispatcher runs one CLI at a time, so an
        // unbounded value could wedge a device's watcher queue. 24h ceiling.
        maximum: 86_400,
        description: 'Wall-clock cap in seconds for the device-worker CLI run (default 600).',
      })
    ),
    max_budget_usd: Type.Optional(
      Type.Number({
        minimum: 0,
        description: 'Per-run dollar ceiling (claude only: --max-budget-usd). No-op on other CLIs.',
      })
    ),
    model: Type.Optional(Type.String({ description: 'Model alias/id passed to the CLI (--model).' })),
    permission_mode: Type.Optional(
      Type.Union(
        [
          Type.Literal('acceptEdits'),
          Type.Literal('auto'),
          Type.Literal('bypassPermissions'),
          Type.Literal('default'),
          Type.Literal('dontAsk'),
          Type.Literal('plan'),
        ],
        { description: 'Tool permission mode (claude only: --permission-mode).' }
      )
    ),
    effort: Type.Optional(
      Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], {
        description: 'Reasoning effort (claude only: --effort).',
      })
    ),
  },
  {
    additionalProperties: false,
    description:
      '[create/update] Per-watcher device-worker CLI execution settings. Omitted fields fall back to dispatcher/CLI defaults; pass null to clear.',
  }
);

const executionConfigValidator = TypeCompiler.Compile(WatcherExecutionConfigSchema);

// Permission modes that let the spawned agent act unattended without prompting.
// Restricted to org owner/admin: a member-write actor can pin a watcher to
// another user's device, so allowing them to set these would be a privilege
// escalation (unattended privileged execution on the device owner's machine).
const ELEVATED_PERMISSION_MODES = new Set(['bypassPermissions', 'dontAsk']);

/** Minimal caller identity needed to authorize elevated permission modes. */
export interface ExecutionConfigCaller {
  memberRole: string | null;
  userId: string | null;
  isAuthenticated: boolean;
}

/**
 * Validate an incoming `execution_config`. `undefined` = unchanged, `null` =
 * clear — both pass. An object is validated against the schema
 * (types/enums/range); elevated permission modes require owner/admin. Throws
 * ToolUserError on rejection.
 */
export function assertValidExecutionConfig(value: unknown, caller: ExecutionConfigCaller): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolUserError('execution_config must be a JSON object or null.');
  }
  if (!executionConfigValidator.Check(value)) {
    const errs = [...executionConfigValidator.Errors(value)]
      .slice(0, 5)
      .map((e) => `${e.path || '/'}: ${e.message}`)
      .join('; ');
    throw new ToolUserError(`Invalid execution_config — ${errs}`);
  }
  const mode = (value as { permission_mode?: string }).permission_mode;
  // System/internal callers (apply, automation, default-provisioning) carry no
  // memberRole and already bypass action-access enforcement; don't block them.
  const isSystem =
    caller.isAuthenticated && caller.userId === null && caller.memberRole === null;
  const isOwnerOrAdmin = caller.memberRole === 'owner' || caller.memberRole === 'admin';
  if (mode && ELEVATED_PERMISSION_MODES.has(mode) && !isSystem && !isOwnerOrAdmin) {
    throw new ToolUserError(
      `execution_config.permission_mode '${mode}' requires an owner or admin role; members may use: default, plan, auto, acceptEdits.`
    );
  }
}
