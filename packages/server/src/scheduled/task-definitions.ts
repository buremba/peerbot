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
export const AUTOMATION_REACTION_TASK = 'automation-reaction';
export const AUTOMATION_REACTION_TASK_QUEUE =
  `task:${AUTOMATION_REACTION_TASK}`;

/**
 * New task handlers that can be enqueued before every old pod has drained need
 * their own queue lane. An old pod works the shared `task` lane and would
 * otherwise claim an unknown task name, consuming its genuine-failure budget
 * during a rolling deploy. Existing task names stay on the shared lane.
 */
export function taskQueueName(name: string): string {
  return name === AUTOMATION_REACTION_TASK
    ? AUTOMATION_REACTION_TASK_QUEUE
    : 'task';
}

export function isTransactionalTaskName(name: string): boolean {
  return (
    name === WORKSPACE_EVENT_ACTIVATION_TASK ||
    name === INTERACTIVE_EVENT_CARD_REFRESH_TASK ||
    name === AUTOMATION_REACTION_TASK
  );
}
