/**
 * Integration: manage_entity_schema `get` returns authored TYPE-level list-view
 * templates under `view_templates`, with each template's `data_sources` run LIVE
 * (results on `template_data`, `data_sources` stripped from `json_template`).
 * This is what feeds the entity list-view switcher's custom (authored) views
 * alongside the built-in Table/Board/Gallery.
 *
 * DB-backed (real entity_types + view_template_active_tabs/versions); runs
 * against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { manageEntitySchema } from '../../../tools/admin/manage_entity_schema';
import { manageViewTemplates } from '../../../tools/admin/manage_view_templates';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

interface ViewTemplateTab {
  tab_name: string;
  tab_order: number;
  json_template: Record<string, unknown>;
  version: number;
  version_id: number;
  template_data: Record<string, unknown[]> | null;
}

describe('manage_entity_schema get → view_templates', () => {
  let ctx: ToolContext;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'View Template Get Org' });
    const user = await createTestUser({ email: 'view-get@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_by, created_at, updated_at)
      VALUES (${org.id}, 'ticket', 'Ticket', ${user.id}, NOW(), NOW())
    `;
    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:admin'],
    } as ToolContext;
  });

  async function getTemplates(): Promise<ViewTemplateTab[]> {
    const result = (await manageEntitySchema(
      { schema_type: 'entity_type', action: 'get', slug: 'ticket' } as never,
      {} as never,
      ctx
    )) as { entity_type: { view_templates?: ViewTemplateTab[] } | null };
    return result.entity_type?.view_templates ?? [];
  }

  it('returns [] when the type has no authored templates', async () => {
    expect(await getTemplates()).toEqual([]);
  });

  it('lists a named tab and runs its data_sources live', async () => {
    // A named tab (tab_name != null) = an authored list view. Its data source is
    // a plain read the executor scopes to the org; template_data carries results.
    await manageViewTemplates(
      {
        action: 'set',
        resource_type: 'entity_type',
        resource_id: 'ticket',
        tab_name: 'By owner',
        tab_order: 1,
        json_template: {
          type: 'div',
          children: [],
          // References a real core table so the executor's org-scoping CTE has
          // something to bind — a bare `SELECT 1` trips its parameter inference.
          data_sources: { tickets: { query: 'SELECT id, name FROM entities' } },
        },
      } as never,
      {} as never,
      ctx
    );

    const templates = await getTemplates();
    expect(templates).toHaveLength(1);
    const tab = templates[0];
    expect(tab.tab_name).toBe('By owner');
    expect(tab.tab_order).toBe(1);
    // data_sources stripped from the returned template; results on template_data.
    // The result set is empty (no entities seeded) but the KEY must exist — that
    // proves the data source ran and was collected, not that it silently failed.
    expect(tab.json_template.data_sources).toBeUndefined();
    expect(tab.template_data).not.toBeNull();
    expect(tab.template_data?.tickets).toEqual([]);
  });

  it('fails soft: a broken data source does not break get (bad source → empty)', async () => {
    // A query that passes authoring validation (allowlisted table) but references a
    // column that doesn't exist errors at EXECUTION time. executeDataSources isolates
    // each source, so the bad one resolves to [] rather than taking down the whole
    // get — the authored tab still appears alongside a working one. (This also
    // exercises fetchTypeViewTemplates' logger branch, whose identifiers must resolve.)
    await manageViewTemplates(
      {
        action: 'set',
        resource_type: 'entity_type',
        resource_id: 'ticket',
        tab_name: 'Broken',
        tab_order: 2,
        json_template: {
          type: 'div',
          children: [],
          data_sources: {
            boom: { query: 'SELECT no_such_column FROM entities' },
          },
        },
      } as never,
      {} as never,
      ctx
    );

    // Must not throw — get stays resilient to a bad authored data source.
    const templates = await getTemplates();
    const broken = templates.find((t) => t.tab_name === 'Broken');
    expect(broken).toBeDefined();
    expect(broken?.template_data?.boom).toEqual([]);
    // The good tab still resolves alongside the broken one.
    expect(templates.find((t) => t.tab_name === 'By owner')).toBeDefined();
  });

  it('round-trips a format directive verbatim (SDK-authored template → get)', async () => {
    // The SDK path (client.viewTemplates.set) and manage_view_templates store
    // json_template as opaque JSONB, so a (valid) `format` directive an SDK user
    // authors must survive set → get untouched, reaching the renderer's data
    // node. This is the contract the owletto format feature depends on.
    await manageViewTemplates(
      {
        action: 'set',
        resource_type: 'entity_type',
        resource_id: 'ticket',
        tab_name: 'Formatted',
        tab_order: 3,
        json_template: {
          type: 'div',
          children: [
            { type: 'data', path: 'x.amount', format: 'currency', fallback: '—' },
            { type: 'data', path: 'x.when', format: 'date' },
          ],
        },
      } as never,
      {} as never,
      ctx
    );

    const templates = await getTemplates();
    const formatted = templates.find((t) => t.tab_name === 'Formatted');
    expect(formatted).toBeDefined();
    const children = (formatted?.json_template as { children?: unknown[] })
      .children as Array<{ format?: string; path?: string; fallback?: string }>;
    // Directive survived verbatim — same keys the renderer's data node reads.
    expect(children[0]).toMatchObject({
      type: 'data',
      path: 'x.amount',
      format: 'currency',
      fallback: '—',
    });
    expect(children[1]).toMatchObject({ format: 'date', path: 'x.when' });
  });

  it('rejects a malformed template at set (fails fast, not at render)', async () => {
    // The set handler validates the DSL node tree. An unknown `format` (the exact
    // silent-render bug this guards) must be rejected at authoring — via the tool,
    // the API, and the SDK, which all funnel through this same handler.
    await expect(
      manageViewTemplates(
        {
          action: 'set',
          resource_type: 'entity_type',
          resource_id: 'ticket',
          tab_name: 'Bad',
          json_template: {
            type: 'div',
            children: [{ type: 'data', path: 'x', format: 'moneys' }],
          },
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/unknown format "moneys"/);

    // And a data node with no path is rejected too.
    await expect(
      manageViewTemplates(
        {
          action: 'set',
          resource_type: 'entity_type',
          resource_id: 'ticket',
          tab_name: 'Bad2',
          json_template: { type: 'each', items: 'xs', as: 'x' },
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/requires a `render`/);

    // Neither malformed tab was stored.
    const templates = await getTemplates();
    expect(templates.find((t) => t.tab_name === 'Bad')).toBeUndefined();
    expect(templates.find((t) => t.tab_name === 'Bad2')).toBeUndefined();
  });
});
