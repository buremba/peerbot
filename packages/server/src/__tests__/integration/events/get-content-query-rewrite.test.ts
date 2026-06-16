/**
 * Integration test: auto on-miss query-rewrite recall rescue in
 * `read_knowledge` / `getContent`.
 *
 * There is no longer a `rewrite_query` param. Instead, when a score-sorted text
 * query returns NOTHING on the first page, the search path treats the raw
 * phrasing as too conversational/underspecified, expands it into LLM-rewritten
 * keyword variants, and fuses their hits. The rescue fires ONLY on a total
 * miss, so any query that already found something pays no extra LLM call — that
 * is the behaviour this file pins down:
 *   - miss  → rewriter consulted, variant hits recovered
 *   - hit   → rewriter NEVER consulted (no fetch), result unchanged
 *   - no key / date sort / offset>0 → rescue skipped, graceful
 *
 * Harness: vitest + embedded Postgres (real PG18 + pgvector), mirroring
 * get-content-visibility.test.ts. The LLM is stubbed at the FETCH boundary: we
 * swap global.fetch for a counting stub that returns a canned chat-completions
 * payload for /chat/completions. No EMBEDDINGS_SERVICE_URL is configured, so
 * searchContentByText runs text-only (fulltext/trigram) and never calls fetch —
 * the only fetch calls in this file come from the query rewriter, which makes
 * the "found something → no fetch" assertion exact.
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
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(url);
    if (url.includes('/chat/completions')) {
      const body = JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ queries: cannedVariants }) } }],
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

const rewriteCalls = () => fetchCalls.filter((u) => u.includes('/chat/completions'));

describe('getContent > auto on-miss recall rescue', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  // NOTE: there is deliberately NO event containing the word "physician", so the
  // raw query "physician" is a guaranteed total miss → it is the trigger that
  // drives the on-miss rescue. The synonym sessions below are only reachable via
  // a rewritten variant.
  let dermatologistEventId: number;
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

    org = await createTestOrganization({ name: 'Recall Rescue Org' });
    user = await createTestUser({ email: 'rescue@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entity = await createTestEntity({ name: 'Rescue Entity', organization_id: org.id });

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

  it('(a) a total miss triggers the rescue and recovers a variant-only session', async () => {
    // Confirm the trigger: the raw query "physician" matches nothing.
    const miss = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50 } as never,
      NO_KEY_ENV as never,
      ctx()
    );
    expect(miss.content.length).toBe(0);
    expect(fetchCalls.length).toBe(0); // text-only path, no fetch at all

    // With a rewriter key present, the same raw miss expands "physician" →
    // ["dermatologist"] and the previously-unreachable session is recovered.
    cannedVariants = ['dermatologist'];
    const rescued = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50 } as never,
      REWRITER_ENV as never,
      ctx()
    );
    const ids = new Set(rescued.content.map((c) => c.id));
    expect(ids.has(dermatologistEventId)).toBe(true);
    // The rewriter was consulted exactly once.
    expect(rewriteCalls().length).toBe(1);
  });

  it('(b) a query that finds something NEVER consults the rewriter (common case is free)', async () => {
    // "dermatologist" matches the dermatologist session directly, so the first
    // page is non-empty → the rescue must not fire, even with a key + variants
    // staged that WOULD expand if it ran.
    cannedVariants = ['specialist', 'ENT'];
    const result = await getContent(
      { entity_id: entity.id, query: 'dermatologist', limit: 50 } as never,
      REWRITER_ENV as never,
      ctx()
    );
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(dermatologistEventId)).toBe(true);
    // No miss → zero rewriter calls. This is the whole point of on-miss.
    expect(rewriteCalls().length).toBe(0);
  });

  it('(c) miss with no API key is graceful: empty result, no crash, no fetch', async () => {
    cannedVariants = ['dermatologist']; // would recover IF the rewriter ran
    const result = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50 } as never,
      NO_KEY_ENV as never,
      ctx()
    );
    expect(result.content.length).toBe(0);
    // rewriteQueries() short-circuits on the missing key before any fetch.
    expect(fetchCalls.length).toBe(0);
  });

  it('(d) rescue fusion never exceeds the caller-supplied limit (and flags has_more)', async () => {
    cannedVariants = ['dermatologist', 'ENT', 'specialist'];
    const result = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 2 } as never,
      REWRITER_ENV as never,
      ctx()
    );
    expect(result.content.length).toBe(2);
    expect(result.total).toBeGreaterThan(2); // pool had more distinct matches
    expect(result.page.has_more).toBe(true);

    // A larger limit pulls all three synonym sessions in, proving the cap above
    // was the limiter, not a missing fixture.
    cannedVariants = ['dermatologist', 'ENT', 'specialist'];
    const wide = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50 } as never,
      REWRITER_ENV as never,
      ctx()
    );
    const wideIds = new Set(wide.content.map((c) => c.id));
    expect(wideIds.has(dermatologistEventId)).toBe(true);
    expect(wideIds.has(entEventId)).toBe(true);
    expect(wideIds.has(specialistEventId)).toBe(true);
  });

  it('(e) sort_by=date skips the rescue entirely (no rewriter call)', async () => {
    // Fusion re-ranks by relevance, which would destroy a chronological feed, so
    // the rescue is inert under date sort even on a miss.
    cannedVariants = ['dermatologist'];
    const result = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 50, sort_by: 'date' } as never,
      REWRITER_ENV as never,
      ctx()
    );
    expect(rewriteCalls().length).toBe(0);
    expect(result.content.length).toBe(0);
  });

  it('(f) an empty page at offset>0 does NOT trigger the rescue (only a first-page miss)', async () => {
    // offset>0 returning empty means "paged past the end", not "found nothing" —
    // it must not fire an LLM expansion.
    cannedVariants = ['dermatologist'];
    const result = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 2, offset: 2 } as never,
      REWRITER_ENV as never,
      ctx()
    );
    expect(result.content.length).toBe(0);
    expect(rewriteCalls().length).toBe(0);
  });
});
