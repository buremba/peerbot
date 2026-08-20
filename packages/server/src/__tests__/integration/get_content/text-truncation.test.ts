/**
 * Query/listing reads truncate long text; an explicit event-id read returns
 * the full body.
 *
 * Event rows can carry arbitrarily large `payload_text` (scraped pages,
 * transcripts, big documents). Bulk reads bound row COUNT but used to ship
 * row BYTES whole, so a single oversized event flooded the model turn. These
 * guards make query/listing reads (automation window sources, non-automation
 * list/search, query_sql) truncate any text cell over ~4000 characters, and
 * keep the full body available only on the deliberate `content_ids` read.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnection,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const HEAD = 4_000;
const BIG_LEN = 5 * 1024 * 1024; // 5MB of characters

describe('read_knowledge text truncation', () => {
	let owner: TestApiClient;
	let orgId: string;
	let agentId: string;
	let entityId: number;
	let feedId: number;
	let hugeEventId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: 'Truncation Org' });
		orgId = org.id;
		const user = await createTestUser({ email: 'trunc@test.com' });
		await addUserToOrganization(user.id, org.id, 'owner');
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: 'owner',
		});
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		agentId = agent.agentId;

		const entity = await createTestEntity({
			name: 'Truncation Target',
			entity_type: 'company',
			organization_id: orgId,
			created_by: user.id,
		});
		entityId = Number(entity.id);

		const connection = await createTestConnection({
			organization_id: orgId,
			connector_key: 'test.connector',
			display_name: 'Truncation Source',
			slug: 'truncation-source',
		});
		const [feed] = await getTestDb()<{ id: number | string }[]>`
      SELECT id FROM feeds WHERE connection_id = ${connection.id} AND feed_key = 'default'
    `;
		feedId = Number(feed.id);

		const big = await createTestEvent({
			entity_id: entityId,
			organization_id: orgId,
			connection_id: connection.id,
			feed_id: feedId,
			content: 'A'.repeat(BIG_LEN),
			occurred_at: new Date(Date.now() - 1000),
		});
		hugeEventId = big.id;
		await createTestEvent({
			entity_id: entityId,
			organization_id: orgId,
			connection_id: connection.id,
			feed_id: feedId,
			content: 'small row',
			occurred_at: new Date(),
		});
	});

	async function automationWithDefaultSource(): Promise<string> {
		const created = (await owner.automations.create({
			entity_id: entityId,
			slug: `trunc-auto-${Math.random().toString(36).slice(2, 8)}`,
			name: 'Trunc Auto',
			prompt: 'Summarize {{content}}.',
			agent_id: agentId,
			sources: [{ name: 'content', query: `@feed:${feedId}` }],
		})) as { automation_id: string };
		return created.automation_id;
	}

	it('truncates a huge window-source row to the query head and reports its full length', async () => {
		const automationId = await automationWithDefaultSource();
		const result = (await owner.knowledge.read({
			automation_id: Number(automationId),
			since: 'today',
			until: 'today',
		})) as {
			content: Array<Record<string, unknown>>;
			sources: Record<string, unknown[]>;
		};

		const huge = result.content.find((r) => Number(r.id) === hugeEventId);
		expect(huge).toBeDefined();
		expect(huge?.payload_truncated).toBe(true);
		expect(huge?.content_length).toBe(BIG_LEN);
		expect((huge?.payload_text as string).length).toBeLessThan(HEAD * 2);
		expect((huge?.payload_text as string).endsWith('\u2026 [truncated]')).toBe(true);

		// The same rows flow through `sources` and are truncated too.
		const sourceHuge = (result.sources.content as Array<Record<string, unknown>>).find(
			(r) => Number(r.id) === hugeEventId
		);
		expect(sourceHuge?.payload_truncated).toBe(true);

		// A small companion row is untouched.
		const small = result.content.find((r) => Number(r.id) !== hugeEventId);
		expect(small?.payload_truncated).toBeUndefined();
		expect(small?.payload_text).toBe('small row');
	});

	it('returns the FULL body on an explicit event-id (content_ids) read', async () => {
		const result = (await owner.knowledge.read({
			content_ids: [hugeEventId],
		})) as Array<Record<string, unknown> | { content: Array<Record<string, unknown>> }>;

		const content = Array.isArray(result) ? result : result.content;
		const item = content.find((r) => Number(r.id) === hugeEventId);
		expect(item).toBeDefined();
		// No truncation on a deliberate single-event read.
		expect(item?.payload_truncated).toBeUndefined();
		expect((item?.payload_text as string).length).toBe(BIG_LEN);
	});

	it('truncates a non-automation listing that surfaces the huge event', async () => {
		const result = (await owner.knowledge.read({
			entity_id: entityId,
			limit: 50,
		})) as { content: Array<Record<string, unknown>> };

		const huge = result.content.find((r) => Number(r.id) === hugeEventId);
		expect(huge?.payload_truncated).toBe(true);
		expect((huge?.payload_text as string).length).toBeLessThan(HEAD * 2);
	});
});
