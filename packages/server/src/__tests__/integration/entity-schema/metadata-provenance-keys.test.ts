/**
 * Watcher-promotion provenance keys must survive metadata round-trips.
 *
 * `promote-keyed-entities.ts` stamps `watcher_id` / `stable_key` / `window_id`
 * (plus `source`) onto a promoted entity's metadata via raw SQL — outside
 * schema validation. Under an `additionalProperties: false` entity-type schema
 * that meant a promoted entity's metadata could never be written back through
 * `entities.update`: reading the metadata, editing one domain field, and
 * saving rejected with "unknown property 'window_id'". Validation now exempts
 * exactly those platform keys; everything else stays schema-enforced.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { cleanupTestDatabase } from '../../setup/test-db';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('entity metadata validation > watcher provenance keys', () => {
  let owner: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Provenance Keys Org' });
    const user = await createTestUser({ email: 'provenance-keys@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({
      slug: 'strict-task',
      name: 'Strict Task',
      metadata_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          status: { type: 'string', enum: ['backlog', 'active', 'done'] },
          source: { type: 'string' },
        },
      },
    } as never);
  });

  it('accepts watcher_id/stable_key/window_id on update under additionalProperties: false', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Promoted task round-trip',
      metadata: { action: 'Ship the fix', status: 'backlog' },
    })) as { entity: { id: number } };

    // The exact write a client makes after reading a promoted entity's
    // metadata (provenance keys included) and editing one domain field.
    await owner.entities.update({
      entity_id: created.entity.id,
      metadata: {
        action: 'Ship the fix',
        status: 'done',
        source: 'watcher_promotion',
        watcher_id: 5,
        stable_key: 'ship-the-fix',
        window_id: 4288453,
      },
    });

    const got = (await owner.entities.get(created.entity.id)) as {
      entity?: { metadata?: Record<string, unknown> };
    };
    expect(got.entity?.metadata?.status).toBe('done');
    expect(got.entity?.metadata?.window_id).toBe(4288453);
  });

  it('still rejects genuinely unknown metadata keys', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Strictness control',
      metadata: { action: 'Stay strict', status: 'backlog' },
    })) as { entity: { id: number } };

    const err = await owner.entities
      .update({
        entity_id: created.entity.id,
        metadata: { action: 'Stay strict', bogus_field: true },
      })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err?.message).toContain("unknown property 'bogus_field'");
  });
});
