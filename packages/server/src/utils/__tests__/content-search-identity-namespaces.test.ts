import { X_IDENTITY } from '@lobu/connectors/x-identity';
import { describe, expect, it } from 'vitest';
import {
  buildEntityLinkUnion,
  entityLinkMatchSql,
  STANDARD_IDENTITY_NAMESPACES,
} from '../content-search/entity-link';

describe('content-search identity namespace registry bridge', () => {
  it('includes connector-contributed recall namespaces (x_user_id) but not mutable handles', () => {
    // x_user_id is recall-indexed via the X connector module; x_handle is not.
    expect(STANDARD_IDENTITY_NAMESPACES).toContain(X_IDENTITY.USER_ID);
    expect(STANDARD_IDENTITY_NAMESPACES).not.toContain(X_IDENTITY.HANDLE);
  });

  it('emits an indexed x_user_id branch for entity-link matching', () => {
    const sql = entityLinkMatchSql('$1', 'f');
    expect(sql).toContain("ei.namespace = 'x_user_id'");
    expect(sql).toContain("e2.metadata ? 'x_user_id'");
  });

  it('builds scoped unions for indexed namespaces and skips mutable unindexed handles', () => {
    const result = buildEntityLinkUnion({
      entityIdLiteral: 42,
      alias: 'f',
      baseParamIndex: 3,
      scopes: [
        { namespace: X_IDENTITY.USER_ID, identifier: '123' },
        { namespace: X_IDENTITY.HANDLE, identifier: 'alice' },
      ],
    });

    expect(result.sql).toContain("metadata ? 'x_user_id'");
    expect(result.sql).toContain("metadata->>'x_user_id' = $3");
    expect(result.sql).not.toContain('x_handle');
    expect(result.params).toEqual(['123']);
  });
});
