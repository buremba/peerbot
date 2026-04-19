import logger from '../../utils/logger';

/**
 * Routes admin tool actions to handler functions with standardized error wrapping.
 *
 * Usage:
 *   return routeAction('manage_entity', args.action, {
 *     create: () => handleCreate(args, env, ctx),
 *     update: () => handleUpdate(id, args, env, ctx),
 *     list: () => handleList(args, env, ctx),
 *   });
 */
export async function routeAction<TResult>(
  toolName: string,
  action: string,
  handlers: Record<string, () => Promise<TResult>>
): Promise<TResult> {
  const handler = handlers[action];
  if (!handler) {
    throw new Error(`Unknown action: ${action}`);
  }

  try {
    return await handler();
  } catch (error) {
    logger.error({ error }, `${toolName} error:`);
    throw error;
  }
}

/**
 * Requires a field to be present, throwing a descriptive error if missing.
 * Common pattern for requiring entity_id, watcher_id, etc. per action.
 */
export function requireField<T>(value: T | undefined | null, fieldName: string, action: string): T {
  if (value === undefined || value === null) {
    throw new Error(`${fieldName} is required for ${action} action`);
  }
  return value;
}
