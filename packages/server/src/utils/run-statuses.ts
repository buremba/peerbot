import { pgTextArray } from '../db/client';

export const ACTIVE_RUN_STATUSES = ['pending', 'running', 'claimed'] as const;
export const EXECUTING_RUN_STATUSES = ['running', 'claimed'] as const;

type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];
type ExecutingRunStatus = (typeof EXECUTING_RUN_STATUSES)[number];

export function runStatusLiteral(
  statuses: readonly ActiveRunStatus[] | readonly ExecutingRunStatus[]
): string {
  return pgTextArray([...statuses]);
}

export function isExecutingRunStatus(status: unknown): status is ExecutingRunStatus {
  return (
    typeof status === 'string' && EXECUTING_RUN_STATUSES.includes(status as ExecutingRunStatus)
  );
}
