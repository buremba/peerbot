/**
 * $resource system-slug migration (`20260717120000_system_entity_type_slugs.sql`).
 *
 * - Empty-schema legacy ACL types (channel / repo / $channel / $repo) promote to
 *   `$resource` with schema columns cleared.
 * - Domain types named `channel` that have properties are left alone.
 *
 * Global migration steps run inside a transaction we ROLL BACK so the shared
 * integration DB is not permanently mutated.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { createTestOrganization } from '../../setup/test-fixtures';

const MIGRATION = '20260717120000_system_entity_type_slugs.sql';

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

interface Captured {
  promoted: {
    id: number;
    slug: string;
    metadata_schema: unknown;
    event_kinds: unknown;
  } | null;
  /** True when the promoted $resource row is the same row we seeded as channel. */
  promotedLegacyRow: boolean;
  domainChannelSurvived: boolean;
  domainChannelSlug: string | null;
}

class Rollback extends Error {}

describe('$resource system-slug migration', () => {
  let captured: Captured;

  beforeAll(async () => {
    const orgId = (await createTestOrganization()).id;
    const sql = getDb();
    const upSection = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);

    const result: Captured = {
      promoted: null,
      promotedLegacyRow: false,
      domainChannelSurvived: false,
      domainChannelSlug: null,
    };

    try {
      await sql.begin(async (tx: typeof sql) => {
        // Empty-schema ACL anchor — must promote to $resource.
        const [legacy] = await tx<{ id: number }[]>`
          INSERT INTO entity_types
            (organization_id, slug, name, description, icon, metadata_schema, event_kinds, created_at, updated_at)
          VALUES (
            ${orgId}, 'channel', 'Channel', 'legacy channel', 'hash',
            NULL, NULL,
            current_timestamp, current_timestamp
          )
          RETURNING id
        `;

        // Domain knowledge type that happens to be named `channel` but has
        // properties — must NOT be absorbed.
        await tx`
          INSERT INTO entity_types
            (organization_id, slug, name, description, metadata_schema, created_at, updated_at)
          VALUES (
            ${orgId}, 'channel-topic', 'Channel topic', 'domain',
            ${tx.json({ type: 'object', properties: { topic: { type: 'string' } } })},
            current_timestamp, current_timestamp
          )
        `;
        // A *different org-style* slug that is still named channel with properties
        // would conflict on unique (org, slug) — use a second org for domain channel.
        const org2 = (await createTestOrganization()).id;
        const [domainChannel] = await tx<{ id: number }[]>`
          INSERT INTO entity_types
            (organization_id, slug, name, description, metadata_schema, created_at, updated_at)
          VALUES (
            ${org2}, 'channel', 'Chat topic', 'domain knowledge channel',
            ${tx.json({ type: 'object', properties: { topic: { type: 'string' } } })},
            current_timestamp, current_timestamp
          )
          RETURNING id
        `;

        await tx.unsafe(upSection);

        const promoted = await tx<
          {
            id: number;
            slug: string;
            metadata_schema: unknown;
            event_kinds: unknown;
          }[]
        >`
          SELECT id, slug, metadata_schema, event_kinds
          FROM entity_types
          WHERE organization_id = ${orgId}
            AND slug = '$resource'
            AND deleted_at IS NULL
          LIMIT 1
        `;
        result.promoted = promoted[0] ?? null;
        result.promotedLegacyRow = promoted[0]?.id === legacy.id;

        const domain = await tx<{ id: number; slug: string; deleted_at: Date | null }[]>`
          SELECT id, slug, deleted_at
          FROM entity_types
          WHERE id = ${domainChannel.id}
          LIMIT 1
        `;
        result.domainChannelSurvived =
          domain.length > 0 && domain[0].deleted_at === null && domain[0].slug === 'channel';
        result.domainChannelSlug = domain[0]?.slug ?? null;

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }

    captured = result;
  });

  it('promotes empty-schema channel to $resource and clears schema columns', () => {
    expect(captured.promoted).not.toBeNull();
    expect(captured.promotedLegacyRow).toBe(true);
    expect(captured.promoted!.slug).toBe('$resource');
    expect(captured.promoted!.metadata_schema).toBeNull();
    expect(captured.promoted!.event_kinds).toBeNull();
  });

  it('does not absorb a domain channel type that has properties', () => {
    expect(captured.domainChannelSurvived).toBe(true);
    expect(captured.domainChannelSlug).toBe('channel');
  });
});
