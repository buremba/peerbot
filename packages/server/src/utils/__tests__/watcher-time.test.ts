import {
  addWatcherPeriod,
  alignToWatcherWindowStart,
  getAvailableWatcherGranularities,
  getFinerWatcherGranularities,
  getNextWatcherGranularity,
  getWatcherDateTruncUnit,
  inferWatcherGranularityFromDays,
  inferWatcherGranularityFromSchedule,
  subtractWatcherPeriod,
} from '@lobu/connector-sdk';
import { describe, expect, it } from 'vitest';

describe('watcher time helpers', () => {
  it('infers a watcher granularity from cron schedule', () => {
    expect(inferWatcherGranularityFromSchedule('0 * * * *')).toBe('daily');
    expect(inferWatcherGranularityFromSchedule('0 9 * * 1')).toBe('weekly');
    expect(inferWatcherGranularityFromSchedule('0 9 1 * *')).toBe('monthly');
    expect(inferWatcherGranularityFromSchedule('0 9 1 1,4,7,10 *')).toBe('quarterly');
    expect(inferWatcherGranularityFromSchedule(null)).toBe('weekly');
  });

  it('infers a watcher granularity from date-range size', () => {
    expect(inferWatcherGranularityFromDays(7)).toBe('daily');
    expect(inferWatcherGranularityFromDays(30)).toBe('weekly');
    expect(inferWatcherGranularityFromDays(180)).toBe('monthly');
    expect(inferWatcherGranularityFromDays(500)).toBe('quarterly');
  });

  it('returns available and fallback granularities in hierarchy order', () => {
    expect(getAvailableWatcherGranularities('weekly')).toEqual(['weekly', 'monthly', 'quarterly']);
    expect(getFinerWatcherGranularities('quarterly')).toEqual(['monthly', 'weekly', 'daily']);
    expect(getFinerWatcherGranularities('daily')).toEqual([]);
    expect(getNextWatcherGranularity('monthly')).toBe('quarterly');
    expect(getNextWatcherGranularity('quarterly')).toBeNull();
  });

  it('maps watcher granularity to date_trunc units', () => {
    expect(getWatcherDateTruncUnit('daily')).toBe('day');
    expect(getWatcherDateTruncUnit('weekly')).toBe('week');
    expect(getWatcherDateTruncUnit('monthly')).toBe('month');
    expect(getWatcherDateTruncUnit('quarterly')).toBe('quarter');
  });

  it('aligns dates to watcher window boundaries', () => {
    const sample = new Date('2026-03-18T15:42:21Z');

    expect(alignToWatcherWindowStart(sample, 'daily').toISOString()).toBe(
      '2026-03-18T00:00:00.000Z'
    );
    expect(alignToWatcherWindowStart(sample, 'weekly').toISOString()).toBe(
      '2026-03-16T00:00:00.000Z'
    );
    expect(alignToWatcherWindowStart(sample, 'monthly').toISOString()).toBe(
      '2026-03-01T00:00:00.000Z'
    );
    expect(alignToWatcherWindowStart(sample, 'quarterly').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('moves dates by complete watcher periods', () => {
    const sample = new Date('2026-03-18T15:42:21Z');

    expect(addWatcherPeriod(sample, 'daily').toISOString()).toBe('2026-03-19T15:42:21.000Z');
    expect(addWatcherPeriod(sample, 'weekly').toISOString()).toBe('2026-03-25T15:42:21.000Z');
    expect(addWatcherPeriod(sample, 'monthly').toISOString()).toBe('2026-04-18T15:42:21.000Z');
    expect(addWatcherPeriod(sample, 'quarterly').toISOString()).toBe('2026-06-18T15:42:21.000Z');
    expect(subtractWatcherPeriod(sample, 'weekly').toISOString()).toBe('2026-03-11T15:42:21.000Z');
  });
});
