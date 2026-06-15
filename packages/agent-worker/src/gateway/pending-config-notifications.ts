/**
 * Leaf module for the worker's pending config-change notification queue.
 *
 * The SSE client (`sse-client.ts`) pushes `config_changed` entries here as they
 * arrive; the session runner (`session-runner.ts`) drains them before building
 * the next prompt. Keeping this state in a dependency-free leaf module lets both
 * sides import it statically without forming the
 * `session-runner → sse-client → worker → session-runner` import cycle.
 */

export interface ConfigChangeEntry {
  category: string;
  action: string;
  summary: string;
  details?: string[];
}

const pendingConfigNotifications: ConfigChangeEntry[] = [];

/** Queue config-change notifications received from the gateway. */
export function pushPendingConfigNotifications(
  changes: ConfigChangeEntry[]
): void {
  pendingConfigNotifications.push(...changes);
}

/**
 * Returns and clears all pending config change notifications.
 * Called by the worker before building the next prompt.
 */
export function consumePendingConfigNotifications(): ConfigChangeEntry[] {
  if (pendingConfigNotifications.length === 0) return [];
  return pendingConfigNotifications.splice(0);
}
