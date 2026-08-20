/**
 * The trigger picker's route to platform events.
 *
 * `connection.deleted` and friends are declared by no entity type, so a picker
 * built from the union of `entity_types.event_kinds` — which is exactly how
 * Owletto builds it — can never list them. `manage_entity_schema` list
 * therefore carries them in a dedicated field.
 *
 * Dedicated rather than a synthetic `$platform` entity type on purpose: the
 * events tab builds its content-kind dropdown from the same list, and a pseudo
 * type would offer platform events as savable content kinds. Trigger surfaces
 * union this field in; content surfaces ignore it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { manageEntitySchema } from '../../../tools/admin/manage_entity_schema';
import { platformEventKinds } from '../../../automations/platform-event-catalog';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import type { ToolContext } from '../../../tools/registry';

describe('manage_entity_schema list exposes the platform event catalog', () => {
  let ctx: ToolContext;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Platform Kinds Org' });
    // Seed $member's built-in event_kinds so the leak guard below inspects a
    // real declared registry instead of an empty table.
    await ensureMemberEntityType(org.id);
    ctx = {
      organizationId: org.id,
      userId: null,
      memberRole: 'owner',
      isAuthenticated: true,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType: 'oauth',
      scopedToOrg: true,
      allowCrossOrg: false,
    } as unknown as ToolContext;
  });

  async function listResult() {
    return (await manageEntitySchema(
      { schema_type: 'entity_type', action: 'list' } as never,
      {} as never,
      ctx
    )) as {
      platform_event_kinds?: Record<string, { description: string }>;
      entity_types: Array<{ slug: string }>;
    };
  }

  it('returns the computed catalog, not a stored list', async () => {
    const result = await listResult();
    expect(result.platform_event_kinds).toEqual(platformEventKinds());
    // A representative platform type no entity type declares.
    expect(result.platform_event_kinds).toHaveProperty('connection.deleted');
  });

  it('does not leak the catalog into any entity type', async () => {
    const result = await listResult();
    // The guard that keeps the events tab honest: no returned entity type may
    // carry a platform key, or it becomes offerable as a savable content kind.
    const sql = getTestDb();
    const rows = (await sql`
      SELECT slug, event_kinds FROM entity_types WHERE event_kinds IS NOT NULL
    `) as unknown as Array<{
      slug: string;
      event_kinds: Record<string, unknown> | null;
    }>;
    // Vacuity guard: the seeded $member registry must be here, or the loop
    // below inspects nothing and proves nothing.
    expect(rows.length).toBeGreaterThan(0);
    const platformKeys = Object.keys(platformEventKinds());
    for (const row of rows) {
      for (const key of Object.keys(row.event_kinds ?? {})) {
        expect(platformKeys).not.toContain(key);
      }
    }
    // And no synthetic pseudo type was injected into the list.
    expect(result.entity_types.map((t) => t.slug)).not.toContain('$platform');
  });
});
