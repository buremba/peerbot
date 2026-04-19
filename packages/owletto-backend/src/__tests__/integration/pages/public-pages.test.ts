import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('Public pages', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const sql = getTestDb();

    const publicOrg = await createTestOrganization({
      name: 'Public SEO Org',
      slug: 'public-seo-org',
      description: 'Public knowledge workspace for SEO tests.',
      visibility: 'public',
      logo: 'https://cdn.example.com/public-seo-org.png',
    });
    const privateOrg = await createTestOrganization({
      name: 'Private SEO Org',
      slug: 'private-seo-org',
      visibility: 'private',
    });

    const user = await createTestUser({ email: 'seo-owner@test.example.com' });
    await addUserToOrganization(user.id, publicOrg.id, 'owner');
    await addUserToOrganization(user.id, privateOrg.id, 'owner');

    await sql`
      INSERT INTO entity_types (
        organization_id, slug, name, description, icon, created_at, updated_at
      ) VALUES
        (${publicOrg.id}, 'brand', 'Brand', 'Tracked public brands', '🏢', NOW(), NOW()),
        (${publicOrg.id}, 'product', 'Product', 'Tracked public products', '📦', NOW(), NOW())
    `;

    const brand = await createTestEntity({
      name: 'Acme Brand',
      entity_type: 'brand',
      organization_id: publicOrg.id,
      created_by: user.id,
    });
    const product = await createTestEntity({
      name: 'Acme Product',
      entity_type: 'product',
      organization_id: publicOrg.id,
      parent_id: brand.id,
      created_by: user.id,
    });

    await createTestEvent({
      entity_id: brand.id,
      title: 'Brand launch feedback',
      content: 'Customers describe Acme Brand as polished, reliable, and easy to recommend.',
      connector_key: 'reddit.public',
    });

    await createTestEvent({
      entity_id: product.id,
      title: 'Product review roundup',
      content: 'Acme Product is getting strong public reviews for onboarding and reliability.',
      connector_key: 'github.public',
    });
  });

  it('renders public workspace HTML with SEO tags and bootstrap payload', async () => {
    const response = await get('/public-seo-org', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_WEB_URL: 'https://www.owletto.test' },
    });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('<meta name="description"');
    expect(body).toContain('Public SEO Org | Owletto');
    expect(body).toContain('window.__OWLETTO_PUBLIC_BOOTSTRAP__');
    expect(body).toContain('Tracked public brands');
    expect(body).toContain('Brand launch feedback');
  });

  it('renders public entity type pages with crawlable listing content', async () => {
    const response = await get('/public-seo-org/brand', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_WEB_URL: 'https://www.owletto.test' },
    });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('Brand | Public SEO Org | Owletto');
    expect(body).toContain('Acme Brand');
    expect(body).toContain('/public-seo-org/brand/acme-brand');
    expect(body).toContain('window.__OWLETTO_PUBLIC_BOOTSTRAP__');
  });

  it('renders public entity pages with canonical tags and recent knowledge', async () => {
    const response = await get('/public-seo-org/brand/acme-brand', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_WEB_URL: 'https://www.owletto.test' },
    });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('Acme Brand | Public SEO Org | Owletto');
    expect(body).toContain(
      '<link rel="canonical" href="https://www.owletto.test/public-seo-org/brand/acme-brand" />'
    );
    expect(body).toContain('Customers describe Acme Brand as polished');
    expect(body).toContain('Acme Product');
  });

  it('returns real 404 HTML for missing pages inside a public workspace', async () => {
    const response = await get('/public-seo-org/brand/missing-brand', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_WEB_URL: 'https://www.owletto.test' },
    });

    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).toContain('Page Not Found');
    expect(body).toContain('noindex,nofollow');
  });

  it('serves robots.txt and sitemap.xml from public route data only', async () => {
    const robots = await get('/robots.txt', {
      env: { PUBLIC_WEB_URL: 'https://www.owletto.test' },
    });
    const sitemap = await get('/sitemap.xml', {
      env: { PUBLIC_WEB_URL: 'https://www.owletto.test' },
    });

    const robotsText = await robots.text();
    const sitemapXml = await sitemap.text();

    expect(robots.status).toBe(200);
    expect(robotsText).toContain('Sitemap: https://www.owletto.test/sitemap.xml');

    expect(sitemap.status).toBe(200);
    expect(sitemapXml).toContain('<loc>https://www.owletto.test/public-seo-org</loc>');
    expect(sitemapXml).toContain('<loc>https://www.owletto.test/public-seo-org/brand</loc>');
    expect(sitemapXml).toContain(
      '<loc>https://www.owletto.test/public-seo-org/brand/acme-brand</loc>'
    );
    expect(sitemapXml).not.toContain('private-seo-org');
  });

  it('serves the SPA shell for auth login routes', async () => {
    const response = await get('/auth/login', {
      headers: { Accept: 'text/html' },
      env: { PUBLIC_WEB_URL: 'https://www.owletto.test' },
    });

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('<title>Owletto</title>');
    expect(body).toContain('<div id="root"></div>');
    expect(body).not.toContain('"mcp_endpoint"');
  });
});
