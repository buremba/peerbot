/**
 * M1: every read seam must compile its connection-visibility predicate from the
 * ONE compiler keyed on an AuthzScope. These pin the compiler's two shapes and
 * prove the recall/content adapter (`buildConnectionVisibilityClause`) is now a
 * byte-identical pass-through to it — so the SQL seam (buildScopedQuery) and the
 * recall/content seam can never drift.
 */
import { describe, expect, it } from 'bun:test';
import { buildConnectionVisibilityClause } from '../../utils/content-search/visibility';
import {
  compileConnectionFkVisibility,
  compileConnectionRowVisibility,
} from '../../authz/connection-visibility';
import { authzScopeFromToolContext, headlessScope } from '../../authz/scope';

const scope = { organizationId: 'org_test', principal: 'user_a' };

describe('connection-visibility compiler (M1 one-compiler)', () => {
  it('FK form gates by org + principal, NULL connection_id stays visible', () => {
    const { sql, params } = compileConnectionFkVisibility(scope, 5, 'ev');
    expect(sql).toContain('ev.connection_id IS NULL OR ev.connection_id IN');
    expect(sql).toContain('SELECT vc.id FROM public.connections vc');
    expect(sql).toContain("vc.visibility = 'org'");
    expect(sql).toContain('vc.created_by');
    // org bound at baseParamIndex, principal at baseParamIndex+1.
    expect(sql).toContain('$5::text');
    expect(sql).toContain('$6::text');
    expect(params).toEqual(['org_test', 'user_a']);
  });

  it('row form gates the connections row itself by principal', () => {
    const { sql, params } = compileConnectionRowVisibility(scope, 3, 'cn');
    expect(sql).toContain("cn.visibility = 'org'");
    expect(sql).toContain('cn.created_by');
    expect(sql).toContain('$3::text');
    expect(params).toEqual(['user_a']);
  });

  it('a null principal (headless) still binds null — fail-closed to org-only', () => {
    const fk = compileConnectionFkVisibility(headlessScope('org_test'), 1, 'ev');
    expect(fk.params).toEqual(['org_test', null]);
    const row = compileConnectionRowVisibility(headlessScope('org_test'), 1, 'cn');
    expect(row.params).toEqual([null]);
  });

  it('authzScopeFromToolContext maps ctx.userId → principal', () => {
    expect(authzScopeFromToolContext({ organizationId: 'o', userId: 'u', agentId: 'a' })).toEqual({
      organizationId: 'o',
      principal: 'u',
      agentId: 'a',
    });
    expect(authzScopeFromToolContext({ organizationId: 'o', userId: null })).toEqual({
      organizationId: 'o',
      principal: null,
      agentId: null,
    });
  });

  it('the recall/content adapter composes the connection-visibility compiler verbatim, then the resource gate', () => {
    const viaAdapter = buildConnectionVisibilityClause(
      { organizationId: 'org_test', userId: 'user_a', baseParamIndex: 7 },
      'f'
    );
    const viaCompiler = compileConnectionFkVisibility(scope, 7, 'f');
    // Connection visibility is STILL the one compiler's output, verbatim — the
    // adapter prefixes it (no re-derivation), then ANDs the orthogonal resource
    // gate, whose params follow the connection-visibility params in order.
    expect(viaAdapter.sql.startsWith(viaCompiler.sql)).toBe(true);
    expect(viaAdapter.params.slice(0, viaCompiler.params.length)).toEqual(viaCompiler.params);
    // Plus the per-resource membership gate composed after it.
    expect(viaAdapter.sql).toContain('member_of');
    expect(viaAdapter.params).toEqual(['org_test', 'user_a', 'org_test', 'user_a']);
  });

  it('the adapter still returns empty when no org is requested', () => {
    expect(buildConnectionVisibilityClause({ baseParamIndex: 1 }, 'f')).toEqual({
      sql: '',
      params: [],
    });
  });
});
