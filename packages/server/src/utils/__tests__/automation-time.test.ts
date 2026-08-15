import {
  addAutomationPeriod,
  alignToAutomationWindowStart,
  getAvailableAutomationGranularities,
  getFinerAutomationGranularities,
  getNextAutomationGranularity,
  getAutomationDateTruncUnit,
  inferAutomationGranularityFromDays,
  inferAutomationGranularityFromSchedule,
  subtractAutomationPeriod,
} from '@lobu/connector-sdk';
import { describe, expect, it } from 'vitest';

describe('automation time helpers', () => {
  it('infers an automation granularity from cron schedule', () => {
    expect(inferAutomationGranularityFromSchedule('0 * * * *')).toBe('daily');
    expect(inferAutomationGranularityFromSchedule('0 9 * * 1')).toBe('weekly');
    expect(inferAutomationGranularityFromSchedule('0 9 1 * *')).toBe('monthly');
    expect(inferAutomationGranularityFromSchedule('0 9 1 1,4,7,10 *')).toBe('quarterly');
    expect(inferAutomationGranularityFromSchedule(null)).toBe('weekly');
  });

  it('infers an automation granularity from date-range size', () => {
    expect(inferAutomationGranularityFromDays(7)).toBe('daily');
    expect(inferAutomationGranularityFromDays(30)).toBe('weekly');
    expect(inferAutomationGranularityFromDays(180)).toBe('monthly');
    expect(inferAutomationGranularityFromDays(500)).toBe('quarterly');
  });

  it('returns available and fallback granularities in hierarchy order', () => {
    expect(getAvailableAutomationGranularities('weekly')).toEqual(['weekly', 'monthly', 'quarterly']);
    expect(getFinerAutomationGranularities('quarterly')).toEqual(['monthly', 'weekly', 'daily']);
    expect(getFinerAutomationGranularities('daily')).toEqual([]);
    expect(getNextAutomationGranularity('monthly')).toBe('quarterly');
    expect(getNextAutomationGranularity('quarterly')).toBeNull();
  });

  it('maps automation granularity to date_trunc units', () => {
    expect(getAutomationDateTruncUnit('daily')).toBe('day');
    expect(getAutomationDateTruncUnit('weekly')).toBe('week');
    expect(getAutomationDateTruncUnit('monthly')).toBe('month');
    expect(getAutomationDateTruncUnit('quarterly')).toBe('quarter');
  });

  it('aligns dates to automation window boundaries', () => {
    const sample = new Date('2026-03-18T15:42:21Z');

    expect(alignToAutomationWindowStart(sample, 'daily').toISOString()).toBe(
      '2026-03-18T00:00:00.000Z'
    );
    expect(alignToAutomationWindowStart(sample, 'weekly').toISOString()).toBe(
      '2026-03-16T00:00:00.000Z'
    );
    expect(alignToAutomationWindowStart(sample, 'monthly').toISOString()).toBe(
      '2026-03-01T00:00:00.000Z'
    );
    expect(alignToAutomationWindowStart(sample, 'quarterly').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('moves dates by complete automation periods', () => {
    const sample = new Date('2026-03-18T15:42:21Z');

    expect(addAutomationPeriod(sample, 'daily').toISOString()).toBe('2026-03-19T15:42:21.000Z');
    expect(addAutomationPeriod(sample, 'weekly').toISOString()).toBe('2026-03-25T15:42:21.000Z');
    expect(addAutomationPeriod(sample, 'monthly').toISOString()).toBe('2026-04-18T15:42:21.000Z');
    expect(addAutomationPeriod(sample, 'quarterly').toISOString()).toBe('2026-06-18T15:42:21.000Z');
    expect(subtractAutomationPeriod(sample, 'weekly').toISOString()).toBe('2026-03-11T15:42:21.000Z');
  });
});
