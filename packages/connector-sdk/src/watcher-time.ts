export const WATCHER_TIME_GRANULARITIES = ['daily', 'weekly', 'monthly', 'quarterly'] as const;

export type WatcherTimeGranularity = (typeof WATCHER_TIME_GRANULARITIES)[number];

const DATE_TRUNC_UNITS: Record<WatcherTimeGranularity, 'day' | 'week' | 'month' | 'quarter'> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  quarterly: 'quarter',
};

export function isWatcherTimeGranularity(value: unknown): value is WatcherTimeGranularity {
  return (
    typeof value === 'string' && (WATCHER_TIME_GRANULARITIES as readonly string[]).includes(value)
  );
}

export function inferWatcherGranularityFromDays(daysDiff: number): WatcherTimeGranularity {
  if (daysDiff <= 14) return 'daily';
  if (daysDiff <= 90) return 'weekly';
  if (daysDiff <= 365) return 'monthly';
  return 'quarterly';
}

export function inferWatcherGranularityFromSchedule(
  schedule: string | null | undefined
): WatcherTimeGranularity {
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

export function getAvailableWatcherGranularities(
  baseGranularity?: WatcherTimeGranularity
): WatcherTimeGranularity[] {
  if (!baseGranularity) return [...WATCHER_TIME_GRANULARITIES];

  const baseIndex = WATCHER_TIME_GRANULARITIES.indexOf(baseGranularity);
  return baseIndex === -1
    ? [...WATCHER_TIME_GRANULARITIES]
    : [...WATCHER_TIME_GRANULARITIES.slice(baseIndex)];
}

export function getFinerWatcherGranularities(
  granularity: WatcherTimeGranularity
): WatcherTimeGranularity[] {
  const currentIndex = WATCHER_TIME_GRANULARITIES.indexOf(granularity);
  return currentIndex <= 0 ? [] : [...WATCHER_TIME_GRANULARITIES.slice(0, currentIndex)].reverse();
}

export function getNextWatcherGranularity(
  granularity: WatcherTimeGranularity
): WatcherTimeGranularity | null {
  const currentIndex = WATCHER_TIME_GRANULARITIES.indexOf(granularity);
  if (currentIndex === -1 || currentIndex === WATCHER_TIME_GRANULARITIES.length - 1) {
    return null;
  }
  return WATCHER_TIME_GRANULARITIES[currentIndex + 1];
}

export function getWatcherDateTruncUnit(
  granularity: WatcherTimeGranularity
): 'day' | 'week' | 'month' | 'quarter' {
  return DATE_TRUNC_UNITS[granularity];
}

export function shiftWatcherPeriod(
  date: Date,
  granularity: WatcherTimeGranularity,
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

export function addWatcherPeriod(date: Date, granularity: WatcherTimeGranularity): Date {
  return shiftWatcherPeriod(date, granularity, 1);
}

export function subtractWatcherPeriod(date: Date, granularity: WatcherTimeGranularity): Date {
  return shiftWatcherPeriod(date, granularity, -1);
}

export function alignToWatcherWindowStart(date: Date, granularity: WatcherTimeGranularity): Date {
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
