/**
 * Integration test: chronological feed ordering is NULL- and future-safe.
 *
 * Prod bug (reported on /activity): the newest-first event feed pinned a
 * 9-day-old suggestion card to the top and then a wall of recurring Google
 * Calendar instances dated 30 years in the future. Two root causes:
 *
 *  1. NULL occurred_at. Postgres `ORDER BY occurred_at DESC` defaults to NULLS
 *     FIRST, so an event whose source timestamp was never recorded sorts as
 *     the newest regardless of age. The orderings now key on the EFFECTIVE
 *     occurrence time — COALESCE(occurred_at, created_at) — which is exactly
 *     what the API already surfaced for such rows, and the keyset cursor uses
 *     the same key so NULL rows stay reachable across pages.
 *  2. Future-dated events. A recurring series expanded a year ahead has
 *     `occurred_at > now()`, which is a scheduled item, not "activity", and it
 *     monopolized the first page. The chronological list now excludes
 *     not-yet-occurred events unless the caller explicitly asks for a future
 *     window via an `until` past now (or an `after` cursor past now).
 *
 * This file pins both: future events are absent from the default feed, NULL
 * occurred_at rows still surface but rank by their record time, an explicit
 * future `until` re-includes future events, and cursor pagination stays
 * consistent.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { pgBigintArray } from '../../../db/client';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('getContent > chronological feed ordering (NULL + future occurred_at)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  let futureFarId: number;
  let futureNearId: number;
  let recentId: number;
  let yesterdayId: number;
  let oldId: number;
  let nullOccurredId: number;

  let entityFutureId: number;
  let entityRecentId: number;
  let facetId: number;

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
    } as ToolContext;
  }

  async function insertNullOccurredEvent(opts: {
    organization_id: string;
    title: string;
    created_at: Date;
  }): Promise<number> {
    const sql = getTestDb();
    const rows = await sql`
      INSERT INTO events (organization_id, entity_ids, origin_id, title, payload_type,
                          payload_text, semantic_type, occurred_at, connector_key, created_at)
      VALUES (${opts.organization_id}, ${pgBigintArray([])}::bigint[],
              'null-occurred-' || floor(random() * 1000000)::int, ${opts.title}, 'text',
              ${opts.title}, 'content', NULL, 'test.connector', ${opts.created_at})
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Date Feed Ordering Org' });
    user = await createTestUser({ email: 'date-feed-order@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entity = await createTestEntity({
      name: 'Date Feed Ordering Entity',
      organization_id: org.id,
    });

    const now = Date.now();

    futureFarId = (
      await createTestEvent({
        organization_id: org.id,
        entity_ids: [],
        title: 'future far',
        content: 'far future recurring instance',
        occurred_at: new Date(now + 30 * DAY),
      })
    ).id;
    futureNearId = (
      await createTestEvent({
        organization_id: org.id,
        entity_ids: [],
        title: 'future near',
        content: 'later today',
        occurred_at: new Date(now + 2 * HOUR),
      })
    ).id;
    recentId = (
      await createTestEvent({
        organization_id: org.id,
        entity_ids: [],
        title: 'recent',
        content: 'an hour ago',
        occurred_at: new Date(now - HOUR),
      })
    ).id;
    yesterdayId = (
      await createTestEvent({
        organization_id: org.id,
        entity_ids: [],
        title: 'yesterday',
        content: 'a day ago',
        occurred_at: new Date(now - 26 * HOUR),
      })
    ).id;
    oldId = (
      await createTestEvent({
        organization_id: org.id,
        entity_ids: [],
        title: 'old',
        content: 'sixty days ago',
        occurred_at: new Date(now - 60 * DAY),
      })
    ).id;
    nullOccurredId = await insertNullOccurredEvent({
      organization_id: org.id,
      title: 'null occurred at',
      // A NULL occurred_at row ranks by its record time (COALESCE with
      // created_at). Pin it to 3 days ago so it sorts between `yesterday` and
      // `old` deterministically instead of at the top (the prod bug) or
      // dependent on insert order.
      created_at: new Date(now - 3 * DAY),
    });

    // Entity-scoped set, to pin the guard on the entity-link branch too.
    entityFutureId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'entity future',
        content: 'entity-scoped future instance',
        occurred_at: new Date(now + 7 * DAY),
      })
    ).id;
    entityRecentId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'entity recent',
        content: 'entity-scoped recent event',
        occurred_at: new Date(now - HOUR),
      })
    ).id;

    // Classify one future-dated and one recent event with the same facet, to
    // pin the classification-stats aggregate to the SAME future guard as the
    // list: the distribution over a wider set than the rows it labels is wrong.
    const sql = getTestDb();
    const [facet] = await sql<{ id: number }[]>`
      INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status,
                                  created_by, entity_ids, attribute_values, min_similarity)
      VALUES (${org.id}, 'order-kind', 'Order kind', 'order_kind', 'active', ${user.id},
              ARRAY[]::bigint[], ${sql.json({ alpha: { description: 'A', examples: [] } })}, 0.7)
      RETURNING id
    `;
    facetId = Number(facet.id);
    for (const eventId of [futureFarId, recentId]) {
      await sql`
        INSERT INTO event_classifications (event_id, classifier_id, watcher_id, window_id,
                                           "values", confidences, source, is_manual)
        VALUES (${eventId}, ${facetId}, NULL, NULL, ${'{alpha}'}::text[],
                ${sql.json({ alpha: 1 })}, 'user', true)
      `;
    }
  });

  it('default newest-first feed excludes future events and ranks NULL occurred_at by record time', async () => {
    const result = await getContent(
      { sort_by: 'date', sort_order: 'desc', limit: 100 } as never,
      {} as never,
      ctx()
    );
    const ids = result.content.map((item) => Number(item.id));
    const titles = result.content.map((item) => item.title);

    // Future-dated rows are not "activity" — excluded entirely.
    expect(ids).not.toContain(futureFarId);
    expect(ids).not.toContain(futureNearId);
    expect(ids).not.toContain(entityFutureId);

    // The NULL occurred_at row must still surface (real activity whose source
    // timestamp was never recorded) and rank by its record time (3 days ago),
    // not pin itself to the top of the feed.
    expect(ids).toContain(nullOccurredId);
    const nullIndex = titles.indexOf('null occurred at');
    expect(nullIndex).toBeGreaterThan(titles.indexOf('yesterday'));
    expect(nullIndex).toBeLessThan(titles.indexOf('old'));

    // Order is newest-first for dated rows.
    expect(titles.indexOf('recent')).toBeLessThan(titles.indexOf('yesterday'));
    expect(titles.indexOf('yesterday')).toBeLessThan(titles.indexOf('old'));
  });

  it('an explicit future `until` re-includes future-dated events, newest first', async () => {
    const until = new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10);
    const result = await getContent(
      { sort_by: 'date', sort_order: 'desc', limit: 100, until } as never,
      {} as never,
      ctx()
    );
    const ids = result.content.map((item) => Number(item.id));
    const titles = result.content.map((item) => item.title);

    expect(ids).toContain(futureFarId);
    expect(ids).toContain(futureNearId);
    // Future events rank as the newest now that they are in scope.
    expect(titles.indexOf('future far')).toBeLessThan(titles.indexOf('recent'));
    expect(titles.indexOf('future near')).toBeLessThan(titles.indexOf('recent'));
  });

  it('cursor pagination walks every non-future event exactly once', async () => {
    const collected: number[] = [];
    let beforeOccurredAt: string | null = null;
    let beforeId: number | null = null;

    for (let page = 0; page < 10; page++) {
      const result = await getContent(
        {
          sort_by: 'date',
          sort_order: 'desc',
          limit: 2,
          ...(beforeOccurredAt != null && beforeId != null
            ? { before_occurred_at: beforeOccurredAt, before_id: beforeId }
            : {}),
        } as never,
        {} as never,
        ctx()
      );
      for (const item of result.content) collected.push(Number(item.id));
      if (!result.page.has_older) break;
      const last = result.content[result.content.length - 1];
      beforeOccurredAt = last.occurred_at;
      beforeId = Number(last.id);
    }

    // The full walk is exactly the dated events + the NULL row (ranked by its
    // record time), no future row, and no duplicate (cursor drift would
    // duplicate or drop a row).
    expect(new Set(collected)).toEqual(
      new Set([recentId, yesterdayId, oldId, nullOccurredId, entityRecentId])
    );
    expect(collected).toHaveLength(5);
    expect(collected).not.toContain(futureFarId);
    expect(collected).not.toContain(futureNearId);
    expect(collected).not.toContain(entityFutureId);
  });

  it('entity-scoped feeds apply the same future guard', async () => {
    const result = await getContent(
      { entity_id: entity.id, sort_by: 'date', sort_order: 'desc', limit: 100 } as never,
      {} as never,
      ctx()
    );
    const ids = result.content.map((item) => Number(item.id));
    expect(ids).toContain(entityRecentId);
    expect(ids).not.toContain(entityFutureId);
  });

  it('classification stats apply the same future guard as the list', async () => {
    // The list excludes future-dated rows; the filter-chip distribution must
    // label the SAME set. `order-kind` is classified on the future row and the
    // recent row — a distribution over a wider set would count 2.
    const result = await getContent(
      {
        sort_by: 'date',
        sort_order: 'desc',
        limit: 100,
        include_classification: 'summary',
        classification_filters: { 'order-kind': ['alpha'] },
      } as never,
      {} as never,
      ctx()
    );

    const ids = result.content.map((item) => Number(item.id));
    expect(ids).toContain(recentId);
    expect(ids).not.toContain(futureFarId);

    const alpha = result.classification_stats?.['order-kind']?.['alpha'];
    expect(alpha).toBe(1);
  });
});
