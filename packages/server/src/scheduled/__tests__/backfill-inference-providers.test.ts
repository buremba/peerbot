/**
 * Integration test for the inference-provider backfill — the convergence step
 * the resolver cutover depends on (readOrgSharedProviderApiKey reads ONLY
 * inference_providers-backed vault names). Seeds legacy
 * `provider:<slug>:apiKey` secrets and asserts: row creation with the copied
 * ciphertext, idempotency, the freshness pass (a legacy rotation newer than
 * the row-unique copy is carried forward — and an older one is NOT), and the
 * invalid-slug stranding counter.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encrypt } from '@lobu/core';
import { getDb } from '../../db/client';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup';
import { readOrgSharedProviderApiKey } from '../../lobu/stores/provider-secrets';
import { backfillInferenceProviders } from '../backfill-inference-providers';

const ORG_ID = 'backfill-org';

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID})
    ON CONFLICT (id) DO NOTHING
  `;
});

async function seedLegacySecret(slug: string, value: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO agent_secrets (organization_id, name, ciphertext, created_at, updated_at)
    VALUES (${ORG_ID}, ${`provider:${slug}:apiKey`}, ${encrypt(value)}, now(), now())
    ON CONFLICT (organization_id, name)
    DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
  `;
}

describe('backfillInferenceProviders', () => {
  test('mints a row from a legacy secret; the cutover resolver reads the copied key', async () => {
    await seedLegacySecret('zorg', 'sk-legacy-1');

    const result = await backfillInferenceProviders();
    expect(result.created).toBe(1);
    expect(result.errors).toBe(0);

    const sql = getDb();
    const rows = (await sql`
      SELECT slug, kind, api_key_ref FROM inference_providers
      WHERE organization_id = ${ORG_ID} AND deleted_at IS NULL
    `) as Array<{ slug: string; kind: string; api_key_ref: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe('zorg');
    expect(rows[0]?.kind).toBe('zorg');
    expect(rows[0]?.api_key_ref.startsWith(`secret://${ORG_ID}/zorg-`)).toBe(
      true
    );

    // The post-cutover resolver tier resolves the SAME key the legacy row held.
    expect(await readOrgSharedProviderApiKey('zorg', ORG_ID)).toBe(
      'sk-legacy-1'
    );

    // Idempotent: a second pass creates nothing and freshens nothing.
    const again = await backfillInferenceProviders();
    expect(again.created).toBe(0);
    expect(again.freshened).toBe(0);
  });

  test('freshness pass carries a NEWER legacy rotation forward — never an older one', async () => {
    await seedLegacySecret('zorg', 'sk-legacy-1');
    await backfillInferenceProviders();

    const sql = getDb();
    // Simulate a rotation through the (now deleted) legacy route AFTER the
    // create pass: the legacy row becomes strictly newer than the copy.
    await sql`
      UPDATE agent_secrets
      SET updated_at = now() - interval '1 hour'
      WHERE organization_id = ${ORG_ID} AND name LIKE 'zorg-%'
    `;
    await sql`
      UPDATE agent_secrets
      SET ciphertext = ${encrypt('sk-rotated-2')}, updated_at = now()
      WHERE organization_id = ${ORG_ID} AND name = 'provider:zorg:apiKey'
    `;

    const result = await backfillInferenceProviders();
    expect(result.freshened).toBe(1);
    expect(await readOrgSharedProviderApiKey('zorg', ORG_ID)).toBe(
      'sk-rotated-2'
    );

    // The reverse direction must be a no-op: an OLDER legacy row never
    // clobbers a newer row-unique key.
    await sql`
      UPDATE agent_secrets
      SET updated_at = now() - interval '2 hours'
      WHERE organization_id = ${ORG_ID} AND name = 'provider:zorg:apiKey'
    `;
    const noop = await backfillInferenceProviders();
    expect(noop.freshened).toBe(0);
    expect(await readOrgSharedProviderApiKey('zorg', ORG_ID)).toBe(
      'sk-rotated-2'
    );
  });

  test('legacy names that are not valid slugs are counted, warned, and never minted', async () => {
    await seedLegacySecret('Bad_Slug', 'sk-unreachable');

    const result = await backfillInferenceProviders();
    expect(result.invalidSlug).toBe(1);
    expect(result.created).toBe(0);

    const sql = getDb();
    const rows = await sql`
      SELECT id FROM inference_providers
      WHERE organization_id = ${ORG_ID} AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(0);
  });
});
