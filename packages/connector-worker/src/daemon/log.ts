/**
 * Daemon logging.
 *
 * All daemon runtime output goes to stderr (stdout is reserved for the spawned
 * CLI and any machine-readable output). By default we log one line per run —
 * the run's start and its terminal result — plus startup/shutdown and hard
 * failures. Pass `--debug` to enable the poll/heartbeat/retry chatter.
 */

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export const log = {
  /** Always-on: one line per run, startup/shutdown, and hard failures. */
  info: (...parts: unknown[]): void => {
    console.error(...parts);
  },
  /** Debug-only: poll chatter, heartbeats, retry and backoff detail. */
  debug: (...parts: unknown[]): void => {
    if (debugEnabled) console.error(...parts);
  },
};
