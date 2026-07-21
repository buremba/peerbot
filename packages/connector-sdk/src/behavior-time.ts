export const BEHAVIOR_TIME_GRANULARITIES = ['daily', 'weekly', 'monthly', 'quarterly'] as const;

export type BehaviorTimeGranularity = (typeof BEHAVIOR_TIME_GRANULARITIES)[number];

const DATE_TRUNC_UNITS: Record<BehaviorTimeGranularity, 'day' | 'week' | 'month' | 'quarter'> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  quarterly: 'quarter',
};

export function isBehaviorTimeGranularity(value: unknown): value is BehaviorTimeGranularity {
  return (
    typeof value === 'string' && (BEHAVIOR_TIME_GRANULARITIES as readonly string[]).includes(value)
  );
}

export function inferBehaviorGranularityFromDays(daysDiff: number): BehaviorTimeGranularity {
  if (daysDiff <= 14) return 'daily';
  if (daysDiff <= 90) return 'weekly';
  if (daysDiff <= 365) return 'monthly';
  return 'quarterly';
}

export function inferBehaviorGranularityFromSchedule(
  schedule: string | null | undefined
): BehaviorTimeGranularity {
  if (!schedule) return 'weekly';

  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return 'weekly';

  const [, hour, dom, month, dow] = parts;

  if (month !== '*' && dom !== '*') return 'quarterly';
  if (dom !== '*' && month === '*') return 'monthly';
  if (dow !== '*' && dom === '*') return 'weekly';
  if (hour !== '*' && dom === '*') return 'daily';
  if (hour === '*' || hour.includes('/') || hour.includes(',')) return 'daily';

  return 'weekly';
}

export function getAvailableBehaviorGranularities(
  baseGranularity?: BehaviorTimeGranularity
): BehaviorTimeGranularity[] {
  if (!baseGranularity) return [...BEHAVIOR_TIME_GRANULARITIES];

  const baseIndex = BEHAVIOR_TIME_GRANULARITIES.indexOf(baseGranularity);
  return baseIndex === -1
    ? [...BEHAVIOR_TIME_GRANULARITIES]
    : [...BEHAVIOR_TIME_GRANULARITIES.slice(baseIndex)];
}

export function getFinerBehaviorGranularities(
  granularity: BehaviorTimeGranularity
): BehaviorTimeGranularity[] {
  const currentIndex = BEHAVIOR_TIME_GRANULARITIES.indexOf(granularity);
  return currentIndex <= 0 ? [] : [...BEHAVIOR_TIME_GRANULARITIES.slice(0, currentIndex)].reverse();
}

export function getNextBehaviorGranularity(
  granularity: BehaviorTimeGranularity
): BehaviorTimeGranularity | null {
  const currentIndex = BEHAVIOR_TIME_GRANULARITIES.indexOf(granularity);
  if (currentIndex === -1 || currentIndex === BEHAVIOR_TIME_GRANULARITIES.length - 1) {
    return null;
  }
  return BEHAVIOR_TIME_GRANULARITIES[currentIndex + 1];
}

export function getBehaviorDateTruncUnit(
  granularity: BehaviorTimeGranularity
): 'day' | 'week' | 'month' | 'quarter' {
  return DATE_TRUNC_UNITS[granularity];
}

export function shiftBehaviorPeriod(
  date: Date,
  granularity: BehaviorTimeGranularity,
  direction: 1 | -1
): Date {
  const result = new Date(date);

  switch (granularity) {
    case 'daily':
      result.setUTCDate(result.getUTCDate() + direction);
      break;
    case 'weekly':
      result.setUTCDate(result.getUTCDate() + 7 * direction);
      break;
    case 'monthly':
      result.setUTCMonth(result.getUTCMonth() + direction);
      break;
    case 'quarterly':
      result.setUTCMonth(result.getUTCMonth() + 3 * direction);
      break;
  }

  return result;
}

export function addBehaviorPeriod(date: Date, granularity: BehaviorTimeGranularity): Date {
  return shiftBehaviorPeriod(date, granularity, 1);
}

export function subtractBehaviorPeriod(date: Date, granularity: BehaviorTimeGranularity): Date {
  return shiftBehaviorPeriod(date, granularity, -1);
}

export function alignToBehaviorWindowStart(date: Date, granularity: BehaviorTimeGranularity): Date {
  const result = new Date(date);

  switch (granularity) {
    case 'daily':
      result.setUTCHours(0, 0, 0, 0);
      break;
    case 'weekly': {
      const dayOfWeek = result.getUTCDay();
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      result.setUTCDate(result.getUTCDate() - daysToMonday);
      result.setUTCHours(0, 0, 0, 0);
      break;
    }
    case 'monthly':
      result.setUTCDate(1);
      result.setUTCHours(0, 0, 0, 0);
      break;
    case 'quarterly': {
      const month = result.getUTCMonth();
      const quarterStart = Math.floor(month / 3) * 3;
      result.setUTCMonth(quarterStart, 1);
      result.setUTCHours(0, 0, 0, 0);
      break;
    }
  }

  return result;
}
