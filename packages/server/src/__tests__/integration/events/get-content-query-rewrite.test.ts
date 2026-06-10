/**
 * Integration test: server-side query-rewrite recall expansion in
 * `read_knowledge` / `getContent`.
 *
 * The recall gap this closes: a conversational/underspecified query embeds and
 * keyword-matches poorly, so the gold session ranks below the cutoff — and a
 * synonym gap ("physician") misses sessions that say "dermatologist". The LLM
 * query rewriter expands the raw query into focused keyword variants; the search
 * branch runs raw + each variant with an over-fetched internal limit and FUSES
 * the candidates (max score per event id, re-ranked, caller's offset/limit
 * applied to the fused pool) — so a variant hit can displace a less-relevant
 * raw row into the top-k. Fusion only applies to score-sorted, non-cursor
 * searches; date feeds keep their ordering via the single-query path.
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
  global.fetch = (async (input: RequestInfo | URL) => {
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

  // Fusion / displacement fixtures (BUG-1 reproducer). The raw query
  // "appointment" matches several low-relevance filler sessions; a rewritten
  // variant "cardiologist" matches one short, highly-relevant session that must
  // displace a filler row INTO the top-k even when raw already filled the page.
  let cardiologistEventId: number;
  const fillerAppointmentEventIds: number[] = [];

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

    // Three filler sessions match the raw query "appointment" and fill a limit=3
    // page. Two contain the literal "appointment" (so the ranker's ILIKE
    // whole-query-substring boost applies → score ≈ 1.4). The first uses the
    // stem-only form "appoints" — it matches the english-tsquery for
    // "appointment" (both stem to "appoint") but NOT the ILIKE '%appointment%'
    // substring, so it forgoes that boost and scores LOW (≈ 0.4). That makes it
    // the deterministically weakest raw hit — the one a strong variant hit must
    // displace from the top-k.
    const fillerContents = [
      'I keep appoints lined up across many errands, groceries, laundry, emails, ' +
        'meetings and assorted chores that fill the whole long rambling busy day.',
      'Random note one: I had an appointment among errands, groceries, laundry, ' +
        'emails, meetings and chores that fill the whole long rambling busy day.',
      'Random note two: I had an appointment among errands, groceries, laundry, ' +
        'emails, meetings and chores that fill the whole long rambling busy day.',
    ];
    for (const content of fillerContents) {
      const id = (
        await createTestEvent({ organization_id: org.id, entity_id: entity.id, content })
      ).id;
      fillerAppointmentEventIds.push(id);
    }

    // A short, on-topic session for the variant term "cardiologist". It does NOT
    // contain "appointment", so the raw query misses it entirely; only the
    // variant surfaces it, and as the dominant token in a short doc it scores
    // HIGH — so fusion must promote it into the top-k, displacing a low-relevance
    // filler row.
    cardiologistEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        content: 'Cardiologist visit.',
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

    // Raw-query result preserved AND the missed session now appears (fusion pools
    // both queries' hits and re-ranks by relevance).
    expect(expandedIds.has(physicianEventId)).toBe(true);
    expect(expandedIds.has(dermatologistEventId)).toBe(true);

    // The rewriter was actually consulted (exactly one chat/completions call).
    const rewriteCalls = fetchCalls.filter((u) => u.includes('/chat/completions'));
    expect(rewriteCalls.length).toBe(1);
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

  it('(d) fusion never exceeds the caller-supplied limit (and flags has_more)', async () => {
    // Raw "physician" + variants match 4 distinct synonym sessions. With limit=2
    // the fused, re-ranked result must cap at 2 rows and report has_more.
    cannedVariants = ['dermatologist', 'ENT', 'specialist'];
    const result = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 2, rewrite_query: true } as never,
      REWRITER_ENV as never,
      ctx()
    );

    expect(result.content.length).toBe(2);
    expect(result.total).toBeGreaterThan(2); // pool had more distinct matches
    expect(result.page.has_more).toBe(true);

    // Sanity: the synonym sessions exist and a larger limit DOES pull them all in,
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

  it('(e) fusion pulls a more-relevant variant hit into a full top-k page (displaces filler)', async () => {
    // Baseline: with rewrite OFF, the raw query "appointment" returns a full
    // limit=3 page of low-relevance filler sessions and does NOT surface the
    // highly-relevant "Cardiologist appointment." session as the variant term.
    const baseline = await getContent(
      { entity_id: entity.id, query: 'appointment', limit: 3 } as never,
      NO_KEY_ENV as never,
      ctx()
    );
    const baselineIds = new Set(baseline.content.map((c) => c.id));
    // The raw page is full (3) and made entirely of filler; the cardiologist row
    // does not match "appointment" at all, so it is absent pre-rewrite.
    expect(baseline.content.length).toBe(3);
    for (const id of baselineIds) {
      expect(fillerAppointmentEventIds).toContain(id);
    }
    expect(baselineIds.has(cardiologistEventId)).toBe(false);

    // With rewrite ON, the variant "cardiologist" scores the short on-topic
    // session HIGH; fusion re-ranks across raw+variant and the cardiologist row
    // must now appear in the top-k even though raw already filled the page —
    // proving fusion (displacement), not fill-leftover-slots.
    cannedVariants = ['cardiologist'];
    const fused = await getContent(
      { entity_id: entity.id, query: 'appointment', limit: 3, rewrite_query: true } as never,
      REWRITER_ENV as never,
      ctx()
    );
    const fusedIds = new Set(fused.content.map((c) => c.id));

    expect(fused.content.length).toBe(3);
    expect(fusedIds.has(cardiologistEventId)).toBe(true);
    // The union held more distinct matches than the page → has_more is set.
    expect(fused.page.has_more).toBe(true);
    expect(fused.total).toBeGreaterThan(3);
  });

  it('(f) sort_by=date keeps chronological semantics — fusion is skipped entirely', async () => {
    // Fusion re-ranks by relevance, which would destroy a chronological feed.
    // With sort_by='date', rewrite_query must be inert: no rewriter call, and
    // the results come back date-ordered from the single-query path.
    cannedVariants = ['dermatologist'];
    const result = await getContent(
      {
        entity_id: entity.id,
        query: 'physician',
        limit: 50,
        rewrite_query: true,
        sort_by: 'date',
      } as never,
      REWRITER_ENV as never,
      ctx()
    );

    // No rewrite fetch happened (fusion ineligible under date sort)...
    expect(fetchCalls.filter((u) => u.includes('/chat/completions')).length).toBe(0);
    // ...so the variant-only session is absent,
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(dermatologistEventId)).toBe(false);
    // ...and the rows are in date order (desc by default).
    const dates = result.content.map((c) => new Date(c.occurred_at).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it('(g) offset pages through the FUSED ranking without overlap', async () => {
    // The fused pool for raw "physician" + 3 variants holds 4 distinct synonym
    // sessions. Page 1 (limit=2, offset=0) and page 2 (limit=2, offset=2) must
    // be disjoint and together equal the wide fused result's top-4 — proving the
    // caller's offset applies to the fused pool, not per internal query.
    cannedVariants = ['dermatologist', 'ENT', 'specialist'];
    const page1 = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 2, offset: 0, rewrite_query: true } as never,
      REWRITER_ENV as never,
      ctx()
    );
    cannedVariants = ['dermatologist', 'ENT', 'specialist'];
    const page2 = await getContent(
      { entity_id: entity.id, query: 'physician', limit: 2, offset: 2, rewrite_query: true } as never,
      REWRITER_ENV as never,
      ctx()
    );

    expect(page1.content.length).toBe(2);
    expect(page2.content.length).toBeGreaterThanOrEqual(1);
    const ids1 = new Set(page1.content.map((c) => c.id));
    for (const row of page2.content) {
      expect(ids1.has(row.id)).toBe(false); // disjoint pages
    }
    // Combined pages cover all 4 distinct synonym sessions.
    const combined = new Set([...page1.content, ...page2.content].map((c) => c.id));
    for (const id of [physicianEventId, dermatologistEventId, entEventId, specialistEventId]) {
      expect(combined.has(id)).toBe(true);
    }
  });
});
