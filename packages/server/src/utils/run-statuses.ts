import { pgTextArray } from '../db/client';

export const ACTIVE_RUN_STATUSES = ['pending', 'running', 'claimed'] as const;
export const EXECUTING_RUN_STATUSES = ['running', 'claimed'] as const;

/** Run lanes that can hold `approval_status='pending'` (undecided approvals). */
export const APPROVAL_RUN_TYPES = ['action', 'internal'] as const;

type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];
type ExecutingRunStatus = (typeof EXECUTING_RUN_STATUSES)[number];

/**
 * Can a `runs` row in this status still be written under, or consumed?
 *
 * The JS-side companion to {@link runStatusLiteral}: the same list, so a
 * predicate evaluated in the app and one evaluated in SQL cannot disagree
 * about what "active" means.
 */
export function isActiveRunStatus(status: string | null | undefined): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status ?? '');
}

export function runStatusLiteral(
  statuses: readonly ActiveRunStatus[] | readonly ExecutingRunStatus[]
): string {
  return pgTextArray([...statuses]);
}

