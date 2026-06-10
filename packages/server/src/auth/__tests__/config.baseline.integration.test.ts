/**
 * Integration test for the global login-provider baseline.
 *
 * Reproduces the original symptom — an org-scoped login page (resolved from a
 * `/market/...` callback) returned `social: {}` while the default login page
 * showed Google/GitHub — and proves the fix: every deployment exposes the
 * baseline providers (those with env credentials) regardless of org context,
 * with no AUTH_DEFAULT_ORGANIZATION_SLUG pointer.
 *
 * Unlike config.test.ts, this does NOT mock the catalog or the DB: it scans the
 * real bundled connector catalog (via the prebuilt manifest) and uses the
 * embedded-Postgres test database. It therefore exercises the actual
 * catalog → collect → merge → credential-gate path end to end.
 */

import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDb } from '../../__tests__/setup/test-db';
import { createTestOrganization } from '../../__tests__/setup/test-fixtures';
import type { Env } from '../../index';
import {
  clearLoginProviderCachesForTests,
  getAuthConfig,
  getEnabledLoginProviderConfigs,
} from '../config';

// Point at the bundled connectors that ship a `.catalog-manifest.json`, so the
// scan is a fast manifest lookup instead of compiling every connector.
const DIST_CONNECTORS = resolve(__dirname, '../../../dist/connectors');

// Dummy credentials are enough: getAuthConfig only needs clientId + clientSecret
// to *resolve* for a provider to be marked enabled — it never calls the IdP here.
const ENV = {
  GOOGLE_CLIENT_ID: 'test-google-id',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  GITHUB_CLIENT_ID: 'test-github-id',
  GITHUB_CLIENT_SECRET: 'test-github-secret',
} as unknown as Env;

describe('login provider baseline (integration)', () => {
  let prevCatalogUris: string | undefined;

  beforeAll(() => {
    prevCatalogUris = process.env.CONNECTOR_CATALOG_URIS;
    process.env.CONNECTOR_CATALOG_URIS = DIST_CONNECTORS;
    clearLoginProviderCachesForTests();
  });

  afterAll(() => {
    if (prevCatalogUris === undefined) delete process.env.CONNECTOR_CATALOG_URIS;
    else process.env.CONNECTOR_CATALOG_URIS = prevCatalogUris;
    clearLoginProviderCachesForTests();
  });

  it('exposes baseline providers with no org context (the default login page)', async () => {
    const config = await getAuthConfig(ENV, { organizationId: null });
    expect(config.social.google).toBe(true);
    expect(config.social.github).toBe(true);
  });

  it('exposes the SAME baseline for an org with no login_enabled connectors (the /market case)', async () => {
    // An org id that has no rows in connector_definitions — exactly the state
    // that previously produced `social: {}`. It must now inherit the baseline.
    const config = await getAuthConfig(ENV, { organizationId: 'org-with-no-login-connectors' });
    expect(config.social.google).toBe(true);
    expect(config.social.github).toBe(true);
  });

  it('hides providers whose credentials are absent (no silent enable)', async () => {
    // Only Google creds present → GitHub must not appear.
    const googleOnly = {
      GOOGLE_CLIENT_ID: 'test-google-id',
      GOOGLE_CLIENT_SECRET: 'test-google-secret',
    } as unknown as Env;
    const config = await getAuthConfig(googleOnly, { organizationId: null });
    expect(config.social.google).toBe(true);
    expect(config.social.github).toBeUndefined();
  });

  it('unions an org-specific login connector on top of the baseline (real DB)', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    // A login-enabled connector for a provider NOT in the bundled catalog,
    // scoped to this org. It must be additive — baseline providers survive.
    await sql`
      INSERT INTO connector_definitions (key, name, version, auth_schema, organization_id, status, login_enabled, created_at, updated_at)
      VALUES (
        'acme.sso',
        'Acme SSO',
        '1.0.0',
        ${sql.json({ methods: [{ type: 'oauth', provider: 'acme', loginScopes: ['openid'] }] })},
        ${org.id},
        'active',
        true,
        NOW(), NOW()
      )
    `;
    clearLoginProviderCachesForTests();

    const providers = (await getEnabledLoginProviderConfigs(org.id)).map((c) => c.provider);
    expect(providers).toContain('acme'); // org-specific, additive
    expect(providers).toContain('google'); // baseline preserved
    expect(providers).toContain('github'); // baseline preserved
  });

  it('lets an org override a baseline provider with its own connector key (real DB)', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    // Org brings its own `google` login connector — it must shadow the baseline
    // google entry (same provider, org's connectorKey wins).
    await sql`
      INSERT INTO connector_definitions (key, name, version, auth_schema, organization_id, status, login_enabled, created_at, updated_at)
      VALUES (
        'org.google',
        'Org Google',
        '1.0.0',
        ${sql.json({ methods: [{ type: 'oauth', provider: 'google', loginScopes: ['openid', 'email'] }] })},
        ${org.id},
        'active',
        true,
        NOW(), NOW()
      )
    `;
    clearLoginProviderCachesForTests();

    const configs = await getEnabledLoginProviderConfigs(org.id);
    const google = configs.find((c) => c.provider === 'google');
    expect(google?.connectorKey).toBe('org.google');
  });
});
