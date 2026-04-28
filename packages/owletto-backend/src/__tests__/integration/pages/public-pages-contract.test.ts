/**
 * Public page contract coverage.
 *
 * Focuses on the public/private boundary and crawlable HTML payloads without
 * restoring the old large page suite verbatim.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

const publicWebUrl = 'https://www.owletto.test';

describe('public page contract', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();

    const publicOrg = await createTestOrganization({
      name: 'Public Contract Org',
      slug: 'public-contract-org',
      description: 'Public knowledge workspace for contract tests.',
      visibility: 'public',
    });
    await createTestOrganization({
      name: 'Private Contract Org',
      slug: 'private-contract-org',
      visibility: 'private',
    });

    const user = await createTestUser({ email: 'public-contract@test.example.com' });
    await addUserToOrganization(user.id, publicOrg.id, 'owner');

    await sql`
      INSERT INTO entity_types (organization_id, slug, name, description, icon, created_at, updated_at)
      VALUES
        (${publicOrg.id}, 'brand', 'Brand', 'Tracked public brands', '🏢', NOW(), NOW()),
        (${publicOrg.id}, 'product', 'Product', 'Tracked public products', '📦', NOW(), NOW())
    `;

    const brand = await createTestEntity({
      name: 'Acme Brand',
      entity_type: 'brand',
      organization_id: publicOrg.id,
      created_by: user.id,
    });
    await createTestEntity({
      name: 'Acme Product',
      entity_type: 'product',
      organization_id: publicOrg.id,
      parent_id: brand.id,
      created_by: user.id,
    });
    await createTestEvent({
      entity_id: brand.id,
      title: 'Brand launch feedback',
      content: 'Customers describe Acme Brand as polished and reliable.',
      connector_key: 'contract.public',
    });
  });

  it('renders crawlable HTML and bootstrap data for a public workspace', async () => {
    const response = await get('/public-contract-org', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_WEB_URL: publicWebUrl },
    });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public, max-age=300');
    expect(body).toContain('Public Contract Org | Owletto');
    expect(body).toContain('window.__OWLETTO_PUBLIC_BOOTSTRAP__');
    expect(body).toContain('Tracked public brands');
    expect(body).toContain('Brand launch feedback');
  });

  it('renders public entity pages and real 404 HTML for missing pages', async () => {
    const entity = await get('/public-contract-org/brand/acme-brand', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_WEB_URL: publicWebUrl },
    });
    const entityBody = await entity.text();
    expect(entity.status).toBe(200);
    expect(entityBody).toContain('Acme Brand | Public Contract Org | Owletto');
    expect(entityBody).toContain(
      '<link rel="canonical" href="http://localhost/public-contract-org/brand/acme-brand" />'
    );

    const missing = await get('/public-contract-org/brand/missing-brand', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_WEB_URL: publicWebUrl },
    });
    const missingBody = await missing.text();
    expect(missing.status).toBe(404);
    expect(missingBody).toContain('Page Not Found');
    expect(missingBody).toContain('noindex,nofollow');
  });

  it('sitemap includes public routes and excludes private workspaces', async () => {
    const sitemap = await get('/sitemap.xml', { env: { PUBLIC_WEB_URL: publicWebUrl } });
    const sitemapXml = await sitemap.text();

    expect(sitemap.status).toBe(200);
    expect(sitemapXml).toContain('<loc>http://localhost/public-contract-org</loc>');
    expect(sitemapXml).toContain(
      '<loc>http://localhost/public-contract-org/brand/acme-brand</loc>'
    );
    expect(sitemapXml).not.toContain('private-contract-org');
  });
});
