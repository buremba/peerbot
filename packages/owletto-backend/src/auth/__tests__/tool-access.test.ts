/**
 * Tool Access Tests
 *
 * Tests for requiresOwnerAdmin and isPublicReadable authorization checks.
 */

import { describe, expect, it } from 'vitest';
import { type AuthContext, checkToolAccess } from '../../tools/execute';
import {
  getRequiredAccessLevel,
  isPublicReadable,
  requiresMemberWrite,
  requiresOwnerAdmin,
} from '../tool-access';

describe('requiresOwnerAdmin', () => {
  it('should require admin for query_sql despite being read-only', () => {
    expect(requiresOwnerAdmin('query_sql', {}, true)).toBe(true);
  });

  it('should require admin for destructive manage_entity actions only', () => {
    expect(requiresOwnerAdmin('manage_entity', { action: 'create' }, false)).toBe(false);
    expect(requiresOwnerAdmin('manage_entity', { action: 'update' }, false)).toBe(false);
    expect(requiresOwnerAdmin('manage_entity', { action: 'delete' }, false)).toBe(true);
  });

  it('should not require admin for read-only manage_entity actions', () => {
    expect(requiresOwnerAdmin('manage_entity', { action: 'list' }, true)).toBe(false);
    expect(requiresOwnerAdmin('manage_entity', { action: 'get' }, true)).toBe(false);
  });

  it('should require admin for manage_classifiers mutating actions', () => {
    expect(requiresOwnerAdmin('manage_classifiers', { action: 'create' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_classifiers', { action: 'classify' }, false)).toBe(true);
  });

  it('should require admin for manage_operations execute', () => {
    expect(requiresOwnerAdmin('manage_operations', { action: 'execute' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_operations', { action: 'approve' }, false)).toBe(true);
  });

  it('should require admin for manage_connections login and connector mutations', () => {
    expect(
      requiresOwnerAdmin('manage_connections', { action: 'toggle_connector_login' }, false)
    ).toBe(true);
    expect(
      requiresOwnerAdmin('manage_connections', { action: 'update_connector_auth' }, false)
    ).toBe(true);
  });

  it('should require admin for manage_auth_profiles mutations', () => {
    expect(
      requiresOwnerAdmin('manage_auth_profiles', { action: 'create_auth_profile' }, false)
    ).toBe(true);
    expect(
      requiresOwnerAdmin('manage_auth_profiles', { action: 'delete_auth_profile' }, false)
    ).toBe(true);
  });

  it('should require admin for manage_feeds mutations', () => {
    expect(requiresOwnerAdmin('manage_feeds', { action: 'create_feed' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_feeds', { action: 'trigger_feed' }, false)).toBe(true);
  });

  it('should require admin for manage_watchers mutating actions', () => {
    expect(requiresOwnerAdmin('manage_watchers', { action: 'create' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_watchers', { action: 'create_version' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_watchers', { action: 'set_reaction_script' }, false)).toBe(
      true
    );
  });

  it('should not require admin for manage_watchers read actions', () => {
    expect(requiresOwnerAdmin('manage_watchers', { action: 'get_versions' }, false)).toBe(false);
    expect(requiresOwnerAdmin('manage_watchers', { action: 'get_version_details' }, false)).toBe(
      false
    );
    expect(
      requiresOwnerAdmin('manage_watchers', { action: 'get_component_reference' }, false)
    ).toBe(false);
  });
});

describe('member write access', () => {
  it('should allow members to save knowledge', () => {
    expect(requiresMemberWrite('save_knowledge', {}, false)).toBe(true);
    expect(getRequiredAccessLevel('save_knowledge', {}, false)).toBe('write');
  });

  it('should allow members to create and update entities without admin role', () => {
    expect(requiresMemberWrite('manage_entity', { action: 'create' }, false)).toBe(true);
    expect(requiresMemberWrite('manage_entity', { action: 'update' }, false)).toBe(true);
    expect(requiresMemberWrite('manage_entity', { action: 'link' }, false)).toBe(true);
    expect(getRequiredAccessLevel('manage_entity', { action: 'create' }, false)).toBe('write');
  });

  it('should keep entity deletion as admin-only', () => {
    expect(requiresMemberWrite('manage_entity', { action: 'delete' }, false)).toBe(false);
    expect(getRequiredAccessLevel('manage_entity', { action: 'delete' }, false)).toBe('admin');
  });
});

describe('isPublicReadable', () => {
  it('should allow public read for resolve_path', () => {
    expect(isPublicReadable('resolve_path', {})).toBe(true);
  });

  it('should allow public read for search_knowledge', () => {
    expect(isPublicReadable('search_knowledge', {})).toBe(true);
  });

  it('should allow public read for read_knowledge', () => {
    expect(isPublicReadable('read_knowledge', {})).toBe(true);
  });

  it('should allow public read for get_watcher', () => {
    expect(isPublicReadable('get_watcher', {})).toBe(true);
  });

  it('should allow public read for list_watchers', () => {
    expect(isPublicReadable('list_watchers', {})).toBe(true);
  });

  it('should allow public read for manage_entity list', () => {
    expect(isPublicReadable('manage_entity', { action: 'list' })).toBe(true);
  });

  it('should deny public read for manage_entity create', () => {
    expect(isPublicReadable('manage_entity', { action: 'create' })).toBe(false);
  });

  it('should deny public read for query_sql', () => {
    expect(isPublicReadable('query_sql', {})).toBe(false);
  });

  it('should deny public read for unknown tools', () => {
    expect(isPublicReadable('unknown_tool', {})).toBe(false);
  });

  it('should allow public read for manage_watchers read actions', () => {
    expect(isPublicReadable('manage_watchers', { action: 'get_versions' })).toBe(true);
    expect(isPublicReadable('manage_watchers', { action: 'get_version_details' })).toBe(true);
    expect(isPublicReadable('manage_watchers', { action: 'get_component_reference' })).toBe(true);
  });

  it('should deny public read for manage_watchers mutations', () => {
    expect(isPublicReadable('manage_watchers', { action: 'create' })).toBe(false);
    expect(isPublicReadable('manage_watchers', { action: 'create_version' })).toBe(false);
    expect(isPublicReadable('manage_watchers', { action: 'set_reaction_script' })).toBe(false);
  });

  it('should allow public read for manage_classifiers list', () => {
    expect(isPublicReadable('manage_classifiers', { action: 'list' })).toBe(true);
  });

  it('should deny public read for manage_classifiers create', () => {
    expect(isPublicReadable('manage_classifiers', { action: 'create' })).toBe(false);
  });

  it('should allow public read for manage_operations list_available', () => {
    expect(isPublicReadable('manage_operations', { action: 'list_available' })).toBe(true);
  });

  it('should deny public read for manage_operations execute', () => {
    expect(isPublicReadable('manage_operations', { action: 'execute' })).toBe(false);
  });
});

describe('checkToolAccess', () => {
  const baseAuth: AuthContext = {
    organizationId: 'org_123',
    userId: 'user_123',
    memberRole: null,
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: true,
    clientId: 'client_123',
    scopes: ['mcp:read'],
    requestUrl: 'http://localhost/mcp/acme',
    baseUrl: 'http://localhost',
    scopedToOrg: true,
  };

  it('explains the public read-only upgrade path on write attempts', () => {
    expect(() => checkToolAccess('save_knowledge', {}, baseAuth)).toThrow(
      'This public workspace is read-only for your account. Ask an organization admin to invite you for write access.'
    );
  });

  it('requires write scope for member writes', () => {
    expect(() =>
      checkToolAccess('save_knowledge', {}, { ...baseAuth, memberRole: 'member' })
    ).toThrow(
      'This MCP session is read-only. Reconnect with write access after you are added to the organization.'
    );
  });

  it('allows members with write scope to save knowledge', () => {
    expect(() =>
      checkToolAccess(
        'save_knowledge',
        {},
        {
          ...baseAuth,
          memberRole: 'member',
          scopes: ['mcp:write'],
        }
      )
    ).not.toThrow();
  });

  it('keeps admin-only actions restricted for members', () => {
    expect(() =>
      checkToolAccess(
        'manage_connections',
        { action: 'create' },
        {
          ...baseAuth,
          memberRole: 'member',
          scopes: ['mcp:admin'],
        }
      )
    ).toThrow(
      'This action requires admin or owner access. Ask an organization owner to grant elevated access.'
    );
  });
});
