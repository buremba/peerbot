/**
 * Promoting a Behavior run into a reusable eval case, and replaying it.
 *
 * The load-bearing claims here are that a case is a POINTER (not a copy of the
 * dispatch payload, which would be free to drift from the run it replays), that
 * promote and replay agree on what "replayable" means, and that the identity
 * claim makes a repeat promote resolve to the existing case.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import {
	EVAL_CASE_NAMESPACE,
	promoteEvalCase,
	replayEvalCase,
} from "../../../runs/eval-cases";
import { EVAL_CASE_ENTITY_TYPE_SLUG } from "../../../tools/constants";
import { BEHAVIOR_EVAL_RUN_TYPE } from "../../../runs/run-types";

const sql = getTestDb();

let organizationId: string;
let behaviorId: number;
let sourceRunId: number;
/** A run the eval lanes could never claim — device-pinned. */
let devicePinnedRunId: number;

const payload = {
	watcher_id: 0,
	agent_id: "11111111-2222-3333-4444-555555555555",
	window_start: "2026-08-01T00:00:00.000Z",
	window_end: "2026-08-01T01:00:00.000Z",
	dispatch_source: "scheduled",
	version_id: 42,
};

async function insertBehaviorRun(
	extraPayload: Record<string, unknown>,
): Promise<number> {
	const [run] = await sql<{ id: number }[]>`
    INSERT INTO runs (
      organization_id, run_type, watcher_id, approval_status, status,
      approved_input, completed_at, created_at
    ) VALUES (
      ${organizationId}, 'behavior', ${behaviorId}, 'auto', 'completed',
      ${sql.json({ ...payload, watcher_id: behaviorId, ...extraPayload })},
      current_timestamp, current_timestamp
    )
    RETURNING id
  `;
	return run.id;
}

beforeAll(async () => {
	// See eval-run-capture.test.ts: Behavior ids come from a MAX(id)+1 helper,
	// so a Behavior created by an earlier file leaves the sequence behind.
	await cleanupTestDatabase();

	const org = await createTestOrganization();
	organizationId = org.id;
	const creator = await createTestUser();
	// resolveEntityCreator falls back to an org owner/admin, and
	// entities.created_by is NOT NULL — without a membership row nothing can be
	// promoted at all.
	await addUserToOrganization(creator.id, organizationId, "owner");

	const [behavior] = (await sql`
    WITH next_id AS (
      SELECT nextval('watchers_id_seq')::integer AS id
    )
    INSERT INTO watchers (
      id, watcher_group_id, organization_id, created_by, name, slug, schedule, status
    )
    SELECT id, id, ${organizationId}, ${creator.id}, 'Eval Case Source', 'eval-case-src', '0 * * * *', 'active'
    FROM next_id
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	behaviorId = Number(behavior.id);

	sourceRunId = await insertBehaviorRun({});
	devicePinnedRunId = await insertBehaviorRun({
		device_worker_id: "device-abc",
	});
});

describe("promoteEvalCase", () => {
	test("creates a $eval_case entity pointing at the source run", async () => {
		const result = await promoteEvalCase({
			sourceRunId,
			caseKey: "case-1",
			expectation: "names the duplicate groups",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.created).toBe(true);
		expect(result.evalCase.sourceRunId).toBe(sourceRunId);
		expect(result.evalCase.behaviorId).toBe(behaviorId);

		const [entity] = (await sql`
      SELECT e.metadata, et.slug AS type_slug
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${result.evalCase.entityId}
    `) as unknown as Array<{
			metadata: Record<string, unknown>;
			type_slug: string;
		}>;

		expect(entity.type_slug).toBe(EVAL_CASE_ENTITY_TYPE_SLUG);
		expect(entity.metadata.source_run_id).toBe(sourceRunId);
		expect(entity.metadata.behavior_id).toBe(behaviorId);
		expect(entity.metadata.case_key).toBe("case-1");
		expect(entity.metadata.expectation).toBe("names the duplicate groups");
		expect(entity.metadata.status).toBe("active");
	});

	test("stores a pointer, never a copy of the frozen dispatch payload", async () => {
		// The whole reason a case is a pointer: a copied payload can drift from
		// the run it claims to replay, and then the case measures a question
		// nobody asked. Assert the payload is absent rather than merely equal.
		const result = await promoteEvalCase({ sourceRunId, caseKey: "case-1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [entity] = (await sql`
      SELECT metadata FROM entities WHERE id = ${result.evalCase.entityId}
    `) as unknown as Array<{ metadata: Record<string, unknown> }>;

		expect(entity.metadata.approved_input).toBeUndefined();
		expect(entity.metadata.window_start).toBeUndefined();
		expect(entity.metadata.agent_id).toBeUndefined();
	});

	test("is idempotent per (source run, case key)", async () => {
		const first = await promoteEvalCase({ sourceRunId, caseKey: "repeat" });
		const second = await promoteEvalCase({ sourceRunId, caseKey: "repeat" });

		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.evalCase.entityId).toBe(first.evalCase.entityId);

		const claims = (await sql`
      SELECT count(*)::int AS n
      FROM entity_identities
      WHERE organization_id = ${organizationId}
        AND namespace = ${EVAL_CASE_NAMESPACE}
        AND identifier = ${`${sourceRunId}:repeat`}
        AND deleted_at IS NULL
    `) as unknown as Array<{ n: number }>;
		expect(claims[0].n).toBe(1);

		// Assert the ENTITY count too, not just the returned contract. Promote has
		// three layers that each independently return the existing case (the claim
		// fast path, the slug-collision branch, the post-insert race re-read), so
		// the return value stays correct even when a layer is broken — while a
		// stray duplicate entity is silently left behind. Only counting rows
		// catches that.
		const entities = (await sql`
      SELECT count(*)::int AS n
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${organizationId}
        AND et.slug = ${EVAL_CASE_ENTITY_TYPE_SLUG}
        AND e.metadata->>'case_key' = 'repeat'
        AND e.deleted_at IS NULL
    `) as unknown as Array<{ n: number }>;
		expect(entities[0].n).toBe(1);
	});

	test("adopts its own entity when the identity claim is missing", async () => {
		// The recovery path: a promote that died between the entity insert and its
		// claim. The slug is already taken by THIS case, so re-promoting must adopt
		// that row and re-claim it — not mint a second entity beside it.
		const first = await promoteEvalCase({ sourceRunId, caseKey: "orphaned" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		await sql`
      DELETE FROM entity_identities
      WHERE organization_id = ${organizationId}
        AND namespace = ${EVAL_CASE_NAMESPACE}
        AND identifier = ${`${sourceRunId}:orphaned`}
    `;

		const second = await promoteEvalCase({ sourceRunId, caseKey: "orphaned" });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.evalCase.entityId).toBe(first.evalCase.entityId);
		expect(second.created).toBe(false);

		const entities = (await sql`
      SELECT count(*)::int AS n
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${organizationId}
        AND et.slug = ${EVAL_CASE_ENTITY_TYPE_SLUG}
        AND e.metadata->>'case_key' = 'orphaned'
        AND e.deleted_at IS NULL
    `) as unknown as Array<{ n: number }>;
		expect(entities[0].n).toBe(1);

		// And the claim is back, so the fast path covers the next promote.
		const claims = (await sql`
      SELECT count(*)::int AS n
      FROM entity_identities
      WHERE organization_id = ${organizationId}
        AND namespace = ${EVAL_CASE_NAMESPACE}
        AND identifier = ${`${sourceRunId}:orphaned`}
        AND deleted_at IS NULL
    `) as unknown as Array<{ n: number }>;
		expect(claims[0].n).toBe(1);
	});

	test("does not resurrect a deleted case holding the slug", async () => {
		// `entities_slug_parent_unique` is NOT partial on `deleted_at`, so a retired
		// case keeps its slug forever. Adopting it would silently un-delete it.
		const first = await promoteEvalCase({ sourceRunId, caseKey: "retired" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		await sql`
      UPDATE entities SET deleted_at = current_timestamp
      WHERE id = ${first.evalCase.entityId}
    `;
		await sql`
      DELETE FROM entity_identities
      WHERE organization_id = ${organizationId}
        AND namespace = ${EVAL_CASE_NAMESPACE}
        AND identifier = ${`${sourceRunId}:retired`}
    `;

		const second = await promoteEvalCase({ sourceRunId, caseKey: "retired" });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.created).toBe(true);
		expect(second.evalCase.entityId).not.toBe(first.evalCase.entityId);

		const [deleted] = (await sql`
      SELECT deleted_at FROM entities WHERE id = ${first.evalCase.entityId}
    `) as unknown as Array<{ deleted_at: Date | null }>;
		expect(deleted.deleted_at).not.toBeNull();
	});

	test("different case keys on one run are different cases", async () => {
		const a = await promoteEvalCase({ sourceRunId, caseKey: "angle-a" });
		const b = await promoteEvalCase({ sourceRunId, caseKey: "angle-b" });

		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.evalCase.entityId).not.toBe(b.evalCase.entityId);
	});

	test("keys that slugify alike stay separate cases", async () => {
		// `slugifyCaseKey` is lossy, so both keys want the same entity slug — and
		// `entities_slug_parent_unique` grants it to whoever asks first. Folding
		// them together would make the second case replay under the FIRST key's
		// idempotency key, silently answering a question nobody asked.
		const a = await promoteEvalCase({ sourceRunId, caseKey: "Tone Check" });
		const b = await promoteEvalCase({ sourceRunId, caseKey: "tone-check" });

		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(b.created).toBe(true);
		expect(b.evalCase.entityId).not.toBe(a.evalCase.entityId);
		expect(a.evalCase.caseKey).toBe("Tone Check");
		expect(b.evalCase.caseKey).toBe("tone-check");

		// And each replays under its OWN key.
		const runA = await replayEvalCase(a.evalCase.entityId);
		const runB = await replayEvalCase(b.evalCase.entityId);
		expect(runA?.runId).not.toBe(runB?.runId);
	});

	test("refuses a source the replay path could never dispatch", async () => {
		// The extraction's whole point: promote and replay share one predicate,
		// so a promoted case is always one that can actually run.
		const result = await promoteEvalCase({
			sourceRunId: devicePinnedRunId,
			caseKey: "pinned",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("not_dispatchable");

		const rows = (await sql`
      SELECT count(*)::int AS n
      FROM entity_identities
      WHERE namespace = ${EVAL_CASE_NAMESPACE}
        AND identifier = ${`${devicePinnedRunId}:pinned`}
    `) as unknown as Array<{ n: number }>;
		expect(rows[0].n).toBe(0);
	});

	test("refuses a run that does not exist", async () => {
		const result = await promoteEvalCase({
			sourceRunId: 999_999_999,
			caseKey: "ghost",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("not_found");
	});
});

describe("replayEvalCase", () => {
	test("mints an eval run from the case's source run", async () => {
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "replayable",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		const run = await replayEvalCase(promoted.evalCase.entityId);
		expect(run).not.toBeNull();
		if (!run) return;
		expect(run.sourceRunId).toBe(sourceRunId);

		const [row] = (await sql`
      SELECT run_type, status, idempotency_key, approved_input
      FROM runs WHERE id = ${run.runId}
    `) as unknown as Array<{
			run_type: string;
			status: string;
			idempotency_key: string;
			approved_input: Record<string, unknown>;
		}>;

		expect(row.run_type).toBe(BEHAVIOR_EVAL_RUN_TYPE);
		expect(row.status).toBe("pending");
		// The case key — not the entity id — scopes replay idempotency.
		expect(row.idempotency_key).toBe(
			`behavior_eval:${sourceRunId}:replayable`,
		);
		// Resolved from the SOURCE run at replay time, verbatim.
		expect(row.approved_input.window_start).toBe(payload.window_start);
	});

	test("returns null for an entity id that does not exist", async () => {
		const run = await replayEvalCase(999_999_999);
		expect(run).toBeNull();
	});

	test("returns null for an entity that is not an eval case", async () => {
		// `source_run_id` is not a reserved metadata key, so an unrelated entity
		// carrying one must not be replayable just because the id was passed in.
		const [type] = (await sql`
      INSERT INTO entity_types (slug, name, organization_id, created_at, updated_at)
      VALUES ('note', 'Note', ${organizationId}, current_timestamp, current_timestamp)
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const [creator] = (await sql`
      SELECT "userId" FROM "member" WHERE "organizationId" = ${organizationId} LIMIT 1
    `) as unknown as Array<{ userId: string }>;
		const [impostor] = (await sql`
      INSERT INTO entities (
        organization_id, entity_type_id, name, slug, metadata,
        created_by, created_at, updated_at
      ) VALUES (
        ${organizationId}, ${type.id}, 'Not A Case', 'not-a-case',
        ${sql.json({ source_run_id: sourceRunId, case_key: "impostor" })},
        ${creator.userId}, current_timestamp, current_timestamp
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		const run = await replayEvalCase(Number(impostor.id));
		expect(run).toBeNull();
	});
});
