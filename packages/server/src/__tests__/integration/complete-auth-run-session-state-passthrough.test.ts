/**
 * completeAuthRun session-state passthrough.
 *
 * Regression: an auth run can be linked to an `interactive` profile (the
 * reauthenticate / interactive-connection-setup pairing flow). Its returned
 * credentials are structured SESSION STATE (e.g. Baileys creds — nested
 * objects), which execution reads back verbatim as `sessionState` and never
 * resolves as `secret://` refs.
 *
 * The credential-at-rest change wraps ONLY flat bearer credentials (env,
 * oauth_account) in secret refs. Session-state kinds must pass through
 * unchanged: secret-ref'ing them would both strip their non-string values
 * (normalizeAuthValues keeps only strings) and leave unresolvable refs on the
 * worker.
 *
 * Green: an `interactive` profile completing an auth run keeps its nested
 * session state verbatim — no `secret://` refs, nothing dropped.
 */

import { parseSecretRef } from '@lobu/core';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { completeAuthRun } from '../../worker-api';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const CLAIMANT = 'worker-legit';

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    var: {},
    json: (b: unknown, status?: number) => {
      captured = { body: b, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

async function insertInteractiveProfile(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO auth_profiles
      (organization_id, slug, display_name, connector_key, profile_kind,
       status, auth_data, metadata, created_at, updated_at)
    VALUES
      (${organizationId}, 'wa-pairing', 'WhatsApp', 'whatsapp', 'interactive',
       'pending_auth', '{}'::jsonb, '{}'::jsonb, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertRunningAuthRun(
  organizationId: string,
  authProfileId: number
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, status, claimed_by, claimed_at,
       auth_profile_id, created_at)
    VALUES
      (${organizationId}, 'auth', 'running', ${CLAIMANT}, NOW(),
       ${authProfileId}, NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

describe('completeAuthRun session-state passthrough', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('stores interactive session state verbatim — no secret refs, nothing dropped', async () => {
    const org = await createTestOrganization();
    const profileId = await insertInteractiveProfile(org.id);
    const runId = await insertRunningAuthRun(org.id, profileId);
    const sql = getTestDb();

    // Baileys-style session state: nested objects + a flat string field. None
    // of this is a bearer credential the execution path resolves as a ref.
    const sessionState = {
      creds: { noiseKey: { private: 'abc', public: 'def' }, registered: true },
      account_id: '15551234567',
    };

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: CLAIMANT,
      status: 'success',
      credentials: sessionState,
      metadata: { paired: true },
    });
    await completeAuthRun(ctx);

    expect(result().body).toEqual({ success: true });

    const profile = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;

    // Passthrough: the whole session state survives intact (nested objects
    // preserved), and no value was converted into a secret:// ref.
    expect(profile[0].status).toBe('active');
    expect(profile[0].auth_data).toEqual(sessionState);
    expect(JSON.stringify(profile[0].auth_data)).not.toContain('secret://');
    expect(parseSecretRef(String(profile[0].auth_data.account_id))).toBeNull();
  });
});
