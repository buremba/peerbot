/**
 * Unit coverage for connection facet derivation (the chips on the connectors
 * index, the connection page, and the group cards). Facets are DERIVED, never
 * stored, so this pins the truth table: a Slack chat connection lights all
 * four roles, a pure data connector lights only data, the audience facet keys
 * off the ACL source registry, and the credential-mode badge falls back from
 * the explicit chat marker to the auth-profile shape.
 */

import { describe, expect, it } from 'bun:test';
import {
  deriveConnectionFacets,
  deriveEffectiveCredentialMode,
} from '../../../tools/admin/manage_connections/handlers/facets';

describe('deriveConnectionFacets', () => {
  it('a managed Slack chat connection lights all four facets', () => {
    expect(
      deriveConnectionFacets({
        connectorKey: 'slack',
        isChat: true,
        feedCount: 3,
        connectorHasFeeds: true,
        hasOperations: true,
      }),
    ).toEqual({ data: true, chat: true, actions: true, audience: true });
  });

  it('a pure data connector (no chat, no ops, not ACL) lights only data', () => {
    expect(
      deriveConnectionFacets({
        connectorKey: 'revolut',
        isChat: false,
        feedCount: 0,
        connectorHasFeeds: true,
        hasOperations: false,
      }),
    ).toEqual({ data: true, chat: false, actions: false, audience: false });
  });

  it('data lights from live feeds even when the connector declares none', () => {
    const f = deriveConnectionFacets({
      connectorKey: 'webhook',
      isChat: false,
      feedCount: 2,
      connectorHasFeeds: false,
      hasOperations: false,
    });
    expect(f.data).toBe(true);
  });

  it('GitHub lights data + actions + audience but not chat', () => {
    expect(
      deriveConnectionFacets({
        connectorKey: 'github',
        isChat: false,
        feedCount: 1,
        connectorHasFeeds: true,
        hasOperations: true,
      }),
    ).toEqual({ data: true, chat: false, actions: true, audience: true });
  });

  it('audience only lights for connectors in the ACL source registry', () => {
    expect(
      deriveConnectionFacets({
        connectorKey: 'telegram',
        isChat: true,
        feedCount: 0,
        connectorHasFeeds: false,
        hasOperations: false,
      }),
    ).toEqual({ data: false, chat: true, actions: false, audience: false });
  });
});

describe('deriveEffectiveCredentialMode', () => {
  it('chat connections use their explicit credential_mode', () => {
    expect(
      deriveEffectiveCredentialMode({
        credentialMode: 'managed',
        appAuthProfileId: null,
        authProfileId: null,
      }),
    ).toBe('managed');
    expect(
      deriveEffectiveCredentialMode({
        credentialMode: 'byo',
        appAuthProfileId: 7,
        authProfileId: null,
      }),
    ).toBe('byo');
  });

  it('a data connector with an app-install auth profile is managed', () => {
    expect(
      deriveEffectiveCredentialMode({
        credentialMode: null,
        appAuthProfileId: 42,
        authProfileId: 9,
      }),
    ).toBe('managed');
  });

  it('a data connector with only a byo auth profile is byo', () => {
    expect(
      deriveEffectiveCredentialMode({
        credentialMode: null,
        appAuthProfileId: null,
        authProfileId: 9,
      }),
    ).toBe('byo');
  });

  it('a connection with no auth concept has no badge', () => {
    expect(
      deriveEffectiveCredentialMode({
        credentialMode: null,
        appAuthProfileId: null,
        authProfileId: null,
      }),
    ).toBeNull();
  });
});
