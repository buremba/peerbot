import { describe, expect, test } from 'bun:test';
import { normalizeIdentifier, normalizeXHandle } from '../identity-normalize.js';

describe('normalizeXHandle', () => {
  test('lowercases and strips @', () => {
    expect(normalizeXHandle('@Buremba')).toBe('buremba');
    expect(normalizeXHandle('alice')).toBe('alice');
  });

  test('rejects invalid handles', () => {
    expect(normalizeXHandle('')).toBeNull();
    expect(normalizeXHandle('way-too-long-handle-name')).toBeNull();
    expect(normalizeXHandle('bad-handle')).toBeNull();
  });
});

describe('normalizeIdentifier x namespaces', () => {
  test('routes x_handle and x_user_id', () => {
    expect(normalizeIdentifier('x_handle', '@Alice')).toBe('alice');
    expect(normalizeIdentifier('x_user_id', '0002244994945')).toBe('2244994945');
  });
});