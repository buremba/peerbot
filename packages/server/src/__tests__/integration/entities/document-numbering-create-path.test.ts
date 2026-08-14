/**
 * Gapless document numbering through the REAL create path.
 *
 * `document-numbering-concurrency.test.ts` proves the allocator's locking
 * protocol in isolation. That is not enough: the allocator only delivers
 * gaplessness if it runs inside the SAME transaction as `INSERT INTO entities`.
 * Anything that allocates on a pool client — notably the entity mutation gate,
 * which runs on `getDb()` in a different transaction — commits the bump early
 * and burns the number when the insert fails.
 *
 * So this suite drives `client.entities.create(...)` (→ `manage_entity` →
 * `createEntity`), never the allocator, and asserts the four properties that
 * make a series auditable:
 *   1. the number is STAMPED on the created entity and readable back;
 *   2. concurrent creates yield no duplicates and no gaps;
 *   3. a create whose INSERT fails does NOT burn a number;
 *   4. a caller-supplied value is REJECTED, not silently overwritten.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import {
	applyEntityChangeProposal,
	type EntityCreateProposal,
	proposeEntityCreate,
} from "../../../tools/admin/entity-field-approval";
import type { ToolContext } from "../../../tools/registry";
import {
	derivePeriod,
	formatDocumentNumber,
	type NumberingSpec,
	parseNumberingSpec,
} from "../../../utils/document-numbering";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { TestApiClient } from "../../setup/test-mcp-client";

const INVOICE_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		invoice_no: { type: "string" },
		note: { type: "string" },
	},
	// NOTE: `invoice_no` is deliberately NOT in `required` — a server-assigned
	// field cannot be required of the caller, or every create fails metadata
	// validation before the allocator is ever reached.
	"x-numbering": {
		field: "invoice_no",
		reset: "year",
		padding: 6,
		timezone: "Europe/Istanbul",
	},
};

type CreateResult = {
	entity: { id: number; name: string; metadata?: Record<string, unknown> };
};

describe("document numbering via the entity create path", () => {
	let owner: TestApiClient;
	let organizationId: string;
	let ownerUserId: string;
	let entityTypeId: number;
	let spec: NumberingSpec;
	let period: string;
	const sql = getTestDb();

	const expectedNumber = (sequence: number) =>
		formatDocumentNumber(spec, period, sequence);

	const counterValue = async (): Promise<number> => {
		const rows = await sql<{ last_value: string | number }>`
      SELECT last_value FROM document_number_counters
      WHERE organization_id = ${organizationId}
        AND entity_type_id = ${entityTypeId}
        AND series = '' AND period = ${period}
    `;
		return Number(rows[0]?.last_value ?? 0);
	};

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Numbering Create Org" });
		organizationId = org.id;
		const ownerUser = await createTestUser({
			email: "numbering-create-owner@test.com",
		});
		ownerUserId = ownerUser.id;
		await addUserToOrganization(ownerUser.id, org.id, "owner");
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: ownerUser.id,
			memberRole: "owner",
		});

		// Created through the real schema tool, which stores metadata_schema
		// verbatim — this is also the proof that `x-numbering` survives the
		// public type-authoring surface rather than only a raw INSERT.
		await owner.entity_schema.createType({
			slug: "numbered-invoice",
			name: "Numbered Invoice",
			metadata_schema: INVOICE_SCHEMA,
		});

		const parsed = parseNumberingSpec(INVOICE_SCHEMA);
		if (!parsed) throw new Error("fixture schema must declare x-numbering");
		spec = parsed;
		period = derivePeriod(spec, new Date());

		const rows = await sql<{ id: number }>`
      SELECT id FROM entity_types
      WHERE organization_id = ${organizationId} AND slug = 'numbered-invoice'
    `;
		entityTypeId = Number(rows[0].id);

		// The declaration must actually have round-tripped through createType.
		const stored = await sql<{ metadata_schema: Record<string, unknown> }>`
      SELECT metadata_schema FROM entity_types WHERE id = ${entityTypeId}
    `;
		expect(parseNumberingSpec(stored[0].metadata_schema)).toEqual(spec);
	});

	it("stamps the allocated number onto the created entity", async () => {
		const created = (await owner.entities.create({
			type: "numbered-invoice",
			name: "First Invoice",
			metadata: { note: "opening balance" },
		})) as CreateResult;

		expect(created.entity.metadata?.invoice_no).toBe(expectedNumber(1));
		// Unrelated metadata is preserved, not clobbered by the stamp.
		expect(created.entity.metadata?.note).toBe("opening balance");

		// And it is durable — read back from the row, not the tool's response.
		const [row] = await sql<{ invoice_no: string | null }>`
      SELECT metadata->>'invoice_no' AS invoice_no
      FROM entities WHERE id = ${created.entity.id}
    `;
		expect(row.invoice_no).toBe(expectedNumber(1));
		expect(await counterValue()).toBe(1);

		// The tool's read surface agrees.
		const got = (await owner.entities.get({
			entity_id: created.entity.id,
		})) as { entity: { metadata?: Record<string, unknown> } };
		expect(got.entity.metadata?.invoice_no).toBe(expectedNumber(1));
	});

	it("issues no duplicates and no gaps under concurrent creates", async () => {
		const CONCURRENCY = 12;
		const before = await counterValue();

		const results = (await Promise.all(
			Array.from(
				{ length: CONCURRENCY },
				(_, i) =>
					owner.entities.create({
						type: "numbered-invoice",
						name: `Concurrent Invoice ${i}`,
						slug: `concurrent-invoice-${i}`,
					}) as Promise<CreateResult>,
			),
		)) as CreateResult[];

		const issued = results.map((r) => r.entity.metadata?.invoice_no as string);
		const expected = Array.from({ length: CONCURRENCY }, (_, i) =>
			expectedNumber(before + i + 1),
		);

		// A Set collapses duplicates; comparing the sorted sets to a contiguous
		// run therefore catches BOTH failure modes at once.
		expect(new Set(issued).size).toBe(CONCURRENCY);
		expect([...issued].sort()).toEqual([...expected].sort());
		expect(await counterValue()).toBe(before + CONCURRENCY);

		// The persisted rows carry the same run, so nothing was handed out and
		// then lost.
		const stored = await sql<{ invoice_no: string }>`
      SELECT metadata->>'invoice_no' AS invoice_no
      FROM entities
      WHERE organization_id = ${organizationId}
        AND entity_type_id = ${entityTypeId}
        AND metadata->>'invoice_no' IS NOT NULL
      ORDER BY metadata->>'invoice_no'
    `;
		expect(stored.map((r) => r.invoice_no)).toEqual(
			Array.from({ length: before + CONCURRENCY }, (_, i) =>
				expectedNumber(i + 1),
			),
		);
	});

	it("does not burn a number when the create rolls back", async () => {
		// A duplicate slug violates `entities_slug_parent_unique` INSIDE
		// createEntity's transaction — i.e. after the allocator has already
		// bumped the counter. This is the exact failure a pool-client allocation
		// would leak a gap through.
		await owner.entities.create({
			type: "numbered-invoice",
			name: "Slug Holder",
			slug: "numbering-rollback-collision",
		});
		const afterHolder = await counterValue();

		await expect(
			owner.entities.create({
				type: "numbered-invoice",
				name: "Doomed Invoice",
				slug: "numbering-rollback-collision",
			}),
		).rejects.toThrow(/already exists/i);

		// The failed create's bump was rolled back with its insert.
		expect(await counterValue()).toBe(afterHolder);

		// And the next successful create REUSES the number, rather than skipping it.
		const next = (await owner.entities.create({
			type: "numbered-invoice",
			name: "Recovered Invoice",
			slug: "numbering-rollback-recovered",
		})) as CreateResult;
		expect(next.entity.metadata?.invoice_no).toBe(
			expectedNumber(afterHolder + 1),
		);
		expect(await counterValue()).toBe(afterHolder + 1);
	});

	it("rejects a caller-supplied number instead of overwriting or accepting it", async () => {
		const before = await counterValue();

		await expect(
			owner.entities.create({
				type: "numbered-invoice",
				name: "Hand-numbered Invoice",
				metadata: { invoice_no: "2026-000999" },
			}),
		).rejects.toThrow(/assigned by the server/i);

		// Rejected at validation time: no entity, and no number consumed.
		expect(await counterValue()).toBe(before);
		const [{ count }] = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM entities
      WHERE organization_id = ${organizationId}
        AND metadata->>'invoice_no' = '2026-000999'
    `;
		expect(count).toBe(0);

		// An empty placeholder is "not supplied", so it is filled in normally.
		const created = (await owner.entities.create({
			type: "numbered-invoice",
			name: "Blank Placeholder Invoice",
			metadata: { invoice_no: "" },
		})) as CreateResult;
		expect(created.entity.metadata?.invoice_no).toBe(expectedNumber(before + 1));
	});

	it("allocates an approval-queued create at APPLY time, not at proposal time", async () => {
		// A deferred create must not consume a number while it sits in the queue:
		// if the reviewer rejects it, the number would be gone forever — a gap.
		// Structurally this holds because the defer branch of `handleCreate`
		// returns after queueing and only `applyEntityChangeProposal` reaches
		// `createEntity`; this asserts that structure rather than trusting it.
		const before = await counterValue();
		const agentCtx = {
			organizationId,
			agentId: "agent-numbering-approval",
			memberRole: "member",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: true,
		} as ToolContext;
		const payload: Omit<EntityCreateProposal, "operation"> = {
			entity_data: {
				entity_type: "numbered-invoice",
				name: "Queued Invoice",
				metadata: { note: "awaiting approval" },
			} as EntityCreateProposal["entity_data"],
			proposal: { entity_type: "numbered-invoice", name: "Queued Invoice" },
			attribution: "agent",
			reason: "Create Queued Invoice",
		};

		const rejected = await proposeEntityCreate(agentCtx, payload);
		expect(rejected.runId).toBeGreaterThan(0);
		// Proposing burned nothing — this proposal is now simply abandoned,
		// standing in for a reviewer rejecting it.
		expect(await counterValue()).toBe(before);

		const approverCtx = {
			organizationId,
			userId: ownerUserId,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: true,
		} as ToolContext;
		const applied = (await applyEntityChangeProposal(
			{ ...payload, operation: "create" },
			approverCtx,
			{ ENVIRONMENT: "test" } as Env,
			sql,
		)) as { metadata?: Record<string, unknown> };

		// The FIRST number after the abandoned proposal — not the second.
		expect(applied.metadata?.invoice_no).toBe(expectedNumber(before + 1));
		expect(await counterValue()).toBe(before + 1);
	});

	it("leaves types that declare no numbering untouched", async () => {
		await owner.entity_schema.createType({
			slug: "plain-note",
			name: "Plain Note",
			metadata_schema: {
				type: "object",
				properties: { invoice_no: { type: "string" } },
			},
		});

		const created = (await owner.entities.create({
			type: "plain-note",
			name: "Just a note",
			metadata: { invoice_no: "caller owns this" },
		})) as CreateResult;

		// No spec ⇒ no rejection, no stamp: the caller's value stands.
		expect(created.entity.metadata?.invoice_no).toBe("caller owns this");
		const [{ count }] = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM document_number_counters
      WHERE organization_id = ${organizationId}
        AND entity_type_id <> ${entityTypeId}
    `;
		expect(count).toBe(0);
	});
});
