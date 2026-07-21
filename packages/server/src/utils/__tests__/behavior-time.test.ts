import {
  addBehaviorPeriod,
  alignToBehaviorWindowStart,
  getAvailableBehaviorGranularities,
  getFinerBehaviorGranularities,
  getNextBehaviorGranularity,
  getBehaviorDateTruncUnit,
  inferBehaviorGranularityFromDays,
  inferBehaviorGranularityFromSchedule,
  subtractBehaviorPeriod,
} from '@lobu/connector-sdk';
import { describe, expect, it } from 'vitest';

describe('behavior time helpers', () => {
  it('infers a behavior granularity from cron schedule', () => {
    expect(inferBehaviorGranularityFromSchedule('0 * * * *')).toBe('daily');
    expect(inferBehaviorGranularityFromSchedule('0 9 * * 1')).toBe('weekly');
    expect(inferBehaviorGranularityFromSchedule('0 9 1 * *')).toBe('monthly');
    expect(inferBehaviorGranularityFromSchedule('0 9 1 1,4,7,10 *')).toBe('quarterly');
    expect(inferBehaviorGranularityFromSchedule(null)).toBe('weekly');
  });

  it('infers a behavior granularity from date-range size', () => {
    expect(inferBehaviorGranularityFromDays(7)).toBe('daily');
    expect(inferBehaviorGranularityFromDays(30)).toBe('weekly');
    expect(inferBehaviorGranularityFromDays(180)).toBe('monthly');
    expect(inferBehaviorGranularityFromDays(500)).toBe('quarterly');
  });

  it('returns available and fallback granularities in hierarchy order', () => {
    expect(getAvailableBehaviorGranularities('weekly')).toEqual(['weekly', 'monthly', 'quarterly']);
    expect(getFinerBehaviorGranularities('quarterly')).toEqual(['monthly', 'weekly', 'daily']);
    expect(getFinerBehaviorGranularities('daily')).toEqual([]);
    expect(getNextBehaviorGranularity('monthly')).toBe('quarterly');
    expect(getNextBehaviorGranularity('quarterly')).toBeNull();
  });

  it('maps behavior granularity to date_trunc units', () => {
    expect(getBehaviorDateTruncUnit('daily')).toBe('day');
    expect(getBehaviorDateTruncUnit('weekly')).toBe('week');
    expect(getBehaviorDateTruncUnit('monthly')).toBe('month');
    expect(getBehaviorDateTruncUnit('quarterly')).toBe('quarter');
  });

  it('aligns dates to behavior window boundaries', () => {
    const sample = new Date('2026-03-18T15:42:21Z');

    expect(alignToBehaviorWindowStart(sample, 'daily').toISOString()).toBe(
      '2026-03-18T00:00:00.000Z'
    );
    expect(alignToBehaviorWindowStart(sample, 'weekly').toISOString()).toBe(
      '2026-03-16T00:00:00.000Z'
    );
    expect(alignToBehaviorWindowStart(sample, 'monthly').toISOString()).toBe(
      '2026-03-01T00:00:00.000Z'
    );
    expect(alignToBehaviorWindowStart(sample, 'quarterly').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('moves dates by complete behavior periods', () => {
    const sample = new Date('2026-03-18T15:42:21Z');

    expect(addBehaviorPeriod(sample, 'daily').toISOString()).toBe('2026-03-19T15:42:21.000Z');
    expect(addBehaviorPeriod(sample, 'weekly').toISOString()).toBe('2026-03-25T15:42:21.000Z');
    expect(addBehaviorPeriod(sample, 'monthly').toISOString()).toBe('2026-04-18T15:42:21.000Z');
    expect(addBehaviorPeriod(sample, 'quarterly').toISOString()).toBe('2026-06-18T15:42:21.000Z');
    expect(subtractBehaviorPeriod(sample, 'weekly').toISOString()).toBe('2026-03-11T15:42:21.000Z');
  });
});
