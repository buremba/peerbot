/**
 * Data Sources Integration Tests
 *
 * Tests for SQL data sources in JSON view templates.
 * Verifies org-scoping, CTE rewriting, security boundaries, and end-to-end execution.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Data Sources in View Templates', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let org2: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let user2: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let brandEntity: Awaited<ReturnType<typeof createTestEntity>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    // Org 1 — main test org
    org = await createTestOrganization({ name: 'DS Test Org', slug: 'ds-test' });
    user = await createTestUser({ email: 'ds-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    // Org 2 — separate org for isolation tests
    org2 = await createTestOrganization({ name: 'Other Org', slug: 'other-org' });
    user2 = await createTestUser({ email: 'other-user@test.com' });
    await addUserToOrganization(user2.id, org2.id, 'owner');
    const client2 = await createTestOAuthClient();
    await createTestAccessToken(user2.id, org2.id, client2.client_id);

    // Create entities in org 1
    brandEntity = await createTestEntity({
      name: 'Acme Corp',
      entity_type: 'brand',
      organization_id: org.id,
      created_by: user.id,
    });

    await createTestEntity({
      name: 'Acme Widget',
      entity_type: 'product',
      organization_id: org.id,
      parent_id: brandEntity.id,
      created_by: user.id,
    });

    // Create entities in org 2
    await createTestEntity({
      name: 'Other Brand',
      entity_type: 'brand',
      organization_id: org2.id,
      created_by: user2.id,
    });

    // Create events linked to org 1 brand
    await createTestEvent({
      entity_id: brandEntity.id,
      content: 'Event for Acme Corp',
      title: 'Acme News',
    });
    await createTestEvent({
      entity_id: brandEntity.id,
      content: 'Second event for Acme Corp',
      title: 'Acme Update',
    });
  });

  // ============================================
  // Template set + resolve_path round-trip
  // ============================================

  describe('basic data source execution', () => {
    it('should execute a simple entity count query via entity template', async () => {
      // Set an entity template with data_sources
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              stats: {
                query: 'SELECT count(*) as entity_count FROM entities',
              },
            },
            type: 'div',
            children: [{ type: 'metric', label: 'Entities', value: '{{stats.0.entity_count}}' }],
          },
        },
        { token }
      );

      // Resolve the path — should include template_data
      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      expect(result.entity).toBeDefined();
      expect(result.entity.template_data).toBeDefined();
      expect(result.entity.template_data.stats).toBeDefined();
      expect(result.entity.template_data.stats).toBeInstanceOf(Array);
      expect(result.entity.template_data.stats.length).toBeGreaterThan(0);
      expect(Number(result.entity.template_data.stats[0].entity_count)).toBeGreaterThan(0);

      // data_sources should be stripped from the returned json_template
      expect(result.entity.json_template).toBeDefined();
      expect(result.entity.json_template.data_sources).toBeUndefined();
      expect(result.entity.json_template.type).toBe('div');
    });

    it('should execute data sources on entity templates', async () => {
      // Set an entity-level template (not entity-type, since system types can't be modified)
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              event_count: {
                query: 'SELECT count(*) as n FROM events WHERE {{entityId}} = ANY(entity_ids)',
              },
            },
            type: 'div',
            children: [{ type: 'metric', label: 'Events', value: '{{event_count.0.n}}' }],
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      expect(result.entity).toBeDefined();
      expect(result.entity.template_data).toBeDefined();
      expect(result.entity.template_data.event_count).toBeInstanceOf(Array);
      expect(Number(result.entity.template_data.event_count[0].n)).toBe(2);
    });

    it('should execute data sources on tab templates', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          tab_name: 'Analytics',
          json_template: {
            data_sources: {
              brands: {
                query: "SELECT name FROM entities WHERE entity_type = 'brand'",
              },
            },
            type: 'table',
            data: '{{brands}}',
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      const analyticsTab = result.entity.tabs.find(
        (t: { tab_name: string }) => t.tab_name === 'Analytics'
      );
      expect(analyticsTab).toBeDefined();
      expect(analyticsTab.template_data).toBeDefined();
      expect(analyticsTab.template_data.brands).toBeInstanceOf(Array);
      expect(analyticsTab.template_data.brands.length).toBeGreaterThan(0);

      // data_sources stripped from tab template too
      expect(analyticsTab.json_template.data_sources).toBeUndefined();
    });
  });

  // ============================================
  // Entity type as virtual table
  // ============================================

  describe('entity type virtual tables', () => {
    it('should treat unknown table names as entity type slugs', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              brands: { query: 'SELECT name FROM brand' },
              products: { query: 'SELECT name FROM product' },
            },
            type: 'div',
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      expect(result.entity.template_data.brands).toBeInstanceOf(Array);
      expect(result.entity.template_data.brands.length).toBe(1);
      expect(result.entity.template_data.brands[0].name).toBe('Acme Corp');

      expect(result.entity.template_data.products).toBeInstanceOf(Array);
      expect(result.entity.template_data.products.length).toBe(1);
      expect(result.entity.template_data.products[0].name).toBe('Acme Widget');
    });
  });

  // ============================================
  // Organization isolation (security)
  // ============================================

  describe('organization isolation', () => {
    it('should only return data from the same organization', async () => {
      // Org 1 has 1 brand ("Acme Corp"), org 2 has 1 brand ("Other Brand")
      // Template on org 1 should only see org 1's brand
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              all_entities: { query: 'SELECT name, entity_type FROM entities' },
            },
            type: 'div',
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      const entities = result.entity.template_data.all_entities;
      expect(entities).toBeInstanceOf(Array);

      // Should only have org 1's entities, NOT org 2's "Other Brand"
      const names = entities.map((e: { name: string }) => e.name);
      expect(names).toContain('Acme Corp');
      expect(names).toContain('Acme Widget');
      expect(names).not.toContain('Other Brand');
    });

    it('should scope events to the organization', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              all_events: { query: 'SELECT title FROM events' },
            },
            type: 'div',
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      const events = result.entity.template_data.all_events;
      expect(events).toBeInstanceOf(Array);
      // All events should belong to org 1's entities
      for (const ev of events) {
        expect(ev.title).toMatch(/Acme/);
      }
    });
  });

  // ============================================
  // Security: blocked queries
  // ============================================

  describe('query security validation', () => {
    it('should reject schema-qualified table references at save time', async () => {
      await expect(
        mcpToolsCall(
          'manage_view_templates',
          {
            action: 'set',
            resource_type: 'entity',
            resource_id: brandEntity.id,
            json_template: {
              data_sources: {
                bad: { query: 'SELECT * FROM public.entities' },
              },
              type: 'div',
            },
          },
          { token }
        )
      ).rejects.toThrow(/[Ss]chema-qualified/);
    });

    it('should reject pg_catalog access', async () => {
      await expect(
        mcpToolsCall(
          'manage_view_templates',
          {
            action: 'set',
            resource_type: 'entity',
            resource_id: brandEntity.id,
            json_template: {
              data_sources: {
                bad: { query: 'SELECT * FROM pg_catalog.pg_roles' },
              },
              type: 'div',
            },
          },
          { token }
        )
      ).rejects.toThrow(/[Ss]chema-qualified/);
    });

    it('should reject queries that do not start with SELECT or WITH', async () => {
      await expect(
        mcpToolsCall(
          'manage_view_templates',
          {
            action: 'set',
            resource_type: 'entity',
            resource_id: brandEntity.id,
            json_template: {
              data_sources: {
                bad: { query: 'DELETE FROM entities' },
              },
              type: 'div',
            },
          },
          { token }
        )
      ).rejects.toThrow(/SELECT or WITH/);
    });

    it('should reject COPY operations', async () => {
      await expect(
        mcpToolsCall(
          'manage_view_templates',
          {
            action: 'set',
            resource_type: 'entity',
            resource_id: brandEntity.id,
            json_template: {
              data_sources: {
                bad: {
                  query: "SELECT 1; COPY entities TO '/tmp/dump.csv'",
                },
              },
              type: 'div',
            },
          },
          { token }
        )
      ).rejects.toThrow(/forbidden/i);
    });

    it('should reject positional parameters in queries', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              bad: { query: 'SELECT * FROM entities WHERE id = $1' },
            },
            type: 'div',
          },
        },
        { token }
      );

      // The save succeeds (positional params are only checked at execution time)
      // but resolve_path should gracefully handle the error (empty result)
      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      // Should get empty array due to execution error
      expect(result.entity.template_data.bad).toEqual([]);
    });
  });

  // ============================================
  // WITH clause support
  // ============================================

  describe('WITH clause support', () => {
    it('should handle user queries with WITH clauses', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              with_query: {
                query:
                  "WITH brands AS (SELECT * FROM entities WHERE entity_type = 'brand') " +
                  'SELECT count(*) as n FROM brands',
              },
            },
            type: 'div',
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      expect(result.entity.template_data.with_query).toBeInstanceOf(Array);
      expect(Number(result.entity.template_data.with_query[0].n)).toBe(1);
    });
  });

  // ============================================
  // Query parameter support
  // ============================================

  describe('query parameters', () => {
    it('should substitute {{query.X}} with URL query param values', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              filtered: {
                query: 'SELECT name FROM entities WHERE entity_type = {{query.type}}',
              },
            },
            type: 'div',
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp?type=brand` },
        { token }
      );

      expect(result.entity.template_data.filtered).toBeInstanceOf(Array);
      expect(result.entity.template_data.filtered.length).toBe(1);
      expect(result.entity.template_data.filtered[0].name).toBe('Acme Corp');
    });

    it('should pass NULL for missing query params', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              filtered: {
                query:
                  'SELECT name FROM entities WHERE ({{query.type}} IS NULL OR entity_type = {{query.type}})',
              },
            },
            type: 'div',
          },
        },
        { token }
      );

      // Without query param — should return all entities (NULL IS NULL = true)
      // Expect 3: brand + product + member entity auto-created by addUserToOrganization trigger
      const all = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );
      expect(all.entity.template_data.filtered.length).toBe(3);

      // With query param — should filter
      const filtered = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp?type=product` },
        { token }
      );
      expect(filtered.entity.template_data.filtered.length).toBe(1);
      expect(filtered.entity.template_data.filtered[0].name).toBe('Acme Widget');
    });

    it('should parameterize query values (no SQL injection)', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              safe: {
                query: 'SELECT name FROM entities WHERE entity_type = {{query.type}}',
              },
            },
            type: 'div',
          },
        },
        { token }
      );

      // Attempt injection — should be treated as a literal string value, returning 0 rows
      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp?type=brand' OR '1'='1` },
        { token }
      );

      expect(result.entity.template_data.safe).toEqual([]);
    });
  });

  // ============================================
  // Error handling
  // ============================================

  describe('error handling', () => {
    it('should return empty array for data sources with SQL errors', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            data_sources: {
              good: { query: 'SELECT count(*) as n FROM entities' },
              bad: { query: 'SELECT * FROM entities WHERE nonexistent_column = 1' },
            },
            type: 'div',
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      // Good query should still work
      expect(result.entity.template_data.good).toBeInstanceOf(Array);
      expect(Number(result.entity.template_data.good[0].n)).toBeGreaterThan(0);

      // Bad query should return empty (not crash everything)
      expect(result.entity.template_data.bad).toEqual([]);
    });

    it('should return null template_data when no data_sources defined', async () => {
      await mcpToolsCall(
        'manage_view_templates',
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: brandEntity.id,
          json_template: {
            type: 'div',
            children: [{ type: 'text', value: 'No data sources' }],
          },
        },
        { token }
      );

      const result = await mcpToolsCall(
        'resolve_path',
        { path: `/${org.slug}/brand/acme-corp` },
        { token }
      );

      expect(result.entity.template_data).toBeNull();
      expect(result.entity.json_template.type).toBe('div');
    });
  });
});
