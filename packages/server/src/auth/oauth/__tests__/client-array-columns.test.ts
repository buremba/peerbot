/**
 * Repro probe: `oauth_clients` array columns must reach callers as arrays.
 *
 * The gateway pool runs with `fetch_types: false`, so postgres.js hands back
 * `text[]` columns as the raw literal `{a,b}` — a STRING. `toOAuthClient`
 * passed those through while declaring them `string[]`, so the type lied and
 * every consumer silently got a string.
 *
 * Two consequences, one cosmetic and one not:
 *   - `redirectUris.join(...)` threw in the web UI (measured against prod
 *     2026-07-31: `"{https://claude.ai/api/mcp/auth_callback}"`)
 *   - `client.redirect_uris.includes(candidate)` in the authorize path
 *     degraded from array membership to SUBSTRING matching, so a candidate
 *     that merely appears inside the stored literal was accepted. Same for
 *     `grant_types.includes('authorization_code')`.
 *
 * `parsePgTextArray` already existed in `db/client.ts`; the boundary just
 * never called it.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../../gateway/__tests__/helpers/db-setup.js';

const CLIENT = 'mcp_client_arraycols';

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

async function seed(): Promise<void> {
  const { getDb } = await import('../../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO oauth_clients (
      id, client_name, redirect_uris, grant_types, response_types, contacts
    ) VALUES (
      ${CLIENT}, 'Array Cols',
      ARRAY['https://app.example.com/callback', 'https://alt.example.com/cb']::text[],
      ARRAY['authorization_code', 'refresh_token']::text[],
      ARRAY['code']::text[],
      ARRAY['ops@example.com']::text[]
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function loadClient() {
  const { getDb } = await import('../../../db/client.js');
  const { OAuthClientsStore } = await import('../clients.js');
  return new OAuthClientsStore(getDb()).getClient(CLIENT);
}

describe('oauth_clients array columns', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seed();
  });

  test('array columns arrive as arrays, not Postgres literals', async () => {
    const client = await loadClient();
    expect(client).toBeTruthy();

    expect(Array.isArray(client?.redirect_uris)).toBe(true);
    expect(client?.redirect_uris).toEqual([
      'https://app.example.com/callback',
      'https://alt.example.com/cb',
    ]);
    expect(client?.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(client?.response_types).toEqual(['code']);
    expect(client?.contacts).toEqual(['ops@example.com']);
  });

  test('redirect-uri membership is exact, not substring', async () => {
    const client = await loadClient();

    // Every one of these is a substring of the raw literal
    // `{https://app.example.com/callback,https://alt.example.com/cb}` and so
    // passed `.includes()` while the value was still a string.
    for (const forged of [
      'https://app.example.com/call',
      'app.example.com/callback',
      'com/callback,https://alt.example.com',
      '{https://app.example.com/callback',
    ]) {
      expect(client?.redirect_uris.includes(forged)).toBe(false);
    }

    // `toContain` on an array is exact element membership, so this stays a
    // real membership assertion (and does not read as URL substring matching).
    expect(client?.redirect_uris).toContain('https://app.example.com/callback');
  });

  test('grant-type membership is exact, not substring', async () => {
    const client = await loadClient();

    expect(client?.grant_types?.includes('authorization_cod')).toBe(false);
    expect(client?.grant_types?.includes('authorization_code')).toBe(true);
  });
});
