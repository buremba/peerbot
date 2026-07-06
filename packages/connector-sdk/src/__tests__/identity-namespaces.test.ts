import { describe, expect, it } from 'vitest';
import {
  EVENT_RECALL_IDENTITY_NAMESPACES,
  getIdentityNamespaceDefinition,
  IDENTITY,
  IDENTITY_NAMESPACE_REGISTRY,
  isEventRecallIdentityNamespace,
  normalizeIdentifier,
} from '../index';

describe('identity namespace registry', () => {
  it('is the canonical source for event-recall namespaces including X immutable ids', () => {
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).toContain(IDENTITY.EMAIL);
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).toContain(IDENTITY.SLACK_USER_ID);
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).toContain(IDENTITY.GITHUB_USER_ID);
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).toContain(IDENTITY.X_USER_ID);
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).not.toContain(IDENTITY.X_HANDLE);
  });

  it('keeps registry namespaces unique', () => {
    const namespaces = IDENTITY_NAMESPACE_REGISTRY.map((def) => def.namespace);
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  it('documents X id as searchable and handle as mutable/non-searchable', () => {
    expect(getIdentityNamespaceDefinition(IDENTITY.X_USER_ID)).toMatchObject({
      normalizer: 'numeric_id',
      eventRecallIndexed: true,
      uniquePerOrg: true,
    });
    expect(getIdentityNamespaceDefinition(IDENTITY.X_HANDLE)).toMatchObject({
      normalizer: 'x_handle',
      eventRecallIndexed: false,
      uniquePerOrg: false,
    });
    expect(isEventRecallIdentityNamespace(IDENTITY.X_USER_ID)).toBe(true);
    expect(isEventRecallIdentityNamespace(IDENTITY.X_HANDLE)).toBe(false);
  });

  it('normalizes newly registered X namespaces while existing legacy namespaces remain trim-only', () => {
    expect(normalizeIdentifier(IDENTITY.X_USER_ID, '001234')).toBe('1234');
    expect(normalizeIdentifier(IDENTITY.X_HANDLE, ' @Burak ')).toBe('burak');
    expect(normalizeIdentifier(IDENTITY.GITHUB_LOGIN, ' Lobu-AI ')).toBe('Lobu-AI');
    expect(normalizeIdentifier(IDENTITY.SLACK_USER_ID, 't1:u2')).toBe('t1:u2');
  });
});
