/**
 * Integration tests: buildWorkspaceInstructions render fidelity + org-wide
 * `guidance` context injection.
 *
 * Render fixes pinned here (all data was already STORED, but dropped at
 * render time):
 *   1. entity_types.description
 *   2. per-field metadata_schema.properties[field].description (and the
 *      top-level-keys bug: a real JSON Schema used to render "type, properties")
 *   3. entity_relationship_types.description
 *   4. connector_definitions.description
 *
 * Org guidance pinned here:
 *   - admin-authored `guidance` events render under "### Organization Context"
 *   - superseded guidance disappears (only the current event renders)
 *   - hard char cap with deterministic truncation
 *   - connector-sourced (connection_id IS NOT NULL) guidance is NOT injected
 *   - authorship gate: non-admin members and system contexts are rejected at
 *     save time; owners/admins are accepted
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { deleteContent } from '../../../tools/delete_content';
import { saveContent } from '../../../tools/save_content';
import type { ToolContext } from '../../../tools/registry';
import {
  GUIDANCE_SEMANTIC_TYPE,
  loadOrgGuidanceBlock,
  ORG_GUIDANCE_CHAR_BUDGET,
  ORG_GUIDANCE_TRUNCATION_MARKER,
} from '../../../utils/org-guidance';
import { primeMemberEventKinds } from '../../../utils/event-kind-validation';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { buildWorkspaceInstructions } from '../../../utils/workspace-instructions';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const env = {} as never;

describe('buildWorkspaceInstructions render fixes', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Render Org' });
    const sql = getTestDb();

    // Entity type with a description and a REAL JSON-Schema metadata_schema
    // (type/properties/required at the top level) with per-field descriptions.
    await sql`
      INSERT INTO entity_types (slug, name, description, metadata_schema, organization_id)
      VALUES (
        'product',
        'Product',
        'Products we track for resale',
        ${sql.json({
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Canonical product URL' },
            status: { type: 'string' },
          },
          required: ['url'],
        })},
        ${org.id}
      )
    `;

    // Legacy bare field-map schema (no top-level `type`/`properties`).
    await sql`
      INSERT INTO entity_types (slug, name, metadata_schema, organization_id)
      VALUES (
        'legacy',
        'Legacy',
        ${sql.json({ price: { type: 'number', description: 'Unit price in EUR' }, sku: {} })},
        ${org.id}
      )
    `;

    // Relationship type with a description.
    await sql`
      INSERT INTO entity_relationship_types (slug, name, description, organization_id)
      VALUES ('supplies', 'Supplies', 'Which company supplies which product', ${org.id})
    `;

    // Org-scoped connector definition with a description + an active connection.
    await sql`
      INSERT INTO connector_definitions (key, name, description, actions_schema, organization_id, status)
      VALUES (
        'shop.sync',
        'Shop Sync',
        'Order + inventory sync for the shop',
        ${sql.json({ list_orders: {}, refund_order: {} })},
        ${org.id},
        'active'
      )
    `;
    await createTestConnection({
      organization_id: org.id,
      connector_key: 'shop.sync',
      createDefaultFeed: false,
    });
  });

  it('renders entity type descriptions and per-field descriptions from metadata_schema.properties', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).not.toBeNull();
    expect(out).toContain(
      '- product ("Product") — Products we track for resale — fields: url (Canonical product URL), status'
    );
    // The old doubly-lossy render printed the JSON-Schema envelope keys.
    expect(out).not.toContain('fields: type, properties');
  });

  it('still renders legacy bare field-map schemas as field names (with descriptions)', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    // jsonb canonicalizes key order (shorter keys first): sku before price.
    expect(out).toContain('- legacy ("Legacy") — fields: sku, price (Unit price in EUR)');
  });

  it('renders relationship type descriptions', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('- supplies — Which company supplies which product');
  });

  it('renders connector definition descriptions', async () => {
    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain(
      '- shop.sync (Order + inventory sync for the shop): list_orders, refund_order'
    );
  });
});

describe('org-wide guidance context', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let ownerCtx: ToolContext;
  let memberCtx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    org = await createTestOrganization({ name: 'Guidance Org' });
    const owner = await createTestUser({ name: 'Owner' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    ownerCtx = ownerToolContext(org.id, owner.id);

    const member = await createTestUser({ name: 'Member' });
    await addUserToOrganization(member.id, org.id, 'member');
    memberCtx = { ...ownerToolContext(org.id, member.id), memberRole: 'member' };
  });

  it('rejects a non-admin member saving guidance (fail closed)', async () => {
    await expect(
      saveContent(
        { content: 'evil injected context', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
        env,
        memberCtx
      )
    ).rejects.toThrow(/owners\/admins/i);

    const out = await buildWorkspaceInstructions(org.id);
    expect(out).not.toContain('evil injected context');
  });

  it('rejects a system context (no member role) saving guidance', async () => {
    const systemCtx: ToolContext = { ...ownerCtx, userId: null, memberRole: null };
    await expect(
      saveContent(
        { content: 'system injected context', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
        env,
        systemCtx
      )
    ).rejects.toThrow(/owners\/admins/i);
  });

  it('injects admin-authored guidance into workspace instructions, near the top', async () => {
    const saved = (await saveContent(
      {
        title: 'Fiscal year',
        content: 'Our fiscal year starts in February.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      ownerCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);

    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('### Organization Context');
    expect(out).toContain('Our fiscal year starts in February.');
    // Near the top: before the schema section.
    const ctxIdx = out!.indexOf('### Organization Context');
    const schemaIdx = out!.indexOf('### Tool surface');
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeLessThan(schemaIdx);
  });

  it('backfills `guidance` into a pre-guidance $member registry so authorship still validates (#1913)', async () => {
    // Simulate an org provisioned before `guidance` was a built-in kind: a
    // populated $member.event_kinds registry that does NOT list `guidance`.
    // With `guidance` now validated through the registry (no code bypass), the
    // write would be rejected as an unknown kind unless ensureMemberEntityType
    // additively backfills the missing built-in on the next save.
    const sql = getTestDb();
    const preOrg = await createTestOrganization({ name: 'Pre-guidance Org' });
    const admin = await createTestUser({ name: 'Admin' });
    await addUserToOrganization(admin.id, preOrg.id, 'admin');
    const adminCtx = { ...ownerToolContext(preOrg.id, admin.id), memberRole: 'admin' };

    // Force the $member type to exist with a registry that omits `guidance`.
    await saveContent(
      { content: 'seed note', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    );
    await sql`
      UPDATE entity_types
      SET event_kinds = event_kinds - 'guidance'
      WHERE slug = '$member' AND organization_id = ${preOrg.id} AND deleted_at IS NULL
    `;
    const stripped = await sql<{ event_kinds: Record<string, unknown> }>`
      SELECT event_kinds FROM entity_types
      WHERE slug = '$member' AND organization_id = ${preOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    expect(stripped[0].event_kinds).not.toHaveProperty('guidance');

    // The very next guidance write must succeed: ensureMemberEntityType backfills
    // the missing built-in AND busts the stale validation cache in the same call.
    const saved = (await saveContent(
      {
        content: 'Backfilled guidance renders.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);

    const backfilled = await sql<{ event_kinds: Record<string, unknown> }>`
      SELECT event_kinds FROM entity_types
      WHERE slug = '$member' AND organization_id = ${preOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    expect(backfilled[0].event_kinds).toHaveProperty('guidance');

    const out = await buildWorkspaceInstructions(preOrg.id);
    expect(out).toContain('Backfilled guidance renders.');
  });

  it('re-primes a stale cache when another replica already backfilled guidance (#1913 cross-replica)', async () => {
    // Two-replica repro: pod A cached a pre-guidance $member registry; pod B
    // (or a migration) then added `guidance` to the DB row. On pod A the next
    // ensureMemberEntityType reads the fresh DB row, finds nothing to write, and
    // takes the no-op path — but it MUST still refresh its own stale cache, or
    // guidance saves on pod A are rejected until the 60s TTL expires.
    const sql = getTestDb();
    const raceOrg = await createTestOrganization({ name: 'Cross-replica Org' });
    const admin = await createTestUser({ name: 'Race Admin' });
    await addUserToOrganization(admin.id, raceOrg.id, 'admin');
    const adminCtx = { ...ownerToolContext(raceOrg.id, admin.id), memberRole: 'admin' };

    // Materialize a $member row that ALREADY contains guidance (as if pod B just
    // backfilled it), so ensureMemberEntityType has nothing to write and takes
    // the guarded no-op path — the exact path that must still prime from DB truth.
    await saveContent(
      { content: 'seed', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    );
    const before = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM entity_types
      WHERE slug = '$member' AND organization_id = ${raceOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;

    // Simulate pod A's stale per-pod cache: prime it with a registry missing
    // guidance. Without the fix, this stale value survives the no-op path.
    primeMemberEventKinds(raceOrg.id, { note: { description: 'General notes' } });

    // Pod A's ensureMemberEntityType runs (as it does at the top of every save):
    // it reads the DB (guidance present), writes nothing, and must re-prime from
    // the live row — not the snapshot it read before a hypothetical concurrent
    // backfill — via the atomic UPDATE ... UNION ALL read.
    await ensureMemberEntityType(raceOrg.id);

    // Prove the no-op path was taken: the guarded UPDATE did not fire, so the row
    // was NOT rewritten. (If it had, this would be the backfill path, not the
    // stale-cache-only path we mean to exercise.)
    const after = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM entity_types
      WHERE slug = '$member' AND organization_id = ${raceOrg.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    expect(after[0].updated_at.getTime()).toBe(before[0].updated_at.getTime());

    // The guidance save must now validate against the refreshed cache.
    const saved = (await saveContent(
      {
        content: 'Cross-replica guidance renders.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);

    const out = await buildWorkspaceInstructions(raceOrg.id);
    expect(out).toContain('Cross-replica guidance renders.');
  });

  it('backfills only guidance: preserves a concurrent add AND an intentional omission (#1913)', async () => {
    // The backfill adds ONLY the newly-required `guidance` kind, atomically
    // (`{guidance} || event_kinds`, live DB wins per key). It must therefore:
    //  - add `guidance` when missing;
    //  - preserve a kind a concurrent $member schema edit added (no clobber);
    //  - NOT resurrect a default kind the org intentionally REMOVED via
    //    manage_entity_schema (e.g. `todo`) — silently re-enabling it would
    //    override the org's choice.
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Concurrent-edit Org' });
    const admin = await createTestUser({ name: 'Concurrent Admin' });
    await addUserToOrganization(admin.id, org.id, 'admin');
    const adminCtx = { ...ownerToolContext(org.id, admin.id), memberRole: 'admin' };

    // Materialize $member, then: strip `guidance` (pre-guidance org), strip a
    // default the org chose to remove (`todo`), and add an org-authored kind.
    await saveContent(
      { content: 'seed', semantic_type: 'note', metadata: {} } as never,
      env,
      adminCtx
    );
    await sql`
      UPDATE entity_types
      SET event_kinds = (event_kinds - 'guidance' - 'todo')
        || '{"org_special": {"description": "authored by the org"}}'::jsonb
      WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL
    `;

    // Backfill runs (as at the top of every save).
    await ensureMemberEntityType(org.id);

    const after = await sql<{ event_kinds: Record<string, { description?: string }> }>`
      SELECT event_kinds FROM entity_types
      WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL
      LIMIT 1
    `;
    const kinds = after[0].event_kinds;
    // guidance backfilled…
    expect(kinds).toHaveProperty('guidance');
    // …the concurrently-authored kind is preserved (not clobbered)…
    expect(kinds.org_special?.description).toBe('authored by the org');
    // …and the intentionally-omitted default stays omitted (not resurrected).
    expect(kinds).not.toHaveProperty('todo');
  });

  it('supersede replaces guidance: only the current event renders', async () => {
    const v1 = (await saveContent(
      { content: 'All amounts are reported in USD.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      ownerCtx
    )) as { id: number };

    const v2 = (await saveContent(
      {
        content: 'All amounts are reported in EUR.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
        supersedes_event_id: v1.id,
      } as never,
      env,
      ownerCtx
    )) as { id: number };
    expect(v2.id).toBeGreaterThan(v1.id);

    const out = await buildWorkspaceInstructions(org.id);
    expect(out).toContain('All amounts are reported in EUR.');
    expect(out).not.toContain('All amounts are reported in USD.');
  });

  it('a deleted (tombstoned) guidance event does NOT render as a blank block', async () => {
    // Deletion here = supersede with an empty tombstone row (events is
    // append-only). The tombstone stamps superseded_by on the target, so the
    // canonical view (current_event_records) masks it. Regression guard: a
    // deleted guidance must not leave a titled-but-empty block behind.
    const tombOrg = await createTestOrganization({ name: 'Tombstone Org' });
    const owner = await createTestUser({ name: 'Tomb Owner' });
    await addUserToOrganization(owner.id, tombOrg.id, 'owner');
    const ctx = ownerToolContext(tombOrg.id, owner.id);

    const saved = (await saveContent(
      {
        title: 'Soon-deleted',
        content: 'This guidance is about to be deleted.',
        semantic_type: GUIDANCE_SEMANTIC_TYPE,
        metadata: {},
      } as never,
      env,
      ctx
    )) as { id: number };

    // Present before delete.
    expect(await loadOrgGuidanceBlock(tombOrg.id)).toContain(
      'This guidance is about to be deleted.'
    );

    // Real delete path: inserts an empty-payload tombstone that supersedes it.
    const del = (await deleteContent(
      { event_id: saved.id } as never,
      env,
      ctx
    )) as { tombstone_ids: number[] };
    expect(del.tombstone_ids.length).toBe(1);

    // Gone — not a blank block, not the old text, no dangling title.
    expect(await loadOrgGuidanceBlock(tombOrg.id)).toBeNull();
    const out = await buildWorkspaceInstructions(tombOrg.id);
    expect(out).not.toContain('This guidance is about to be deleted.');
    expect(out).not.toContain('Soon-deleted');
    expect(out).not.toContain('### Organization Context');
  });

  it('an empty/whitespace-payload guidance row never renders (payload guards)', async () => {
    // Defense-in-depth: even a row that carries semantic_type=guidance,
    // connection_id NULL, and a whitespace-only payload_text (not a NULL, so it
    // slips past the SQL `IS NOT NULL` filter) must be dropped by the trim
    // guard in loadOrgGuidanceBlock — no blank block, no dangling title.
    const emptyOrg = await createTestOrganization({ name: 'Empty Payload Org' });
    const sql = getTestDb();
    await sql`
      INSERT INTO events (
        entity_ids, origin_id, title, payload_type, payload_text,
        semantic_type, connection_id, organization_id, created_at
      ) VALUES (
        '{}'::bigint[], ${'empty-guidance-1'}, ${'Blank'}, 'text', ${'   \n  '},
        ${GUIDANCE_SEMANTIC_TYPE}, NULL, ${emptyOrg.id}, NOW()
      )
    `;

    expect(await loadOrgGuidanceBlock(emptyOrg.id)).toBeNull();
    const out = await buildWorkspaceInstructions(emptyOrg.id);
    expect(out).not.toContain('### Organization Context');
    expect(out).not.toContain('Blank');
  });

  it('rejects a member superseding admin guidance with a non-guidance kind', async () => {
    // The removal path: authorship is admin-gated, so a member must not be able
    // to erase guidance by superseding it with a permitted kind (e.g. note).
    const guarded = (await saveContent(
      { content: 'Protected org context.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      ownerCtx
    )) as { id: number };

    await expect(
      saveContent(
        {
          content: 'member overwrite attempt',
          semantic_type: 'note',
          metadata: {},
          supersedes_event_id: guarded.id,
        } as never,
        env,
        memberCtx
      )
    ).rejects.toThrow(/only organization owners\/admins/i);

    // Still present, still injected.
    expect(await loadOrgGuidanceBlock(org.id)).toContain('Protected org context.');
  });

  it('rejects a member deleting admin guidance', async () => {
    const guarded = (await saveContent(
      { content: 'Do not delete me.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      ownerCtx
    )) as { id: number };

    await expect(
      deleteContent({ event_id: guarded.id } as never, env, memberCtx)
    ).rejects.toThrow(/only organization owners\/admins/i);

    expect(await loadOrgGuidanceBlock(org.id)).toContain('Do not delete me.');
  });

  it('accepts an admin (not just owner) author', async () => {
    const admin = await createTestUser({ name: 'Admin' });
    await addUserToOrganization(admin.id, org.id, 'admin');
    const adminCtx: ToolContext = { ...ownerToolContext(org.id, admin.id), memberRole: 'admin' };
    const saved = (await saveContent(
      { content: 'Admins may also author org context.', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
      env,
      adminCtx
    )) as { id: number };
    expect(saved.id).toBeGreaterThan(0);
  });

  it('does NOT inject connector-sourced guidance events', async () => {
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'shop.sync2',
    });
    await createTestEvent({
      organization_id: org.id,
      connection_id: conn.id,
      semantic_type: GUIDANCE_SEMANTIC_TYPE,
      content: 'connector smuggled context',
    });

    const out = await buildWorkspaceInstructions(org.id);
    expect(out).not.toContain('connector smuggled context');
  });

  it('does NOT inject webhook-ingested guidance (connector_key set, connection_id NULL)', async () => {
    // webhook-ingest.ts writes connector_key='webhook:<id>' with a NULL
    // connection_id and a caller-configurable semantic_type. `connection_id IS
    // NULL` alone is NOT proof of admin authorship — the connector_key fence
    // must also exclude it, or a webhook token holder injects org-wide prompt text.
    const webhookOrg = await createTestOrganization({ name: 'Webhook Org' });
    const sql = getTestDb();
    await sql`
      INSERT INTO events (
        entity_ids, origin_id, title, payload_type, payload_text,
        semantic_type, connection_id, connector_key, organization_id, created_at
      ) VALUES (
        '{}'::bigint[], ${'wh-guidance-1'}, ${'Injected'}, 'text',
        ${'webhook injected org context'}, ${GUIDANCE_SEMANTIC_TYPE},
        NULL, ${'webhook:9999'}, ${webhookOrg.id}, NOW()
      )
    `;

    expect(await loadOrgGuidanceBlock(webhookOrg.id)).toBeNull();
    const out = await buildWorkspaceInstructions(webhookOrg.id);
    expect(out).not.toContain('webhook injected org context');
    expect(out).not.toContain('### Organization Context');
  });

  it('rejects non-text and empty-content guidance authorship', async () => {
    await expect(
      saveContent(
        {
          content: 'x',
          semantic_type: GUIDANCE_SEMANTIC_TYPE,
          payload_type: 'json_template',
          payload_template: { kind: 'text', text: 'x' },
          metadata: {},
        } as never,
        env,
        ownerCtx
      )
    ).rejects.toThrow(/'text' or 'markdown'/i);

    await expect(
      saveContent(
        { content: '   ', semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
        env,
        ownerCtx
      )
    ).rejects.toThrow(/non-empty content/i);
  });

  it('caps total injected guidance chars deterministically', async () => {
    // Use a fresh org so the cap math is exact.
    const capOrg = await createTestOrganization({ name: 'Cap Org' });
    const owner = await createTestUser({ name: 'Cap Owner' });
    await addUserToOrganization(owner.id, capOrg.id, 'owner');
    const ctx = ownerToolContext(capOrg.id, owner.id);

    for (const marker of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']) {
      await saveContent(
        {
          content: `${marker} ${'x'.repeat(1200)}`,
          semantic_type: GUIDANCE_SEMANTIC_TYPE,
          metadata: {},
        } as never,
        env,
        ctx
      );
    }

    const out = await buildWorkspaceInstructions(capOrg.id);
    expect(out).toContain('ALPHA');
    expect(out).toContain('BRAVO');
    // 4 x ~1206 chars > 3000: the tail must be cut and marked.
    expect(out).toContain(ORG_GUIDANCE_TRUNCATION_MARKER.trim());
    expect(out).not.toContain('DELTA');

    // The rendered guidance block (body + marker) stays WITHIN the declared cap
    // — the marker length is reserved, not appended past the budget.
    const block = await loadOrgGuidanceBlock(capOrg.id);
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(ORG_GUIDANCE_CHAR_BUDGET);
    expect(block!.endsWith(ORG_GUIDANCE_TRUNCATION_MARKER)).toBe(true);
    // Exactly one marker (no partial + duplicate).
    expect(block!.split(ORG_GUIDANCE_TRUNCATION_MARKER.trim()).length).toBe(2);

    // Deterministic: two builds render the identical block.
    const out2 = await buildWorkspaceInstructions(capOrg.id);
    expect(out2).toBe(out);
  });

  it('marks row-cap omission without exceeding the char cap or double-marking', async () => {
    // Many tiny guidance rows: under the char budget individually but over the
    // 100-row cap. Exercises the row-limit path — one marker, still within cap.
    const rowOrg = await createTestOrganization({ name: 'Row Cap Org' });
    const owner = await createTestUser({ name: 'Row Owner' });
    await addUserToOrganization(owner.id, rowOrg.id, 'owner');
    const ctx = ownerToolContext(rowOrg.id, owner.id);

    // 120 rows of ~5 chars each ≈ 600 chars total — well under 3000, but > 100 rows.
    for (let i = 0; i < 120; i++) {
      await saveContent(
        { content: `g${i}`, semantic_type: GUIDANCE_SEMANTIC_TYPE, metadata: {} } as never,
        env,
        ctx
      );
    }

    const block = await loadOrgGuidanceBlock(rowOrg.id);
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(ORG_GUIDANCE_CHAR_BUDGET);
    expect(block!.endsWith(ORG_GUIDANCE_TRUNCATION_MARKER)).toBe(true);
    expect(block!.split(ORG_GUIDANCE_TRUNCATION_MARKER.trim()).length).toBe(2);
  });
});
