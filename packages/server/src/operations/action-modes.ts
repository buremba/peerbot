/**
 * Connection action mode resolution.
 *
 * Each connection.config carries an `action_modes` map keyed by operation_key
 * with one of three values: 'disabled' | 'approval' | 'auto'. For operations
 * the user has never explicitly configured (e.g. the connector update adds a
 * new op after install), we fall back to the connector's
 * op.requires_approval default.
 */

import type { OperationDescriptor } from './types';

export type ActionMode = 'disabled' | 'approval' | 'auto';

export const ACTION_MODES: readonly ActionMode[] = ['disabled', 'approval', 'auto'] as const;

export function isActionMode(value: unknown): value is ActionMode {
  return value === 'disabled' || value === 'approval' || value === 'auto';
}

/**
 * Pull a sanitized `action_modes` map out of a raw connection.config blob.
 * Anything that isn't a recognized mode is dropped silently — readers must
 * then fall back to {@link defaultModeFromOperation}.
 */
export function getActionModes(
  config: Record<string, unknown> | null | undefined
): Record<string, ActionMode> {
  if (!config || typeof config !== 'object') return {};
  const raw = (config as Record<string, unknown>).action_modes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ActionMode> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isActionMode(value)) out[key] = value;
  }
  return out;
}

/**
 * Default mode for an operation the user never explicitly configured.
 * Preserves today's "all on" behavior: anything that previously required
 * approval still requires approval; anything else auto-approves.
 * `disabled` requires an explicit user opt-in.
 */
export function defaultModeFromOperation(operation: {
  requires_approval: boolean;
}): ActionMode {
  return operation.requires_approval ? 'approval' : 'auto';
}

export function resolveActionMode(
  operation: { requires_approval: boolean; operation_key: string },
  config: Record<string, unknown> | null | undefined
): ActionMode {
  const modes = getActionModes(config);
  return modes[operation.operation_key] ?? defaultModeFromOperation(operation);
}

/**
 * Filter a list of operations against a connection's action_modes,
 * dropping anything in 'disabled' mode. Used by list_available and the
 * tool-registration path so disabled actions never surface to the worker.
 */
export function filterOperationsByActionModes<T extends OperationDescriptor>(
  operations: T[],
  config: Record<string, unknown> | null | undefined
): T[] {
  return operations.filter(
    (operation) => resolveActionMode(operation, config) !== 'disabled'
  );
}
