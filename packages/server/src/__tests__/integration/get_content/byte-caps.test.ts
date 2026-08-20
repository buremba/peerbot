/**
 * Byte caps bound the payloads that enter a model turn.
 *
 * Event rows can carry arbitrarily large `payload_text` (scraped pages,
 * transcripts, big documents). Agent-facing read paths already bound row
 * COUNT (via `limit`/`sources_page`) but never row BYTES, so a single
 * oversized event flooded the turn while the rest of the window stayed small.
 *
 * These guards cover both asymmetry halves:
 * - Bulk reads (a window source, a non-automation listing) clamp each row to a
 *   small head (~4KB) and mark it `payload_truncated` with the full
 *   `content_length`, so the total window payload stays bounded regardless of
 *   what one row holds.
 * - A deliberate single-event lookup (`content_ids`) earns a large head
 *   (200KB) so the caller still gets a usable body, scaled down as the id
 *   count grows.
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

const BULK_CAP = 4_096;
const EXACT_CAP = 200_000;
const BIG_BYTES = 5 * 1024 * 1024; // 5MB — far past either cap.

describe('read_knowledge byte caps', () => {
	let owner: TestApiClient;
	let orgId: string;
	let agentId: string;
	let entityId: number;
	let feedId: number;
	let hugeEventId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: 'Byte Cap Org' });
		orgId = org.id;
		const user = await createTestUser({ email: 'byte-cap@test.com' });
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
			name: 'Byte Cap Target',
			entity_type: 'company',
			organization_id: orgId,
			created_by: user.id,
		});
		entityId = Number(entity.id);

		const connection = await createTestConnection({
			organization_id: orgId,
			connector_key: 'test.connector',
			display_name: 'Byte Cap Source',
			slug: 'byte-cap-source',
		});
		const [feed] = await getTestDb()<{ id: number | string }[]>`
      SELECT id FROM feeds WHERE connection_id = ${connection.id} AND feed_key = 'default'
    `;
		feedId = Number(feed.id);

		// The oversized fixture: a 5MB payload_text, plus a companion regular row
		// so window reads return >1 row and prove the clamp is per-row (the small
		// row stays intact while the big one is clamped).
		const big = await createTestEvent({
			entity_id: entityId,
			organization_id: orgId,
			connection_id: connection.id,
			feed_id: feedId,
			content: 'A'.repeat(BIG_BYTES),
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
			slug: `byte-cap-auto-${Math.random().toString(36).slice(2, 8)}`,
			name: 'Byte Cap Auto',
			prompt: 'Summarize {{content}}.',
			agent_id: agentId,
			sources: [{ name: 'content', query: `@feed:${feedId}` }],
		})) as { automation_id: string };
		return created.automation_id;
	}

	it('clamps a huge window-source row to the bulk cap and marks it', async () => {
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
		// The oversized row must NOT come back whole.
		expect(typeof huge?.payload_text).toBe('string');
		expect((huge?.payload_text as string).length).toBeLessThan(BULK_CAP * 2);
		expect(huge?.payload_truncated).toBe(true);
		// The full original character count survives so a caller can decide to page.
		expect(huge?.content_length).toBe(BIG_BYTES);
		// The synthetic trigger source is empty here, but the authored source
		// must be clamped too (the same rows flow through `sources`).
		const sourceRows = result.sources.content as Array<Record<string, unknown>>;
		const sourceHuge = sourceRows.find((r) => Number(r.id) === hugeEventId);
		expect(sourceHuge?.payload_truncated).toBe(true);

		// The companion small row is untouched by the clamp.
		const small = result.content.find((r) => Number(r.id) !== hugeEventId);
		expect(small?.payload_truncated).toBeUndefined();
		expect(small?.payload_text).toBe('small row');
	});

	it('serves the large head to a deliberate single-event content_ids lookup', async () => {
		const result = (await owner.knowledge.read({
			content_ids: [hugeEventId],
		})) as {
			content: Array<Record<string, unknown>>;
		};

		const item = result.content[0];
		expect(item).toBeDefined();
		expect(Number(item.id)).toBe(hugeEventId);
		// The 200KB head is far larger than the bulk cap but still finite.
		expect((item.payload_text as string).length).toBeLessThan(EXACT_CAP * 2);
		expect((item.payload_text as string).length).toBeGreaterThan(BULK_CAP);
		expect(item.payload_truncated).toBe(true);
		expect(item.content_length).toBe(BIG_BYTES);
	});

	it('clamps exact automation trigger-inputs to the scaled head', async () => {
		const automationId = await automationWithDefaultSource();
		const result = (await owner.knowledge.read({
			automation_id: Number(automationId),
			content_ids: [hugeEventId],
			since: 'today',
			until: 'today',
		})) as {
			content: Array<Record<string, unknown>>;
			sources: Record<string, unknown[]>;
		};

		// The trigger input arrives as the `__event_inputs` source.
		const triggerRows = result.sources.__event_inputs as Array<Record<string, unknown>>;
		const huge = triggerRows.find((r) => Number(r.id) === hugeEventId);
		expect(huge).toBeDefined();
		expect(huge?.payload_truncated).toBe(true);
		expect((huge?.payload_text as string).length).toBeGreaterThan(BULK_CAP);
		expect(huge?.content_length).toBe(BIG_BYTES);

		// The AVOIDANCE assertion: a single trigger input must NOT be squeezed to
		// the bulk cap — that would defeat the deliberate read.
		expect((huge?.payload_text as string).length).toBeGreaterThanOrEqual(
			Math.min(EXACT_CAP, 300_000) - BULK_CAP
		);
	});
});
