import { LINKEDIN_IDENTITY } from '@lobu/connectors/linkedin-identity';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { entityLinkMatchSql } from '../../../utils/content-search/entity-link';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const connectorKey = 'linkedin';
const feedKey = 'home_feed';

async function seedOrganization(): Promise<string> {
  const sql = getTestDb();
  const organization = await createTestOrganization({
    name: 'LinkedIn Recall Org',
  });
  const user = await createTestUser();
  await addUserToOrganization(user.id, organization.id, 'owner');
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${organization.id}, 'person', 'Person', current_timestamp, current_timestamp)
  `;
  await createTestConnectorDefinition({
    key: connectorKey,
    name: 'LinkedIn',
    organization_id: organization.id,
    feeds_schema: {
      [feedKey]: {
        eventKinds: {
          post: {
            attributions: [
              {
                role: 'authored_by',
                autoCreate: true,
                target: {
                  entityType: 'person',
                  titlePath: 'metadata.author',
                  identities: [
                    {
                      namespace: LINKEDIN_IDENTITY.MEMBER_ID,
                      eventPath: 'metadata.author_member_id',
                    },
                    {
                      namespace: LINKEDIN_IDENTITY.SLUG,
                      eventPath: 'metadata.author_linkedin_slug',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
  clearEntityLinkRulesCache();
  return organization.id;
}

describe('LinkedIn person event recall', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('recalls persisted posts through slug-only and member-id identities', async () => {
    const organizationId = await seedOrganization();
    const sql = getTestDb();
    const items: Array<{
      origin_type: string;
      metadata: Record<string, unknown>;
    }> = [
      {
        origin_type: 'post',
        metadata: {
          author: 'Jane Doe',
          author_linkedin_slug: 'Jane-Doe',
        },
      },
      {
        origin_type: 'post',
        metadata: {
          author: 'John Doe',
          author_member_id: 'urn:li:fsd_profile:ACoAAB1234',
        },
      },
    ];

    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: organizationId,
      items,
    });

    expect(items[0].metadata.linkedin_slug).toBe('jane-doe');
    expect(items[1].metadata.linkedin_member_id).toBe('ACoAAB1234');

    const inserted = await Promise.all(
      items.map((item, index) =>
        insertEvent({
          entityIds: [],
          organizationId,
          originId: `linkedin-post-${index + 1}`,
          semanticType: 'post',
          title: `LinkedIn post ${index + 1}`,
          originType: 'post',
          connectorKey,
          metadata: item.metadata,
        }),
      ),
    );

    const people = await sql<{ id: number; name: string }[]>`
      SELECT e.id, e.name
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${organizationId}
        AND et.slug = 'person'
        AND e.deleted_at IS NULL
      ORDER BY e.name
    `;
    expect(people.map((person) => person.name)).toEqual([
      'Jane Doe',
      'John Doe',
    ]);

    const eventIdsFor = async (entityId: number): Promise<number[]> => {
      const rows = await sql<{ id: number }[]>`
        SELECT f.id
        FROM events f
        WHERE f.organization_id = ${organizationId}
          AND ${sql.unsafe(entityLinkMatchSql(`${entityId}::bigint`, 'f'))}
        ORDER BY f.id
      `;
      return rows.map((row) => Number(row.id));
    };

    expect(await eventIdsFor(people[0].id)).toEqual([Number(inserted[0].id)]);
    expect(await eventIdsFor(people[1].id)).toEqual([Number(inserted[1].id)]);
  });
});
