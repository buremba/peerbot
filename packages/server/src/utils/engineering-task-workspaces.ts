/**
 * Staged activation gate for engineering-task workspace execution.
 *
 * Keep this off while an older server replica can still dispatch task runs
 * without the entity envelope. Activate only after the server fleet and target
 * device daemons all support `automations.workspace.v1`.
 */
export function engineeringTaskWorkspacesEnabled(): boolean {
  return process.env.LOBU_ENGINEERING_TASK_WORKSPACES === '1';
}
