/**
 * Tool Access Tests
 *
 * Tests for requiresOwnerAdmin and isPublicReadable authorization checks.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolNotRegisteredError } from '../../utils/errors';
import { routeAction } from '../../tools/admin/action-router';
import { type AuthContext, checkToolAccess } from '../../tools/execute';
import { getTool, type ToolContext } from '../../tools/registry';
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
    expect(
      requiresOwnerAdmin('manage_connections', { action: 'update_connector_default_config' }, false)
    ).toBe(true);
    expect(requiresOwnerAdmin('manage_connections', { action: 'reauthenticate' }, false)).toBe(
      true
    );
  });

  it('should require admin for manage_auth_profiles sensitive actions', () => {
    expect(requiresOwnerAdmin('manage_auth_profiles', { action: 'get_auth_profile' }, false)).toBe(
      true
    );
    expect(
      requiresOwnerAdmin('manage_auth_profiles', { action: 'test_auth_profile' }, false)
    ).toBe(true);
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
    expect(requiresOwnerAdmin('manage_watchers', { action: 'trigger' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_watchers', { action: 'create_from_version' }, false)).toBe(
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
    expect(requiresOwnerAdmin('manage_watchers', { action: 'get_feedback' }, false)).toBe(false);
  });

  it('should require admin for view template mutations while leaving reads as read-tier', () => {
    expect(requiresOwnerAdmin('manage_view_templates', { action: 'set' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_view_templates', { action: 'rollback' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_view_templates', { action: 'get' }, false)).toBe(false);
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

describe('routeAction per-action enforcement', () => {
  const memberWriteCtx: ToolContext = {
    organizationId: 'org_123',
    userId: 'user_123',
    memberRole: 'member',
    isAuthenticated: true,
    scopes: ['mcp:write'],
  };

  it('blocks admin-only handler actions reached through execute for write-tier members', async () => {
    let called = false;
    await expect(
      routeAction('manage_entity_schema', 'create', memberWriteCtx, {
        create: async () => {
          called = true;
          return { ok: true };
        },
      })
    ).rejects.toThrow(/requires admin or owner access/i);
    expect(called).toBe(false);
  });

  it('requires admin MCP scope even for owner/admin roles', async () => {
    await expect(
      routeAction(
        'manage_connections',
        'install_connector',
        {
          ...memberWriteCtx,
          memberRole: 'admin',
        },
        {
          install_connector: async () => ({ ok: true }),
        }
      )
    ).rejects.toThrow(/requires an MCP session with admin access/i);
  });

  it('preserves system reaction calls', async () => {
    await expect(
      routeAction(
        'manage_operations',
        'execute',
        {
          organizationId: 'org_123',
          userId: null,
          memberRole: null,
          isAuthenticated: true,
        },
        {
          execute: async () => ({ ok: true }),
        }
      )
    ).resolves.toEqual({ ok: true });
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

  it('explains the public read-only situation on write attempts', () => {
    expect(() => checkToolAccess('save_knowledge', {}, baseAuth)).toThrow(
      /public workspace is read-only/i
    );
  });

  it('requires write scope for member writes', () => {
    expect(() =>
      checkToolAccess('save_knowledge', {}, { ...baseAuth, memberRole: 'member' })
    ).toThrow(/MCP session is read-only/i);
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

  it('hides internal tools from external MCP calls even when the name is known', () => {
    expect(() =>
      checkToolAccess('manage_entity', { action: 'list' }, { ...baseAuth, memberRole: 'owner' })
    ).toThrow('Tool not found: manage_entity');
  });

  it('throws ToolNotRegisteredError for genuinely unregistered names so REST proxy can alert', () => {
    expect(() =>
      checkToolAccess('this_tool_does_not_exist', {}, { ...baseAuth, memberRole: 'owner' })
    ).toThrow(ToolNotRegisteredError);
  });

  it('allows REST compatibility paths to reach internal tools subject to access', () => {
    expect(() =>
      checkToolAccess('manage_entity', { action: 'create' }, {
        ...baseAuth,
        memberRole: 'member',
        scopes: ['mcp:write'],
        allowInternalTools: true,
      })
    ).not.toThrow();
  });

  it.each(['list_watchers', 'get_watcher', 'read_knowledge'])(
    'hides %s from external MCP but keeps it reachable via REST',
    (toolName) => {
      // External MCP — must look like an unknown tool to the caller.
      expect(() =>
        checkToolAccess(toolName, {}, { ...baseAuth, memberRole: 'owner' })
      ).toThrow(`Tool not found: ${toolName}`);

      // REST proxy — frontend reaches the same handler.
      expect(() =>
        checkToolAccess(
          toolName,
          {},
          { ...baseAuth, memberRole: 'member', allowInternalTools: true }
        )
      ).not.toThrow();
    }
  );

  it('keeps admin-only tools restricted for members', () => {
    // query_sql is the canonical admin-only tool on the post-PR-2 surface.
    expect(() =>
      checkToolAccess(
        'query_sql',
        { sql: 'SELECT 1', sort_by: 'id' },
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

describe('first-party tool-name coverage', () => {
  // Both surfaces share the same dispatch (`POST /api/:orgSlug/:toolName` →
  // `restToolProxy` → `executeTool` → `getTool(name)`), but the CLI's
  // browser-auth flow goes through MCP RPC and needs its tools to *also* be
  // visible on `tools/list` (i.e. NOT `internal: true`). These tests pin both
  // invariants.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webSrcRoot = join(__dirname, '..', '..', '..', '..', 'web', 'src');
  // The standalone owletto-cli package was merged into @lobu/cli's `memory`
  // namespace; the REST callTool(...) sites moved to packages/cli/src/commands/memory/.
  const cliSrcRoot = join(__dirname, '..', '..', '..', '..', 'cli', 'src', 'commands', 'memory');

  function present(path: string): boolean {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  function collectTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        collectTsFiles(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  function extractMatches(root: string, pattern: RegExp): Set<string> {
    const names = new Set<string>();
    for (const file of collectTsFiles(root)) {
      for (const match of readFileSync(file, 'utf-8').matchAll(pattern)) {
        names.add(match[1]);
      }
    }
    return names;
  }

  // Names a first-party caller invokes that have no backend handler. Each
  // entry is dead code — kept here so the test fails the day someone wires
  // it up without first registering the tool. Empty this set when cleaned up.
  const KNOWN_DEAD_NAMES = new Set<string>([
    // useDeleteWindow in web/src/hooks/use-watchers.ts has no caller;
    // manage_queue was never registered. Delete the hook or add the tool.
    'manage_queue',
  ]);

  function assertRegistered(used: Set<string>): void {
    const drift: string[] = [];
    const stale: string[] = [];
    for (const name of used) {
      const registered = !!getTool(name);
      if (KNOWN_DEAD_NAMES.has(name)) {
        if (registered) stale.push(name);
        continue;
      }
      if (!registered) drift.push(name);
    }
    expect(drift).toEqual([]);
    // If a previously-dead name is now registered, remove it from the allowlist.
    expect(stale).toEqual([]);
  }

  it('every web tool reference (apiCall + hook-factory) is registered', () => {
    if (!present(webSrcRoot)) return; // submodule not checked out (shallow clone)
    // Two patterns: direct `apiCall(<...>?)('foo', …)` and the hook-factory
    // config form `tool: 'foo'` (used at api/entities.ts:165, api/connections.ts,
    // etc. — over 30 sites the direct-apiCall regex would otherwise miss).
    const apiCallNames = extractMatches(
      webSrcRoot,
      /\bapiCall(?:<[^>]*>)?\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g
    );
    const hookFactoryNames = extractMatches(
      webSrcRoot,
      /\btool:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g
    );
    assertRegistered(new Set([...apiCallNames, ...hookFactoryNames]));
  });

  it('every lobu memory REST callTool(ctx, name) is registered', () => {
    if (!present(cliSrcRoot)) return;
    const used = extractMatches(
      cliSrcRoot,
      /\bcallTool\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g
    );
    assertRegistered(used);
  });

  // CLI bootstrap tools that the `lobu memory browser-auth` flow drives via the
  // REST proxy (`POST /api/{slug}/{toolName}`). They must be registered AND
  // `internal: true` so they stay off the external MCP surface — no external
  // MCP client should see CLI bootstrap tools in `tools/list`.
  const CLI_REST_BOOTSTRAP_TOOLS = ['manage_connections', 'manage_auth_profiles'] as const;

  it.each(CLI_REST_BOOTSTRAP_TOOLS)(
    'CLI bootstrap tool %s is registered and hidden from external MCP tools/list',
    (name) => {
      const tool = getTool(name);
      expect(tool).toBeDefined();
      // `internal: true` keeps these tools reachable via the REST proxy
      // (`allowInternalTools=true` for non-`/mcp` paths) while hiding them
      // from external MCP clients like Claude Desktop or Cursor.
      expect(tool?.internal).toBe(true);
    }
  );

  it('CLI browser-auth no longer calls bootstrap tools over MCP RPC', () => {
    // After the REST migration, browser-auth.ts must use `restToolCall(...)`
    // for these tools — never `mcpRpc(..., 'tools/call', ...)`. This drift
    // detector fails the moment someone re-introduces an MCP RPC call site.
    if (!present(cliSrcRoot)) return;
    const browserAuth = join(cliSrcRoot, '_lib', 'browser-auth-cmd.ts');
    if (!present(browserAuth)) return;
    const content = readFileSync(browserAuth, 'utf-8');
    expect(content).not.toMatch(/'tools\/call'/);
    for (const tool of CLI_REST_BOOTSTRAP_TOOLS) {
      // The REST helper takes the tool name as the second positional argument.
      const restPattern = new RegExp(`restToolCall<[^>]*>\\(\\s*\\w+\\s*,\\s*['"]${tool}['"]`);
      expect(content).toMatch(restPattern);
    }
  });
});
