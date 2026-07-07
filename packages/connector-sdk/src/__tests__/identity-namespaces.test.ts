import { describe, expect, it } from 'vitest';
import {
  EVENT_RECALL_IDENTITY_NAMESPACES,
  getIdentityNamespaceDefinition,
  IDENTITY,
  IDENTITY_NAMESPACE_REGISTRY,
  isEventRecallIdentityNamespace,
  normalizeIdentifier,
} from '../index';

describe('identity namespace registry (generic only)', () => {
  it('registers only the generic, provider-agnostic namespaces', () => {
    const namespaces = IDENTITY_NAMESPACE_REGISTRY.map((def) => def.namespace).sort();
    expect(namespaces).toEqual(
      ['auth_user_id', 'email', 'email_domain', 'phone'].sort()
    );
  });

  it('does NOT contain any connector-specific namespace', () => {
    const namespaces = new Set(IDENTITY_NAMESPACE_REGISTRY.map((def) => def.namespace));
    for (const connectorNs of [
      'slack_user_id',
      'slack_channel_id',
      'github_login',
      'github_user_id',
      'x_user_id',
      'x_handle',
      'wa_jid',
      'google_contact_id',
    ]) {
      expect(namespaces.has(connectorNs)).toBe(false);
      expect(getIdentityNamespaceDefinition(connectorNs)).toBeUndefined();
    }
  });

  it('exposes the generic event-recall namespaces (email, phone, auth_user_id)', () => {
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).toContain(IDENTITY.EMAIL);
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).toContain(IDENTITY.PHONE);
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).toContain(IDENTITY.AUTH_USER_ID);
    // email_domain is a derivation key, never a recall key.
    expect(EVENT_RECALL_IDENTITY_NAMESPACES).not.toContain(IDENTITY.EMAIL_DOMAIN);
  });

  it('keeps registry namespaces unique', () => {
    const namespaces = IDENTITY_NAMESPACE_REGISTRY.map((def) => def.namespace);
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  it('registers email_domain as a derived, non-recall, non-unique person namespace', () => {
    expect(getIdentityNamespaceDefinition(IDENTITY.EMAIL_DOMAIN)).toMatchObject({
      subjectKind: 'person',
      normalizer: 'email_domain',
      eventRecallIndexed: false,
      uniquePerOrg: false,
    });
    expect(isEventRecallIdentityNamespace(IDENTITY.EMAIL_DOMAIN)).toBe(false);
  });

  it('normalizes email_domain from a full email or a bare domain, rejecting junk', () => {
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, 'Alice@Anthropic.com')).toBe(
      'anthropic.com'
    );
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, '  dev@ACME.CO.UK  ')).toBe(
      'acme.co.uk'
    );
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, 'Example.COM')).toBe('example.com');
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, 'notadomain')).toBeNull();
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, 'a@b@c.com')).toBeNull();
    expect(normalizeIdentifier(IDENTITY.EMAIL_DOMAIN, '')).toBeNull();
  });

  it('falls back to trim for an unregistered (connector-owned) namespace', () => {
    // A connector namespace the SDK no longer knows about gets basic hygiene,
    // not a crash — the connector module does the real normalization upstream.
    expect(normalizeIdentifier('x_user_id', '  001234  ')).toBe('001234');
  });
});
