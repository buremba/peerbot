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

  it('registers email_domain as a derived, non-recall, non-unique person namespace', () => {
    expect(getIdentityNamespaceDefinition(IDENTITY.EMAIL_DOMAIN)).toMatchObject({
      subjectKind: 'person',
      normalizer: 'email_domain',
      eventRecallIndexed: false,
      uniquePerOrg: false,
    });
    // Not a recall key — it exists only to power domain-keyed derivation rules.
    expect(isEventRecallIdentityNamespace(IDENTITY.EMAIL_DOMAIN)).toBe(false);
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).not.toContain(IDENTITY.EMAIL_DOMAIN);
  });

  it('normalizes email_domain from a full email or a bare domain, rejecting junk', () => {
    // Full email → lowercased domain part.
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, 'Alice@Anthropic.com')).toBe(
      'anthropic.com'
    );
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, '  dev@ACME.CO.UK  ')).toBe(
      'acme.co.uk'
    );
    // Bare domain passes through normalized.
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, 'Example.COM')).toBe(
      'example.com'
    );
    // Junk → null (no dot, empty, malformed).
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, 'notadomain')).toBeNull();
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, 'a@b@c.com')).toBeNull();
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, '')).toBeNull();
  });
});
