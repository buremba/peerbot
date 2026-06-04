/**
 * Integration test: server-side query-rewrite recall expansion in
 * `read_knowledge` / `getContent`.
 *
 * The recall gap this closes: a conversational/underspecified query embeds and
 * keyword-matches poorly, so the gold session ranks below the cutoff — and a
 * synonym gap ("physician") misses sessions that say "dermatologist". The LLM
 * query rewriter expands the raw query into focused keyword variants; the search
 * branch runs the RAW query first (preserving its ranking) and unions each
 * variant's rows deduped by event id. Purely additive: variants only surface
 * sessions the raw query missed.
 *
 * The benchmark adapter gets this lift by calling
 * read_knowledge({ rewrite_query: true }) — the recall improvement lives in the
 * SERVER (the product), not in adapter glue.
 *
 * Harness: vitest + embedded Postgres (real PG18 + pgvector), mirroring
 * get-content-visibility.test.ts. The LLM is stubbed at the FETCH boundary (not
 * vi.mock, which does not apply under the canonical full-suite runner): we swap
 * global.fetch for a counting stub that returns a canned chat-completions
 * payload for /chat/completions. No EMBEDDINGS_SERVICE_URL is configured, so
 * searchContentByText runs text-only (fulltext/trigram) and never calls fetch —
 * the only fetch calls in this file come from the query rewriter, which makes
 * the "no rewrite → no fetch" assertion exact.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const REWRITER_ENV: Env = {
  ENVIRONMENT: 'test',
  QUERY_REWRITER_API_KEY: 'test-key',
  QUERY_REWRITER_MODEL: 'gpt-4o-mini',
} as Env;

const NO_KEY_ENV: Env = {
  ENVIRONMENT: 'test',
} as Env;

// The variants the stubbed LLM "rewrites" the raw query into.
let cannedVariants: string[] = [];
let fetchCalls: string[] = [];
const realFetch = global.fetch;

function installFetchStub(): void {
  fetchCalls = [];
  global.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(url);
    if (url.includes('/chat/completions')) {
      const body = JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ queries: cannedVariants }) } },
        ],
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

describe('getContent > rewrite_query recall expansion', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  // The raw query "physician" matches this one via fulltext.
  let physicianEventId: number;
  // The raw query "physician" MISSES this (text says "dermatologist"); only a
  // rewritten variant "dermatologist" surfaces it.
  let dermatologistEventId: number;
  // Extra synonym sessions used to prove `limit` is respected under union.
  let entEventId: number;
  let specialistEventId: number;

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Query Rewrite Org' });
    user = await createTestUser({ email: 'rewrite@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entity = await createTestEntity({ name: 'Rewrite Entity', organization_id: org.id });

    physicianEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        content: 'I scheduled a checkup with my physician last Tuesday afternoon.',
      })
    ).id;

    dermatologistEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        content: 'The dermatologist recommended a new prescription for my skin condition.',
      })
    ).id;

    entEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        content: 'My ENT specialist looked at my recurring sinus problems again.',
      })
    ).id;

    specialistEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        content: 'The specialist ordered a follow-up scan for next month.',
      })
    ).id;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  beforeEach(() => {
    cannedVariants = [];
    installFetchStub();
  });

  it('(a) rewrite_query=true surfaces a session the raw query missed (recall improves)', async () => {
    // Baseline: the raw query "physician" finds the physician session but not the
    // dermatologist one (different keyword, no embeddings to bridge the synonym).
    const baseline = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50 } as never,
      NO_KEY_ENV as never,
      ctx()
    );
    const baselineIds = new Set(baseline.content.map((c) => c.id));
    expect(baselineIds.has(physicianEventId)).toBe(true);
    expect(baselineIds.has(dermatologistEventId)).toBe(false);
    expect(fetchCalls.length).toBe(0); // text-only, no embeddings/rewrite fetch

    // With rewrite_query, the LLM rewrites "physician" → ["dermatologist"],
    // whose results union in and surface the previously-missed session.
    cannedVariants = ['dermatologist'];
    const expanded = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50, rewrite_query: true } as never,
      REWRITER_ENV as never,
      ctx()
    );
    const expandedIds = new Set(expanded.content.map((c) => c.id));

    // Raw-query result preserved AND the missed session now appears.
    expect(expandedIds.has(physicianEventId)).toBe(true);
    expect(expandedIds.has(dermatologistEventId)).toBe(true);

    // The rewriter was actually consulted (exactly one chat/completions call).
    const rewriteCalls = fetchCalls.filter((u) => u.includes('/chat/completions'));
    expect(rewriteCalls.length).toBe(1);

    // Raw result ranks first (additive union preserves raw ordering).
    expect(expanded.content[0].id).toBe(physicianEventId);
  });

  it('(b) rewrite_query=false is identical to baseline — no rewrite, no fetch', async () => {
    cannedVariants = ['dermatologist']; // would expand IF rewrite ran
    const result = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50, rewrite_query: false } as never,
      REWRITER_ENV as never,
      ctx()
    );
    const ids = new Set(result.content.map((c) => c.id));

    expect(ids.has(physicianEventId)).toBe(true);
    expect(ids.has(dermatologistEventId)).toBe(false);
    // No rewrite path → zero fetch calls at all.
    expect(fetchCalls.length).toBe(0);
  });

  it('(c) no API key → graceful: raw query only, no crash, no rewrite fetch', async () => {
    cannedVariants = ['dermatologist'];
    const result = await getContent(
      // rewrite_query=true but the env has no QUERY_REWRITER_API_KEY.
      { entity_id: entity.id, query: 'physician', limit: 50, rewrite_query: true } as never,
      NO_KEY_ENV as never,
      ctx()
    );
    const ids = new Set(result.content.map((c) => c.id));

    expect(ids.has(physicianEventId)).toBe(true);
    expect(ids.has(dermatologistEventId)).toBe(false);
    // rewriteQueries() short-circuits on the missing key before any fetch.
    expect(fetchCalls.length).toBe(0);
  });

  it('(d) union never exceeds the caller-supplied limit', async () => {
    // Raw "physician" matches 1 session; variants would add 3 more synonym
    // sessions. With limit=2 the union must cap at 2 rows total.
    cannedVariants = ['dermatologist', 'ENT', 'specialist'];
    const result = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 2, rewrite_query: true } as never,
      REWRITER_ENV as never,
      ctx()
    );

    expect(result.content.length).toBeLessThanOrEqual(2);
    // Raw match is retained as the highest-priority row.
    expect(result.content.map((c) => c.id)).toContain(physicianEventId);

    // Sanity: the synonym sessions exist and a larger limit DOES pull extras in,
    // proving the cap above was the limiter (not a missing fixture).
    cannedVariants = ['dermatologist', 'ENT', 'specialist'];
    const wide = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50, rewrite_query: true } as never,
      REWRITER_ENV as never,
      ctx()
    );
    const wideIds = new Set(wide.content.map((c) => c.id));
    expect(wideIds.has(physicianEventId)).toBe(true);
    expect(wideIds.has(dermatologistEventId)).toBe(true);
    expect(wideIds.has(entEventId)).toBe(true);
    expect(wideIds.has(specialistEventId)).toBe(true);
  });
});
