/**
 * Compact resolve_path route contract.
 *
 * Keeps the important behavior from the old broad page tests while using the
 * reusable MCP client/session helper introduced in this PR.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient } from '../../setup/test-mcp-client';

interface Fixture {
  orgSlug: string;
  token: string;
}

async function seedFixture(): Promise<Fixture> {
  const org = await createTestOrganization({ name: 'Resolve Contract Org', slug: 'resolve-contract' });
  const user = await createTestUser({ email: 'resolve-contract@test.example.com' });
  await addUserToOrganization(user.id, org.id, 'owner');

  const api = await TestApiClient.for({
    organizationId: org.id,
    userId: user.id,
    memberRole: 'owner',
  });
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES
      (${org.id}, 'brand', 'Brand', NOW(), NOW()),
      (${org.id}, 'product', 'Product', NOW(), NOW())
  `;
  // A typed entity type WITH a metadata_schema (no view template declared) —
  // exercises the auto-default rendering tail.
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
    VALUES (
      ${org.id}, 'deal', 'Deal',
      ${sql.json({
        type: 'object',
        properties: {
          stage: { title: 'Deal Stage', 'x-table-column': 1 },
          amount: { 'x-table-column': 2 },
        },
      })},
      NOW(), NOW()
    )
  `;

  const brand = (await api.entities.create({ type: 'brand', name: 'Acme Brand' })) as {
    entity: { id: number };
  };
  await api.entities.create({
    type: 'product',
    name: 'Acme Product',
    parent_id: brand.entity.id,
  });
  await api.entities.create({
    type: 'deal',
    name: 'Acme Deal',
    metadata: { stage: 'negotiation', amount: 50000 },
  });

  const oauthClient = await createTestOAuthClient();
  const token = (await createTestAccessToken(user.id, org.id, oauthClient.client_id)).token;
  return { orgSlug: org.slug, token };
}

async function resolvePath(fixture: Fixture, args: Record<string, unknown>) {
  const response = await post(`/api/${fixture.orgSlug}/resolve_path`, {
    body: args,
    token: fixture.token,
  });
  if (response.status >= 400) {
    const body = (await response.json()) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json();
}

describe('resolve_path contract', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    await cleanupTestDatabase();
    fixture = await seedFixture();
  });

  it('resolves workspace and nested entity paths', async () => {
    const workspace = (await resolvePath(fixture, { path: `/${fixture.orgSlug}` })) as {
      workspace?: { slug: string };
    };
    expect(workspace.workspace?.slug).toBe(fixture.orgSlug);

    const nested = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}/brand/acme-brand/product/acme-product`,
    })) as { entity?: { name: string } };
    expect(nested.entity?.name).toBe('Acme Product');
  });

  it('auto-generates a default json_template from metadata_schema when none is declared', async () => {
    const resolved = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}/deal/acme-deal`,
    })) as { entity?: { json_template?: Record<string, unknown> | null } };

    const template = resolved.entity?.json_template;
    expect(template).toBeTruthy();
    // The root node is a card, and each schema field is data-bound by key.
    const serialized = JSON.stringify(template);
    expect(template?.type).toBe('card');
    expect(serialized).toContain('"path":"stage"');
    expect(serialized).toContain('"path":"amount"');
    expect(serialized).toContain('Deal Stage');
  });

  it('does not synthesize a template for a type without metadata_schema', async () => {
    const resolved = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}/brand/acme-brand`,
    })) as { entity?: { json_template?: Record<string, unknown> | null } };
    expect(resolved.entity?.json_template ?? null).toBeNull();
  });

  it('rejects malformed or missing paths instead of silently falling back', async () => {
    await expect(resolvePath(fixture, { path: `/${fixture.orgSlug}/brand` })).rejects.toThrow();
    await expect(
      resolvePath(fixture, { path: `/${fixture.orgSlug}/brand/missing-brand` })
    ).rejects.toThrow();
  });

  it('returns bootstrap only when requested', async () => {
    const withoutBootstrap = (await resolvePath(fixture, { path: `/${fixture.orgSlug}` })) as {
      bootstrap?: unknown;
    };
    expect(withoutBootstrap.bootstrap).toBeNull();

    const withBootstrap = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}`,
      include_bootstrap: true,
    })) as { bootstrap?: { entity_types?: unknown[] } };
    expect(withBootstrap.bootstrap?.entity_types?.length).toBeGreaterThan(0);
  });
});
