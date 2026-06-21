import { Type } from '@sinclair/typebox';
import { ToolUserError } from '../../utils/errors';
import { isAdminOrOwnerRole } from '../access-control';

/**
 * Per-watcher device-worker CLI execution settings (stored as the
 * `watchers.execution_config` jsonb). Standalone so the shape can feed
 * ManageWatchersSchema (where boundary validation enforces it) while the
 * authorization gate below stays callable from the CRUD handlers. A
 * type-wrong value would silently fail the device-worker's strict payload
 * decode (bricking every run of that watcher), hence `additionalProperties:
 * false` — a typo'd setting must be rejected, not stored and ignored.
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
    finalize_nudges: Type.Optional(
      Type.Integer({
        minimum: 0,
        // Each nudge is a full re-dispatched agent turn ($), so keep the ceiling
        // low. SERVER-ONLY (see SERVER_ONLY_EXECUTION_CONFIG_KEYS) — stripped
        // before the device payload so an older device-worker's strict decode
        // never sees it.
        maximum: 5,
        description:
          'How many extra times to re-dispatch a server-side watcher run that finished WITHOUT calling complete_window (a soft, non-deterministic finalize miss) before failing it. 0 disables; omitted = global default (LOBU_WATCHER_FINALIZE_NUDGES, default 1).',
      })
    ),
  },
  {
    additionalProperties: false,
    description:
      '[create/update] Per-watcher execution settings: device-worker CLI flags plus the server-side finalize-nudge budget. Omitted fields fall back to dispatcher/CLI/global defaults; pass null to clear.',
  }
);

/**
 * execution_config keys that are SERVER-ONLY and must never reach a
 * device-worker — its strict payload decode (`additionalProperties: false`)
 * would reject an unknown field and brick every run of that watcher. Stripped
 * at the device boundary (worker-api/poll.ts) via stripServerOnlyExecutionConfig.
 */
export const SERVER_ONLY_EXECUTION_CONFIG_KEYS = ['finalize_nudges'] as const;

/**
 * Remove SERVER_ONLY_EXECUTION_CONFIG_KEYS from an execution_config before it
 * is handed to a device-worker. Returns null for an absent config, or one that
 * is left empty after stripping (so a watcher configured with ONLY server-only
 * keys sends the device `null`, i.e. "use defaults", rather than `{}`).
 */
export function stripServerOnlyExecutionConfig(
  config: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!config) return null;
  const serverOnly = SERVER_ONLY_EXECUTION_CONFIG_KEYS as readonly string[];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!serverOnly.includes(key)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
 * Authorize an incoming `execution_config`. `undefined` = unchanged, `null` =
 * clear — both pass. Shape/type/range validation happens at the tool boundary
 * (WatcherExecutionConfigSchema is embedded in ManageWatchersSchema); this
 * gate only enforces the role policy, which a schema cannot express.
 */
export function assertValidExecutionConfig(value: unknown, caller: ExecutionConfigCaller): void {
  if (value === undefined || value === null) return;
  const mode = (value as { permission_mode?: string }).permission_mode;
  // System/internal callers (apply, automation, default-provisioning) carry no
  // memberRole and already bypass action-access enforcement; don't block them.
  const isSystem =
    caller.isAuthenticated && caller.userId === null && caller.memberRole === null;
  const isOwnerOrAdmin = isAdminOrOwnerRole(caller.memberRole);
  if (mode && ELEVATED_PERMISSION_MODES.has(mode) && !isSystem && !isOwnerOrAdmin) {
    throw new ToolUserError(
      `execution_config.permission_mode '${mode}' requires an owner or admin role; members may use: default, plan, auto, acceptEdits.`
    );
  }
}
