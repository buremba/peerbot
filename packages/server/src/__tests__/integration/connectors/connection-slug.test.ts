/**
 * Connection slug identity.
 *
 * Covers the stable `connections.slug` added so `lobu apply` can diff
 * connections by an immutable key: slugify rules, auto-generation from
 * display_name, per-org collision suffixing, cross-org reuse, the partial
 * unique index (live rows only), and the `excludeId` no-op on update.
 *
 * The `manage_connections(update)` tool only touches `slug` when the caller
 * passes one explicitly — that wiring is exercised at the helper level here
 * (`ensureUniqueConnectionSlug({ excludeId })`) plus the schema/handler in
 * manage_connections.ts; a full tool-level test needs a connector definition
 * + env scaffolding that PR 2 (CLI apply) brings in.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ensureUniqueConnectionSlug, slugifyConnectionName } from '../../../utils/connections';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection, createTestOrganization } from '../../setup/test-fixtures';

describe('connections.slug', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('slugifyConnectionName lowercases, hyphenates, and trims', () => {
    expect(slugifyConnectionName('Acme Gmail Inbox')).toBe('acme-gmail-inbox');
    expect(slugifyConnectionName('  --Weird__Name!! ')).toBe('weird-name');
    expect(slugifyConnectionName('!!!')).toBe('');
    expect(slugifyConnectionName(null)).toBe('');
  });

  it('auto-generates a slugified slug from the display name', async () => {
    const org = await createTestOrganization({ name: 'Slug Org A' });
    const slug = await ensureUniqueConnectionSlug({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: 'Support Inbox',
    });
    expect(slug).toBe('support-inbox');
  });

  it('falls back to the connector key when the name has no alphanumerics', async () => {
    const org = await createTestOrganization({ name: 'Slug Org B' });
    const slug = await ensureUniqueConnectionSlug({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: '!!!',
    });
    expect(slug).toBe('google-gmail');
  });

  it('gives colliding display names distinct slugs within an org', async () => {
    const org = await createTestOrganization({ name: 'Slug Org C' });
    const a = await createTestConnection({
      organization_id: org.id,
      connector_key: 'google.gmail',
      display_name: 'Shared Name',
    });
    const b = await createTestConnection({
      organization_id: org.id,
      connector_key: 'google.gmail',
      display_name: 'Shared Name',
    });

    const sql = getTestDb();
    const rows = await sql`SELECT id, slug FROM connections WHERE organization_id = ${org.id} ORDER BY id`;
    const slugs = rows.map((r) => r.slug as string);
    expect(slugs).toEqual(['shared-name', 'shared-name-2']);
    expect(a.id).not.toBe(b.id);
  });

  it('the same slug can be reused in a different org', async () => {
    const orgA = await createTestOrganization({ name: 'Slug Org D1' });
    const orgB = await createTestOrganization({ name: 'Slug Org D2' });
    const s1 = await ensureUniqueConnectionSlug({
      organizationId: orgA.id,
      connectorKey: 'x',
      displayName: 'My Conn',
    });
    await createTestConnection({
      organization_id: orgA.id,
      connector_key: 'x',
      display_name: 'My Conn',
      slug: s1,
    });
    const s2 = await ensureUniqueConnectionSlug({
      organizationId: orgB.id,
      connectorKey: 'x',
      displayName: 'My Conn',
    });
    expect(s1).toBe('my-conn');
    expect(s2).toBe('my-conn');
  });

  it('enforces the partial unique index per org among live rows', async () => {
    const org = await createTestOrganization({ name: 'Slug Org E' });
    const sql = getTestDb();
    await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
      VALUES (${org.id}, 'x', 'dup-slug', 'Dup 1', 'active', 'org', NOW(), NOW())
    `;
    await expect(
      sql`
        INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
        VALUES (${org.id}, 'x', 'dup-slug', 'Dup 2', 'active', 'org', NOW(), NOW())
      `
    ).rejects.toThrow();
  });

  it('soft-deleting a row frees its slug for a new live row', async () => {
    const org = await createTestOrganization({ name: 'Slug Org E2' });
    const sql = getTestDb();
    await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, deleted_at, created_at, updated_at)
      VALUES (${org.id}, 'x', 'freed-slug', 'Old', 'active', 'org', NOW(), NOW(), NOW())
    `;
    await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
      VALUES (${org.id}, 'x', 'freed-slug', 'New', 'active', 'org', NOW(), NOW())
    `;
    const live = await sql`
      SELECT COUNT(*)::int AS n FROM connections
      WHERE organization_id = ${org.id} AND slug = 'freed-slug' AND deleted_at IS NULL
    `;
    expect((live[0] as { n: number }).n).toBe(1);
  });

  it('ensureUniqueConnectionSlug with excludeId ignores the row being updated', async () => {
    const org = await createTestOrganization({ name: 'Slug Org F' });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'x',
      display_name: 'Keep Me',
      slug: 'keep-me',
    });
    // Re-resolving "keep-me" while excluding the same connection returns it
    // unchanged (a no-op update doesn't bump the suffix).
    const slug = await ensureUniqueConnectionSlug({
      organizationId: org.id,
      connectorKey: 'x',
      explicitSlug: 'keep-me',
      excludeId: conn.id,
    });
    expect(slug).toBe('keep-me');
  });
});
