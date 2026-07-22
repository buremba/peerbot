/**
 * $canvas backfill migration (`20260722010000_canvas_entity_type_backfill.sql`).
 *
 * Canvas entities used to bind to whatever entity type had the lowest id in the
 * org (usually `$member`, provisioned first), because nothing ever created the
 * `canvas` type `ensureCanvasEntity` looked for. This migration repoints those
 * rows onto a per-org `$canvas` type.
 *
 * Selection is by the live `watcher_canvas` identity claim — the authoritative
 * per-watcher canvas identity — NOT by `metadata->>'source'`, which is
 * user-editable. Proves:
 *   - a claimed canvas moves to `$canvas`
 *   - a real `$member` row does not move
 *   - a row that merely *claims* source=watcher_canvas in metadata, with no
 *     identity row, does not move
 *   - a row whose only `watcher_canvas` identity is soft-deleted does not move
 *     (the claim must be live: `deleted_at IS NULL`)
 *   - re-running is a no-op (migrations may be replayed)
 *   - exactly one `$canvas` type per org
 *
 * Runs inside a transaction we ROLL BACK so the shared integration DB is not
 * permanently mutated.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const MIGRATION = '20260722010000_canvas_entity_type_backfill.sql';

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
  claimedCanvasSlug: string | null;
  realMemberSlug: string | null;
  metadataOnlySlug: string | null;
  deletedIdentitySlug: string | null;
  canvasTypeCount: number;
  slugsAfterRerun: string[];
}

class Rollback extends Error {}

describe('$canvas backfill migration', () => {
  let captured: Captured;

  beforeAll(async () => {
    const orgId = (await createTestOrganization()).id;
    const user = await createTestUser({ email: `canvas-bf-${Date.now()}@test.com` });
    const sql = getDb();
    const upSection = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);

    const result: Captured = {
      claimedCanvasSlug: null,
      realMemberSlug: null,
      metadataOnlySlug: null,
      deletedIdentitySlug: null,
      canvasTypeCount: 0,
      slugsAfterRerun: [],
    };

    const slugOf = async (tx: typeof sql, entityId: number): Promise<string | null> => {
      const rows = await tx<{ slug: string }[]>`
        SELECT et.slug
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.id = ${entityId}
        LIMIT 1
      `;
      return rows[0]?.slug ?? null;
    };

    try {
      await sql.begin(async (tx: typeof sql) => {
        // `$member` is the lowest-id type in the org — the pre-fix fallback target.
        const [memberType] = await tx<{ id: number }[]>`
          INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
          VALUES (${orgId}, '$member', 'Member', current_timestamp, current_timestamp)
          RETURNING id
        `;

        // A real canvas entity: mis-typed as $member AND holding the identity claim.
        const [canvas] = await tx<{ id: number }[]>`
          INSERT INTO entities
            (organization_id, entity_type_id, name, slug, metadata, created_by, created_at, updated_at)
          VALUES (
            ${orgId}, ${memberType.id}, 'Canvas · watcher 1', 'watcher-canvas-1',
            ${tx.json({ watcher_id: 1, source: 'watcher_canvas' })},
            ${user.id}, current_timestamp, current_timestamp
          )
          RETURNING id
        `;
        await tx`
          INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
          VALUES (${orgId}, ${canvas.id}, 'watcher_canvas', '1')
        `;

        // A genuine workspace member — must survive untouched.
        const [member] = await tx<{ id: number }[]>`
          INSERT INTO entities
            (organization_id, entity_type_id, name, slug, metadata, created_by, created_at, updated_at)
          VALUES (
            ${orgId}, ${memberType.id}, 'Real Person', 'real-person',
            ${tx.json({})}, ${user.id}, current_timestamp, current_timestamp
          )
          RETURNING id
        `;

        // Metadata claims canvas, but there is no identity row. Metadata is
        // user-editable, so this must NOT be swept into the system type.
        const [impostor] = await tx<{ id: number }[]>`
          INSERT INTO entities
            (organization_id, entity_type_id, name, slug, metadata, created_by, created_at, updated_at)
          VALUES (
            ${orgId}, ${memberType.id}, 'Fake Canvas', 'fake-canvas',
            ${tx.json({ source: 'watcher_canvas' })},
            ${user.id}, current_timestamp, current_timestamp
          )
          RETURNING id
        `;

        // Held a `watcher_canvas` claim once, but it is now soft-deleted. The
        // backfill matches only live claims (`deleted_at IS NULL`), so a stale
        // claim must NOT move the entity; else replaying with historical rows
        // would re-type former canvases.
        const [deletedCanvas] = await tx<{ id: number }[]>`
          INSERT INTO entities
            (organization_id, entity_type_id, name, slug, metadata, created_by, created_at, updated_at)
          VALUES (
            ${orgId}, ${memberType.id}, 'Canvas · watcher 2', 'watcher-canvas-2',
            ${tx.json({ watcher_id: 2, source: 'watcher_canvas' })},
            ${user.id}, current_timestamp, current_timestamp
          )
          RETURNING id
        `;
        await tx`
          INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, deleted_at)
          VALUES (${orgId}, ${deletedCanvas.id}, 'watcher_canvas', '2', current_timestamp)
        `;

        await tx.unsafe(upSection);

        result.claimedCanvasSlug = await slugOf(tx, canvas.id);
        result.realMemberSlug = await slugOf(tx, member.id);
        result.metadataOnlySlug = await slugOf(tx, impostor.id);
        result.deletedIdentitySlug = await slugOf(tx, deletedCanvas.id);

        const typeRows = await tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n
          FROM entity_types
          WHERE organization_id = ${orgId} AND slug = '$canvas' AND deleted_at IS NULL
        `;
        result.canvasTypeCount = Number(typeRows[0]?.n ?? 0);

        // Migrations may be replayed — a second run must change nothing.
        await tx.unsafe(upSection);
        result.slugsAfterRerun = [
          (await slugOf(tx, canvas.id)) ?? '',
          (await slugOf(tx, member.id)) ?? '',
          (await slugOf(tx, impostor.id)) ?? '',
          (await slugOf(tx, deletedCanvas.id)) ?? '',
        ];

        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }

    captured = result;
  });

  it('repoints a claimed canvas entity onto $canvas', () => {
    expect(captured.claimedCanvasSlug).toBe('$canvas');
  });

  it('leaves a real $member entity alone', () => {
    expect(captured.realMemberSlug).toBe('$member');
  });

  it('ignores an entity whose metadata claims canvas but holds no identity', () => {
    expect(captured.metadataOnlySlug).toBe('$member');
  });

  it('ignores an entity whose only watcher_canvas identity is soft-deleted', () => {
    expect(captured.deletedIdentitySlug).toBe('$member');
  });

  it('creates exactly one $canvas type for the org', () => {
    expect(captured.canvasTypeCount).toBe(1);
  });

  it('is idempotent across a replay', () => {
    expect(captured.slugsAfterRerun).toEqual(['$canvas', '$member', '$member', '$member']);
  });
});
