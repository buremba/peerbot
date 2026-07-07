import { describe, expect, it } from 'vitest';
import {
  normalizeXHandle,
  normalizeXIdentityValue,
  normalizeXUserId,
  X_IDENTITY,
  xIdentityModule,
} from '../x-identity.js';

describe('normalizeXUserId', () => {
  it('accepts digits and strips leading zeros', () => {
    expect(normalizeXUserId('82745')).toBe('82745');
    expect(normalizeXUserId('  00123  ')).toBe('123');
  });
  it('rejects non-numeric', () => {
    expect(normalizeXUserId('abc')).toBeNull();
    expect(normalizeXUserId('12.3')).toBeNull();
    expect(normalizeXUserId('')).toBeNull();
  });
});

describe('normalizeXHandle', () => {
  it('strips @, lowercases, validates 1-15 chars', () => {
    expect(normalizeXHandle('@Alice')).toBe('alice');
    expect(normalizeXHandle('  @Burak ')).toBe('burak');
  });
  it('rejects too-long or illegal handles', () => {
    expect(normalizeXHandle('a'.repeat(16))).toBeNull();
    expect(normalizeXHandle('has space')).toBeNull();
    expect(normalizeXHandle('')).toBeNull();
  });
});

describe('normalizeXIdentityValue', () => {
  it('dispatches the two X namespaces', () => {
    expect(normalizeXIdentityValue(X_IDENTITY.USER_ID, '00123')).toBe('123');
    expect(normalizeXIdentityValue(X_IDENTITY.HANDLE, '@Alice')).toBe('alice');
  });
  it('returns undefined ("not mine") for a non-X namespace', () => {
    expect(normalizeXIdentityValue('email', 'a@b.com')).toBeUndefined();
    expect(normalizeXIdentityValue('slack_user_id', 'T:U')).toBeUndefined();
  });
});

describe('xIdentityModule', () => {
  it('recall-indexes only the immutable user id', () => {
    expect(xIdentityModule.key).toBe('x');
    expect(xIdentityModule.recallNamespaces).toEqual([X_IDENTITY.USER_ID]);
    expect(xIdentityModule.recallNamespaces).not.toContain(X_IDENTITY.HANDLE);
  });
});
