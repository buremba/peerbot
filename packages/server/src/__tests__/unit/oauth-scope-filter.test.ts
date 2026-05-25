import { describe, expect, it } from 'bun:test';
import { filterScopeByRole, grantConnectionsTokenScope } from '../../auth/oauth/scopes';

describe('filterScopeByRole', () => {
  it('keeps mcp:admin when the user is an owner', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'owner');
    expect(result).not.toBeNull();
    expect((result as string).split(' ')).toContain('mcp:admin');
    expect((result as string).split(' ')).toContain('mcp:write');
    expect((result as string).split(' ')).toContain('mcp:read');
    expect((result as string).split(' ')).toContain('profile:read');
  });

  it('keeps mcp:admin when the user is an admin', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'admin');
    expect(result).not.toBeNull();
    expect((result as string).split(' ')).toContain('mcp:admin');
  });

  it('strips mcp:admin when the user is a regular member', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'member');
    expect(result).not.toBeNull();
    expect((result as string).split(' ')).not.toContain('mcp:admin');
    expect((result as string).split(' ')).toContain('mcp:write');
    expect((result as string).split(' ')).toContain('mcp:read');
    expect((result as string).split(' ')).toContain('profile:read');
  });

  it('strips mcp:admin when the user has no membership', () => {
    const result = filterScopeByRole('mcp:read mcp:admin', null);
    expect(result).not.toBeNull();
    expect((result as string).split(' ')).not.toContain('mcp:admin');
    expect((result as string).split(' ')).toContain('mcp:read');
  });

  it('passes through non-admin scopes unchanged for any role', () => {
    const result = filterScopeByRole('mcp:read mcp:write profile:read', 'member');
    expect(result).toBe('mcp:read mcp:write profile:read');
  });

  it('returns empty string when no scope is requested at all', () => {
    expect(filterScopeByRole('', 'member')).toBe('');
    expect(filterScopeByRole(null, 'member')).toBe('');
    expect(filterScopeByRole(undefined, 'owner')).toBe('');
  });

  it('returns null when filtering wipes out a non-empty admin-only request for non-admins', () => {
    // A non-admin requesting only mcp:admin must NOT silently get an empty
    // grant — the OAuth code path stores empty scope as null, which
    // downstream parsing treats as the default scope set, unintentionally
    // granting mcp:read mcp:write. Returning null forces the caller to
    // reject with invalid_scope (RFC 6749 §4.1.2.1).
    expect(filterScopeByRole('mcp:admin', 'member')).toBeNull();
    expect(filterScopeByRole('mcp:admin', null)).toBeNull();
    expect(filterScopeByRole('  mcp:admin  ', 'member')).toBeNull();
  });

  it('returns the scope string when admins request only mcp:admin', () => {
    expect(filterScopeByRole('mcp:admin', 'owner')).toBe('mcp:admin');
    expect(filterScopeByRole('mcp:admin', 'admin')).toBe('mcp:admin');
  });

  it('collapses extra whitespace', () => {
    const result = filterScopeByRole('  mcp:read   mcp:admin   ', 'owner');
    expect(result).toBe('mcp:read mcp:admin');
  });
});

describe('grantConnectionsTokenScope', () => {
  it('appends connections:token to an MCP-scoped login grant', () => {
    expect(grantConnectionsTokenScope('mcp:read mcp:write')).toBe(
      'mcp:read mcp:write connections:token'
    );
  });

  it('is idempotent — never duplicates the scope', () => {
    expect(grantConnectionsTokenScope('mcp:read connections:token mcp:write')).toBe(
      'mcp:read connections:token mcp:write'
    );
  });

  it('preserves the original token order, appending at the end', () => {
    expect(grantConnectionsTokenScope('mcp:admin profile:read')).toBe(
      'mcp:admin profile:read connections:token'
    );
  });

  it('leaves a null/empty/scope-less grant untouched (no connection-token scope)', () => {
    expect(grantConnectionsTokenScope(null)).toBeNull();
    expect(grantConnectionsTokenScope(undefined)).toBeNull();
    expect(grantConnectionsTokenScope('')).toBe('');
    expect(grantConnectionsTokenScope('   ')).toBe('   ');
  });
});
