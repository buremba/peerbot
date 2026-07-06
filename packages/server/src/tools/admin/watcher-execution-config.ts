import { WatcherExecutionConfigSchema } from '@lobu/core/contracts/tools/manage-watchers';
import { ToolUserError } from '../../utils/errors';
import { isAdminOrOwnerRole } from '../access-control';

/**
 * Per-watcher device-worker CLI execution settings. The pure TypeBox schema
 * lives in @lobu/core with the manage_watchers contract; this server module
 * keeps the authorization/runtime helpers colocated with their callers.
 */
export { WatcherExecutionConfigSchema };

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
