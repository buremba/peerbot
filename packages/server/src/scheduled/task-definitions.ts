/**
 * Durable tasks that may be inserted inside an existing domain transaction.
 *
 * Keeping this manifest separate from the scheduler instance lets domain
 * writers commit their row and handoff atomically without accepting arbitrary
 * task names. Boot registration and enqueue sites import the same definition,
 * so adding another transactional task is an explicit platform change.
 */
export const WORKSPACE_EVENT_ACTIVATION_TASK = {
  name: 'activate-workspace-event',
} as const;

export const TRANSACTIONAL_TASK_DEFINITIONS = [
  WORKSPACE_EVENT_ACTIVATION_TASK,
] as const;

const transactionalTaskNames = new Set<string>(
  TRANSACTIONAL_TASK_DEFINITIONS.map((definition) => definition.name)
);

export function isTransactionalTaskName(name: string): boolean {
  return transactionalTaskNames.has(name);
}
