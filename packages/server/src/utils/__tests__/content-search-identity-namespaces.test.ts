import { IDENTITY } from '@lobu/connector-sdk/identity-namespaces';
import { describe, expect, it } from 'vitest';
import {
  buildEntityLinkUnion,
  entityLinkMatchSql,
  STANDARD_IDENTITY_NAMESPACES,
} from '../content-search/entity-link';

describe('content-search identity namespace registry bridge', () => {
  it('uses the shared event-recall registry instead of a local allowlist', () => {
    expect(STANDARD_IDENTITY_NAMESPACES).toContain(IDENTITY.X_USER_ID);
    expect(STANDARD_IDENTITY_NAMESPACES).not.toContain(IDENTITY.X_HANDLE);
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
        { namespace: IDENTITY.X_USER_ID, identifier: '123' },
        { namespace: IDENTITY.X_HANDLE, identifier: 'alice' },
      ],
    });

    expect(result.sql).toContain("metadata ? 'x_user_id'");
    expect(result.sql).toContain("metadata->>'x_user_id' = $3");
    expect(result.sql).not.toContain('x_handle');
    expect(result.params).toEqual(['123']);
  });
});
