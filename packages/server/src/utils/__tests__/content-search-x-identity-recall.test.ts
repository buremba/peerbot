import { IDENTITY } from '@lobu/connector-sdk/identity-namespaces';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { buildEntityLinkUnion, fetchEntityIdentityScopes } from '../content-search/entity-link';

describe('content-search X identity recall', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('recalls X events for an entity through the indexed x_user_id identity scope', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'X Identity Recall Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const person = await createTestEntity({
      name: 'Alice X',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });

    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, created_at, updated_at)
      VALUES (${org.id}, ${person.id}, ${IDENTITY.X_USER_ID}, '12345', NOW(), NOW())
    `;
    const event = await createTestEvent({
      organization_id: org.id,
      title: 'Alice posted on X',
      content: 'hello from x',
      connector_key: 'x',
      metadata: { x_user_id: '12345', x_handle: 'alice' },
    });
    await createTestEvent({
      organization_id: org.id,
      title: 'Different X user',
      content: 'not alice',
      connector_key: 'x',
      metadata: { x_user_id: '99999', x_handle: 'other' },
    });

    const scopes = await fetchEntityIdentityScopes(sql, person.id);
    expect(scopes).toContainEqual({ namespace: IDENTITY.X_USER_ID, identifier: '12345' });

    const predicate = buildEntityLinkUnion({
      entityIdLiteral: person.id,
      scopes,
      alias: 'f',
      baseParamIndex: 1,
    });
    const rows = await sql.unsafe(
      `SELECT f.id FROM events f WHERE ${predicate.sql} ORDER BY f.id`,
      predicate.params
    );

    expect(rows.map((row) => Number(row.id))).toEqual([event.id]);
  });
});
