import { inferWatcherGranularityFromDays } from '@lobu/connector-sdk';

/**
 * Date Alias Parsing Utility
 *
 * Supports human-friendly date shortcuts:
 * - Named: 'today', 'yesterday', 'last_week', 'last_month'
 * - Relative: '7d', '30d', '90d', '1m', '3m', '6m', '1y'
 * - ISO 8601: '2025-01-01'
 */

interface ParsedDateAlias {
  date: Date;
  originalInput: string;
}

/**
 * Parse a date alias into a Date object
 * @param alias - The date alias string (e.g., 'yesterday', '7d', '2025-01-01')
 * @param referenceDate - Optional reference date (defaults to now)
 * @returns ParsedDateAlias object
 * @throws Error if the alias is invalid
 */
export function parseDateAlias(alias: string, referenceDate: Date = new Date()): ParsedDateAlias {
  const trimmed = alias.trim().toLowerCase();

  // Named aliases
  const namedAliases: Record<string, () => Date> = {
    today: () => {
      const d = new Date(referenceDate);
      d.setHours(0, 0, 0, 0);
      return d;
    },
    yesterday: () => {
      const d = new Date(referenceDate);
      d.setDate(d.getDate() - 1);
      d.setHours(0, 0, 0, 0);
      return d;
    },
    last_week: () => {
      const d = new Date(referenceDate);
      d.setDate(d.getDate() - 7);
      d.setHours(0, 0, 0, 0);
      return d;
    },
    last_month: () => {
      const d = new Date(referenceDate);
      d.setMonth(d.getMonth() - 1);
      d.setHours(0, 0, 0, 0);
      return d;
    },
  };

  if (namedAliases[trimmed]) {
    return {
      date: namedAliases[trimmed](),
      originalInput: alias,
    };
  }

  // Relative aliases (e.g., '7d', '30d', '1m', '1y')
  const relativeMatch = trimmed.match(/^(\d+)([dwmqy])$/);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const d = new Date(referenceDate);

    switch (unit) {
      case 'd': // days
        d.setDate(d.getDate() - value);
        break;
      case 'w': // weeks
        d.setDate(d.getDate() - value * 7);
        break;
      case 'm': // months
        d.setMonth(d.getMonth() - value);
        break;
      case 'q': // quarters
        d.setMonth(d.getMonth() - value * 3);
        break;
      case 'y': // years
        d.setFullYear(d.getFullYear() - value);
        break;
    }

    d.setHours(0, 0, 0, 0);
    return {
      date: d,
      originalInput: alias,
    };
  }

  // ISO 8601 format (YYYY-MM-DD)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ISO date: "${alias}"`);
    }
    // Normalize to start of day in local timezone (consistent with relative aliases)
    date.setHours(0, 0, 0, 0);
    return {
      date,
      originalInput: alias,
    };
  }

  // ISO 8601 with time (YYYY-MM-DDTHH:MM:SS or with timezone)
  const isoWithTimeMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}T/);
  if (isoWithTimeMatch) {
    const date = new Date(alias); // Use original casing for ISO parsing
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ISO datetime: "${alias}"`);
    }
    return {
      date,
      originalInput: alias,
    };
  }

  throw new Error(
    `Invalid date alias: "${alias}". ` +
      'Supported formats:\n' +
      '  - Named: today, yesterday, last_week, last_month\n' +
      '  - Relative: 7d, 30d, 90d, 1m, 3m, 6m, 1y (d=days, w=weeks, m=months, q=quarters, y=years)\n' +
      '  - ISO 8601: 2025-01-01 or 2025-01-01T12:00:00Z'
  );
}

/**
 * Calculate the difference in days between two dates
 * Used for granularity inference
 */
export function daysBetween(start: Date, end: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.abs(Math.floor((end.getTime() - start.getTime()) / msPerDay));
}

/**
 * Infer the best granularity based on a date range
 * @param daysDiff - Number of days in the range
 * @returns Suggested granularity
 */
export function inferGranularity(daysDiff: number): string {
  return inferWatcherGranularityFromDays(daysDiff);
}

/**
 * Format a date as ISO 8601 string (YYYY-MM-DD)
 */
export function formatDateISO(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Convert a date to end of day (23:59:59.999)
 * Used for "until" date filters to include the entire day
 */
export function toEndOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}
