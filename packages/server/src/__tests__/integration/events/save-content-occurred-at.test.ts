/**
 * Integration test: save_content (save_memory / client.knowledge.save) stamps
 * `occurred_at` when the caller omits it.
 *
 * The tool schema has always promised "Defaults to now if omitted", but the
 * implementation passed NULL through to insertEvent. A NULL occurred_at makes
 * the event invisible to every watcher window (window content is an events CTE
 * filtered on occurred_at within [window_start, window_end)), so agent-saved
 * knowledge silently never reached watchers.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > occurred_at default', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entityId: number;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Occurred At Org' });
    user = await createTestUser({ email: 'occurred-at@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({
      name: 'Occurred At Entity',
      organization_id: org.id,
    });
    entityId = entity.id;
  });

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
      sourceContext: null,
    } as ToolContext;
  }

  it('defaults occurred_at to now when omitted', async () => {
    const before = Date.now();
    const result = (await saveContent(
      {
        entity_ids: [entityId],
        content: 'A note saved without an explicit occurred_at.',
        semantic_type: 'note',
        metadata: {},
      } as never,
      {} as never,
      ctx()
    )) as {
			id: number;
			indexing_status: string;
			exact_read: { method: string; content_ids: number[] };
		};

		expect(result.indexing_status).toBe('pending');
		// The hint must match knowledge.read's actual arg shape: `content_ids`
		// (array) — a singular `content_id` is rejected as an unknown argument.
		expect(result.exact_read).toEqual({
			method: 'client.knowledge.read',
			content_ids: [result.id],
		});

    const sql = getTestDb();
    const [row] = await sql`
      SELECT occurred_at FROM events WHERE id = ${result.id}
    `;
    expect(row.occurred_at).not.toBeNull();
    const occurredMs = new Date(row.occurred_at as string).getTime();
    expect(occurredMs).toBeGreaterThanOrEqual(before - 1000);
    expect(occurredMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('preserves an explicit occurred_at', async () => {
    const explicit = '2026-01-02T03:04:05.000Z';
    const result = (await saveContent(
      {
        entity_ids: [entityId],
        content: 'A note with an explicit occurred_at.',
        semantic_type: 'note',
        occurred_at: explicit,
        metadata: {},
      } as never,
      {} as never,
      ctx()
    )) as { id: number };

    const sql = getTestDb();
    const [row] = await sql`
      SELECT occurred_at FROM events WHERE id = ${result.id}
    `;
    expect(new Date(row.occurred_at as string).toISOString()).toBe(explicit);
  });

  it('stores a first-class reply edge and inherits the source URL', async () => {
    const parent = (await saveContent(
      {
        entity_ids: [entityId],
        content: 'Original LinkedIn post.',
        semantic_type: 'note',
        source_url: 'https://www.linkedin.com/feed/update/urn:li:activity:123',
        metadata: {},
      } as never,
      {} as never,
      ctx()
    )) as { id: number };

    const reply = (await saveContent(
      {
        entity_ids: [entityId],
        content: 'This matters because it is a concrete agent-infrastructure signal.',
        semantic_type: 'note',
        parent_event_id: parent.id,
        metadata: {},
      } as never,
      {} as never,
      ctx()
    )) as { id: number };

    const sql = getTestDb();
    const [row] = await sql`
      SELECT child.origin_parent_id, parent.origin_id AS expected_parent_origin_id,
             child.source_url
      FROM events child
      JOIN events parent ON parent.id = ${parent.id}
      WHERE child.id = ${reply.id}
    `;
    expect(row.origin_parent_id).toBe(row.expected_parent_origin_id);
    expect(row.source_url).toBe(
      'https://www.linkedin.com/feed/update/urn:li:activity:123'
    );
  });

  it('returns the original event for a repeated idempotency key', async () => {
    const input = {
      entity_ids: [entityId],
      content: 'A retry-safe Behavior reply.',
      semantic_type: 'note',
      idempotency_key: 'behavior:71:source:stable-post-1',
      metadata: { source_origin_id: 'stable-post-1' },
    } as never;

    const results = (await Promise.all(
      Array.from({ length: 6 }, () => saveContent(input, {} as never, ctx()))
    )) as Array<{ id: number }>;

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const sql = getTestDb();
    const [count] = await sql`
      SELECT count(*)::int AS n
      FROM events
      WHERE organization_id = ${org.id}
        AND metadata->>'_lobu_idempotency_key' = 'behavior:71:source:stable-post-1'
    `;
    expect(Number(count.n)).toBe(1);
  });

  it('does not let caller metadata set the reserved idempotency key', async () => {
    const metadata = {
      source_origin_id: 'caller-authored-post',
      _lobu_idempotency_key: 'caller-controlled-key',
    };

    const first = (await saveContent(
      {
        entity_ids: [entityId],
        content: 'First event with caller-authored metadata.',
        semantic_type: 'note',
        metadata,
      } as never,
      {} as never,
      ctx()
    )) as { id: number };
    const second = (await saveContent(
      {
        entity_ids: [entityId],
        content: 'Second event with the same caller-authored metadata.',
        semantic_type: 'note',
        metadata,
      } as never,
      {} as never,
      ctx()
    )) as { id: number };

    expect(second.id).not.toBe(first.id);
    const sql = getTestDb();
    const rows = await sql`
      SELECT metadata
      FROM events
      WHERE id IN (${first.id}, ${second.id})
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.metadata)).toEqual([
      { source_origin_id: 'caller-authored-post' },
      { source_origin_id: 'caller-authored-post' },
    ]);
  });
});
