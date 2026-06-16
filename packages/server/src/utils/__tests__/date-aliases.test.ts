/**
 * Date Alias Parsing Tests
 */

import { describe, expect, it } from 'vitest';
import { formatDateISO, parseDateAlias, toEndOfDay } from '../date-aliases';

describe('parseDateAlias', () => {
  const ref = new Date('2025-06-15T12:00:00Z');

  describe('named aliases', () => {
    it('should parse "today"', () => {
      const result = parseDateAlias('today', ref);
      expect(result.date.getHours()).toBe(0);
      expect(result.date.getMinutes()).toBe(0);
      expect(result.date.getDate()).toBe(ref.getDate());
    });

    it('should parse "yesterday"', () => {
      const result = parseDateAlias('yesterday', ref);
      expect(result.date.getDate()).toBe(ref.getDate() - 1);
    });

    it('should parse "last_week"', () => {
      const result = parseDateAlias('last_week', ref);
      const expected = new Date(ref);
      expected.setDate(expected.getDate() - 7);
      expect(result.date.getDate()).toBe(expected.getDate());
    });

    it('should parse "last_month"', () => {
      const result = parseDateAlias('last_month', ref);
      const expected = new Date(ref);
      expected.setMonth(expected.getMonth() - 1);
      expect(result.date.getMonth()).toBe(expected.getMonth());
    });
  });

  describe('relative aliases', () => {
    it('should parse "7d"', () => {
      const result = parseDateAlias('7d', ref);
      const expected = new Date(ref);
      expected.setDate(expected.getDate() - 7);
      expect(result.date.getDate()).toBe(expected.getDate());
    });

    it('should parse "30d"', () => {
      const result = parseDateAlias('30d', ref);
      const diff = Math.abs(ref.getTime() - result.date.getTime());
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      expect(days).toBe(30);
    });

    it('should parse "1m"', () => {
      const result = parseDateAlias('1m', ref);
      const expected = new Date(ref);
      expected.setMonth(expected.getMonth() - 1);
      expect(result.date.getMonth()).toBe(expected.getMonth());
    });

    it('should parse "1q"', () => {
      const result = parseDateAlias('1q', ref);
      const expected = new Date(ref);
      expected.setMonth(expected.getMonth() - 3);
      expect(result.date.getMonth()).toBe(expected.getMonth());
    });

    it('should parse "1y"', () => {
      const result = parseDateAlias('1y', ref);
      expect(result.date.getFullYear()).toBe(ref.getFullYear() - 1);
    });

    it('should parse "2w" (weeks)', () => {
      const result = parseDateAlias('2w', ref);
      const diff = Math.abs(ref.getTime() - result.date.getTime());
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      expect(days).toBe(14);
    });
  });

  describe('ISO dates', () => {
    it('should parse ISO date string', () => {
      const result = parseDateAlias('2025-01-15', ref);
      expect(result.date.getFullYear()).toBe(2025);
      expect(result.date.getMonth()).toBe(0);
      expect(result.date.getDate()).toBe(15);
    });

    it('should parse ISO datetime string', () => {
      const result = parseDateAlias('2025-01-15T12:30:00Z', ref);
      expect(result.date.toISOString()).toBe('2025-01-15T12:30:00.000Z');
    });

    it('should parse quoted ISO datetime string', () => {
      const result = parseDateAlias('"2025-01-15T12:30:00Z"', ref);
      expect(result.date.toISOString()).toBe('2025-01-15T12:30:00.000Z');
    });
  });

  describe('invalid inputs', () => {
    it('should throw for invalid alias', () => {
      expect(() => parseDateAlias('foobar', ref)).toThrow('Invalid date alias');
    });

    it('should throw for invalid ISO date', () => {
      expect(() => parseDateAlias('2025-99-99', ref)).toThrow();
    });
  });
});

describe('formatDateISO', () => {
  it('should format date as YYYY-MM-DD', () => {
    const d = new Date('2025-06-15T12:30:00Z');
    expect(formatDateISO(d)).toBe('2025-06-15');
  });
});

describe('toEndOfDay', () => {
  it('should set time to 23:59:59.999', () => {
    const d = new Date('2025-06-15T08:00:00Z');
    const eod = toEndOfDay(d);
    expect(eod.getHours()).toBe(23);
    expect(eod.getMinutes()).toBe(59);
    expect(eod.getSeconds()).toBe(59);
    expect(eod.getMilliseconds()).toBe(999);
  });

  it('should not modify the original date', () => {
    const d = new Date('2025-06-15T08:00:00Z');
    const origTime = d.getTime();
    toEndOfDay(d);
    expect(d.getTime()).toBe(origTime);
  });
});
