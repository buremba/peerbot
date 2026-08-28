/**
 * Durable tasks that may be inserted inside an existing domain transaction.
 *
 * Keeping this manifest separate from the scheduler instance lets domain
 * writers commit their row and handoff atomically without accepting arbitrary
 * task names. Boot registration and enqueue sites import the same definition,
 * so adding another transactional task is an explicit platform change.
 */
export const WORKSPACE_EVENT_ACTIVATION_TASK = 'activate-workspace-event';
export const INTERACTIVE_EVENT_CARD_REFRESH_TASK =
  'refresh-interactive-event-card';

export function isTransactionalTaskName(name: string): boolean {
  return (
    name === WORKSPACE_EVENT_ACTIVATION_TASK ||
    name === INTERACTIVE_EVENT_CARD_REFRESH_TASK
  );
}
