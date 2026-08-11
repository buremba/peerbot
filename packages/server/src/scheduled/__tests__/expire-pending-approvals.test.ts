/**
 * Integration test for the long-horizon pending-approval expiry sweep.
 *
 * A run parked at `approval_status='pending'` is deliberately exempt from the
 * SHORT-horizon claim reaper (#2044) so a human gets real time to decide. That
 * exemption was never paired with a long-horizon expiry, so undecided approvals
 * accumulated forever. This sweep closes the other end of the timescale.
 *
 * The tests pin both directions: a row past the TTL goes terminal at
 * 'expired', and everything else — inside the TTL, already decided, or in a
 * lane that never holds a human gate — is left completely alone.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { getDb } from "../../db/client";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup";
import type { Env } from "../../index";
import { expirePendingApprovals } from "../expire-pending-approvals";
import { getSchedulerHealth } from "../scheduler-health";

const ORG_ID = "approval-expiry-org";
const TTL_DAYS = 7;
const DROP_FAIL_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_expiry_supersede_trg ON events;
DROP FUNCTION IF EXISTS test_fail_expiry_supersede();
`;
let failTriggerCleanupNeeded = false;

beforeAll(async () => {
	await ensureDbForGatewayTests();
});

beforeEach(async () => {
	await resetTestDatabase();
	const sql = getDb();
	await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID})
    ON CONFLICT (id) DO NOTHING
	`;
});

afterEach(async () => {
	if (!failTriggerCleanupNeeded) return;
	await getDb().unsafe(DROP_FAIL_TRIGGER);
	failTriggerCleanupNeeded = false;
});

interface SeedApprovalOpts {
	approvalStatus: "pending" | "approved" | "rejected" | "auto";
	ageDays: number;
	runType?: "action" | "internal" | "sync" | "behavior";
	status?: string;
	organizationId?: string;
}

async function seedApproval(opts: SeedApprovalOpts): Promise<number> {
	const sql = getDb();
	const rows = (await sql.unsafe(
		`INSERT INTO runs (
       organization_id, run_type, status, approval_status, action_key, created_at
     ) VALUES (
       $1, $2, $3, $4, 'send_message',
       now() - ($5::int * interval '1 day')
     )
     RETURNING id`,
		[
			opts.organizationId ?? ORG_ID,
			opts.runType ?? "action",
			opts.status ?? "pending",
			opts.approvalStatus,
			opts.ageDays,
		],
	)) as unknown as Array<{ id: number | string }>;
	const runId = Number(rows[0].id);
	// Production queued approvals always carry their pending card (the #2033
	// queue path writes run + card in one transaction), and the expiry sweep
	// supersedes that card — so a seeded PENDING run must have one here too.
	// Non-pending states (approved/rejected/auto) never go through the sweep,
	// so they get no card.
	if (opts.approvalStatus === "pending") {
		await getDb()`
      INSERT INTO events (
        organization_id, origin_id, title, payload_text, run_id,
        semantic_type, interaction_type, interaction_status
      ) VALUES (
        ${opts.organizationId ?? ORG_ID}, ${`run_${runId}_pending`},
        'Pending approval', 'Awaiting review', ${runId},
        'operation', 'approval', 'pending'
      )
    `;
	}
	return runId;
}

async function runStateOf(
	runId: number,
): Promise<{ approval_status: string; status: string }> {
	const sql = getDb();
	const rows = (await sql`
    SELECT approval_status, status FROM runs WHERE id = ${runId}
  `) as unknown as Array<{ approval_status: string; status: string }>;
	return rows[0];
}

describe("expirePendingApprovals", () => {
	test("a pending approval older than the TTL becomes terminal 'expired'", async () => {
		const staleId = await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS + 3,
		});

		const result = await expirePendingApprovals(TTL_DAYS);

		expect(result.expired).toBe(1);
		const state = await runStateOf(staleId);
		expect(state.approval_status).toBe("expired");
		expect(state.status).toBe("cancelled");

		// The reason is recorded on the row so an operator can tell an expiry
		// apart from a human rejection without reading the event chain.
		const sql = getDb();
		const [row] = (await sql`
      SELECT error_message, completed_at FROM runs WHERE id = ${staleId}
    `) as unknown as Array<{
			error_message: string | null;
			completed_at: string | null;
		}>;
		expect(row.error_message).toContain("Approval expired");
		expect(row.completed_at).not.toBeNull();
	});

	test("a pending approval INSIDE the TTL is untouched", async () => {
		// One day short of the TTL — the human still has time to decide, and the
		// whole point of #2044 is that we must not take that away.
		const freshId = await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS - 1,
		});

		const result = await expirePendingApprovals(TTL_DAYS);

		expect(result.expired).toBe(0);
		const state = await runStateOf(freshId);
		expect(state.approval_status).toBe("pending");
		expect(state.status).toBe("pending");
	});

	test("already approved / rejected / auto rows are never touched, however old", async () => {
		const approvedId = await seedApproval({
			approvalStatus: "approved",
			ageDays: TTL_DAYS * 10,
			status: "running",
		});
		const rejectedId = await seedApproval({
			approvalStatus: "rejected",
			ageDays: TTL_DAYS * 10,
			status: "cancelled",
		});
		const autoId = await seedApproval({
			approvalStatus: "auto",
			ageDays: TTL_DAYS * 10,
		});

		const result = await expirePendingApprovals(TTL_DAYS);

		expect(result.expired).toBe(0);
		expect((await runStateOf(approvedId)).approval_status).toBe("approved");
		expect((await runStateOf(rejectedId)).approval_status).toBe("rejected");
		expect((await runStateOf(autoId)).approval_status).toBe("auto");
	});

	test("covers both human-gated lanes: action and internal", async () => {
		const actionId = await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS + 1,
			runType: "action",
		});
		const internalId = await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS + 1,
			runType: "internal",
		});

		const result = await expirePendingApprovals(TTL_DAYS);

		expect(result.expired).toBe(2);
		expect((await runStateOf(actionId)).approval_status).toBe("expired");
		expect((await runStateOf(internalId)).approval_status).toBe("expired");
	});

	/** Run getSchedulerHealth with the TTL pinned to this suite's value. */
	async function healthWithPinnedTtl() {
		const previousTtl = process.env.PENDING_APPROVAL_TTL_DAYS;
		process.env.PENDING_APPROVAL_TTL_DAYS = String(TTL_DAYS);
		try {
			return await getSchedulerHealth({} as Env);
		} finally {
			if (previousTtl === undefined) {
				delete process.env.PENDING_APPROVAL_TTL_DAYS;
			} else {
				process.env.PENDING_APPROVAL_TTL_DAYS = previousTtl;
			}
		}
	}

	// The sweep runs DAILY, so a row that crosses the TTL right after a tick is
	// stale for up to a day BY DESIGN. Alarming on that would leave
	// /health/scheduler at 503 during normal operation and train operators to
	// ignore it. The count is still reported — only the issue is withheld.
	test("scheduler health reports, but does NOT alarm on, expected between-tick drift", async () => {
		await seedApproval({
			approvalStatus: "pending",
			// Past the TTL but inside the one-day sweep grace.
			ageDays: TTL_DAYS,
		});

		const health = await healthWithPinnedTtl();

		// The operator still sees the backlog...
		expect(health.metrics.stalePendingApprovals).toBe(1);
		// ...but this is not a fault, so no issue is raised.
		expect(
			health.issues.some((issue) => /approvals undecided past/i.test(issue)),
		).toBe(false);
	});

	test("scheduler health DOES alarm once a full sweep opportunity was missed", async () => {
		await seedApproval({
			approvalStatus: "pending",
			// Past TTL + the one-day grace: a sweep should have taken this terminal.
			ageDays: TTL_DAYS + 3,
		});

		const health = await healthWithPinnedTtl();

		expect(health.metrics.stalePendingApprovals).toBe(1);
		expect(health.metrics.oldestPendingApprovalDays).toBeGreaterThan(TTL_DAYS);
		expect(
			health.issues.some((issue) => /approvals undecided past/i.test(issue)),
		).toBe(true);
		expect(health.healthy).toBe(false);
	});

	test("is idempotent — a second pass expires nothing new", async () => {
		await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS + 5,
		});

		const first = await expirePendingApprovals(TTL_DAYS);
		expect(first.expired).toBe(1);

		// The UPDATE re-asserts `approval_status = 'pending'`, so the row it just
		// took terminal no longer matches. This is the same predicate that makes
		// two overlapping replicas safe: only one expiry can commit for a row.
		const second = await expirePendingApprovals(TTL_DAYS);
		expect(second.expired).toBe(0);
	});

	test("an event supersede failure rolls back that run without blocking the rest", async () => {
		const staleId = await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS + 3,
		});
		const healthyId = await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS + 2,
		});
		const sql = getDb();
		failTriggerCleanupNeeded = true;
		await sql.unsafe(`
      CREATE OR REPLACE FUNCTION test_fail_expiry_supersede()
        RETURNS trigger AS $fn$
      BEGIN
        IF NEW.supersedes_event_id IS NOT NULL AND NEW.run_id = ${staleId} THEN
          RAISE EXCEPTION 'simulated expiry supersede failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_expiry_supersede_trg
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION test_fail_expiry_supersede();
    `);

		const result = await expirePendingApprovals(TTL_DAYS);
		expect(result.expired).toBe(1);
		expect((await runStateOf(staleId)).approval_status).toBe("pending");
		expect((await runStateOf(healthyId)).approval_status).toBe("expired");
	});

	test("a decision landing between scan and sweep wins over the expiry", async () => {
		// Multi-replica / human-race safety: a row approved just before the sweep
		// must keep the human's decision, not be overwritten by the reaper.
		const raceId = await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS + 30,
		});
		const sql = getDb();
		await sql`
      UPDATE runs SET approval_status = 'approved', status = 'running'
      WHERE id = ${raceId}
    `;

		const result = await expirePendingApprovals(TTL_DAYS);

		expect(result.expired).toBe(0);
		expect((await runStateOf(raceId)).approval_status).toBe("approved");
	});

	test("the TTL is configurable — a shorter TTL expires a younger row", async () => {
		const id = await seedApproval({
			approvalStatus: "pending",
			ageDays: 3,
		});

		// Untouched at the 7-day default...
		expect((await expirePendingApprovals(7)).expired).toBe(0);
		expect((await runStateOf(id)).approval_status).toBe("pending");

		// ...and expired once the TTL is tightened below its age.
		expect((await expirePendingApprovals(2)).expired).toBe(1);
		expect((await runStateOf(id)).approval_status).toBe("expired");
	});
});

/**
 * Batch draining + cross-org fairness.
 *
 * The first cut selected rows globally oldest-first with a flat 500-row cap on a
 * DAILY job. That starved everyone: a single tenant with more than 500 stale
 * approvals consumed the whole budget on every tick, so its own backlog never
 * drained and no other org's approvals were ever reached.
 */
describe("expirePendingApprovals — draining and cross-org fairness", () => {
	/** Seed `count` stale pending approvals for an org in one statement. */
	async function seedManyStale(
		organizationId: string,
		count: number,
		ageDays: number,
	): Promise<void> {
		const sql = getDb();
		// One statement: insert the runs AND each one's pending approval card in
		// a single data-modifying CTE, scoped exactly to the rows this call
		// inserted — repeated calls can never backfill (and duplicate) cards for
		// runs seeded by earlier calls.
		await sql.unsafe(
			`WITH inserted AS (
         INSERT INTO runs (
           organization_id, run_type, status, approval_status, action_key, created_at
         )
         SELECT $1, 'action', 'pending', 'pending', 'send_message',
                now() - ($3::int * interval '1 day') - (g * interval '1 second')
         FROM generate_series(1, $2::int) AS g
         RETURNING id, organization_id
       )
       INSERT INTO events (
         organization_id, origin_id, title, payload_text, run_id,
         semantic_type, interaction_type, interaction_status
       )
       SELECT organization_id, 'run_' || id || '_pending',
              'Pending approval', 'Awaiting review', id,
              'operation', 'approval', 'pending'
       FROM inserted`,
			[organizationId, count, ageDays],
		);
	}

	async function pendingCount(organizationId: string): Promise<number> {
		const sql = getDb();
		const rows = (await sql`
      SELECT count(*)::int AS n FROM runs
      WHERE organization_id = ${organizationId} AND approval_status = 'pending'
    `) as unknown as Array<{ n: number }>;
		return Number(rows[0]?.n ?? 0);
	}

	async function expiredCount(organizationId: string): Promise<number> {
		const sql = getDb();
		const rows = (await sql`
      SELECT count(*)::int AS n FROM runs
      WHERE organization_id = ${organizationId} AND approval_status = 'expired'
    `) as unknown as Array<{ n: number }>;
		return Number(rows[0]?.n ?? 0);
	}

	async function seedOrg(id: string): Promise<void> {
		const sql = getDb();
		await sql`
      INSERT INTO organization (id, name, slug) VALUES (${id}, ${id}, ${id})
      ON CONFLICT (id) DO NOTHING
    `;
	}

	test("drains a backlog LARGER than one 500-row batch in a single invocation", async () => {
		// 620 > the 500-row batch size. With the old flat cap this returned exactly
		// 500 and left 120 waiting a full day for the next tick.
		await seedManyStale(ORG_ID, 620, TTL_DAYS + 2);

		const result = await expirePendingApprovals(TTL_DAYS);

		expect(result.expired).toBe(620);
		expect(await pendingCount(ORG_ID)).toBe(0);
		expect(await expiredCount(ORG_ID)).toBe(620);
	});

	test("a huge single-tenant backlog does NOT starve other orgs", async () => {
		// The starvation reproducer. ORG_ID's rows are all OLDER than the other
		// orgs', so a purely oldest-first global selection would fill the entire
		// first batch with ORG_ID and never reach the small orgs.
		const hogOrg = ORG_ID;
		const hogRows = 700;
		await seedManyStale(hogOrg, hogRows, TTL_DAYS + 60);

		const smallOrgs = ["fair-org-a", "fair-org-b", "fair-org-c"];
		for (const org of smallOrgs) {
			await seedOrg(org);
			await seedManyStale(org, 5, TTL_DAYS + 1);
		}

		const result = await expirePendingApprovals(TTL_DAYS);

		// Every org drains — the small ones are not left behind the big tenant.
		for (const org of smallOrgs) {
			expect(await expiredCount(org)).toBe(5);
			expect(await pendingCount(org)).toBe(0);
		}
		expect(await expiredCount(hogOrg)).toBe(hogRows);
		expect(result.expired).toBe(hogRows + smallOrgs.length * 5);
	});

	test("the per-org cap bounds how much one tenant takes from a single batch", async () => {
		// Fairness is a per-BATCH property, not only an end-state one. Seed a hog
		// with far more than one batch of much-older rows plus one small org, then
		// run a sweep whose ceiling admits only a single batch (ttl unchanged, but
		// the ceiling is what stops it). Under the old global oldest-first
		// selection the hog's older rows would fill that batch entirely and the
		// small org would get nothing.
		// A ceiling of 120 makes this a single bounded batch, so the assertion is
		// about batch COMPOSITION rather than the end state after a full drain.
		// The hog holds far more than the per-org cap (50), so an unfair selection
		// would spend the whole batch on it.
		const batchCeiling = 120;
		const hogOrg = ORG_ID;
		await seedManyStale(hogOrg, 200, TTL_DAYS + 60);
		await seedOrg("fair-small");
		await seedManyStale("fair-small", 3, TTL_DAYS + 1);

		const result = await expirePendingApprovals(TTL_DAYS, batchCeiling);

		// The small org is served despite every one of its rows being NEWER than
		// all 200 of the hog's — proof the selection is not globally oldest-first.
		expect(await expiredCount("fair-small")).toBe(3);
		expect(result.expired).toBe(batchCeiling);
		// The hog cannot take the whole batch: the per-org cap bounds its share,
		// leaving room for other orgs even though its rows are the oldest.
		expect(await expiredCount(hogOrg)).toBeLessThan(batchCeiling);
	});

	test("more backlogged orgs than the batch can cover: a newer org still gets rows in the FIRST batch", async () => {
		// The per-org cap alone does NOT give fairness. With batch=500 and
		// per-org=50, ten backlogged orgs fill the batch exactly (10 × 50 = 500).
		// If the batch is then ordered globally by age, the ten OLDEST orgs consume
		// it entirely and an eleventh org never appears — and if those ten sustain
		// their backlog, the eleventh is starved forever. That is the original
		// starvation bug with the threshold moved from 1 org to 10.
		//
		// Selection must interleave by per-org rank (every org's oldest row first,
		// then every org's second, …) so representation does not depend on how many
		// other orgs are backlogged.
		// 14 older orgs × the 50-row per-org cap = 700 rows ranked ahead of the
		// newcomer under global age ordering — more than the 120-row batch below,
		// so the newcomer is invisible unless selection interleaves by org.
		const olderOrgs = Array.from({ length: 14 }, (_, i) => `starve-old-${i}`);
		for (const org of olderOrgs) {
			await seedOrg(org);
			await seedManyStale(org, 12, TTL_DAYS + 90);
		}
		// One newer org, guaranteed to lose every global age comparison.
		await seedOrg("starve-newcomer");
		await seedManyStale("starve-newcomer", 4, TTL_DAYS + 1);

		// Ceiling of exactly one batch so this asserts on batch COMPOSITION.
		const batchCeiling = 120;
		const result = await expirePendingApprovals(TTL_DAYS, batchCeiling);
		expect(result.expired).toBe(batchCeiling);

		// The newcomer must be represented in that first batch. Under global age
		// ordering it gets 0: all 14 older orgs rank ahead of it.
		expect(await expiredCount("starve-newcomer")).toBeGreaterThan(0);
	});

	test("respects the per-invocation ceiling on a pathological backlog", async () => {
		// A backlog larger than the ceiling must stop AT the ceiling rather than
		// running unbounded, and the remainder must drain on the next tick so no
		// permanent backlog forms. The ceiling is injected here so this exercises
		// the real bound without seeding the 10k production value.
		const ceiling = 120;
		await seedManyStale(ORG_ID, ceiling + 30, TTL_DAYS + 2);

		const result = await expirePendingApprovals(TTL_DAYS, ceiling);

		expect(result.expired).toBe(ceiling);
		expect(await pendingCount(ORG_ID)).toBe(30);

		// The remainder drains on the following tick — no permanent backlog.
		const second = await expirePendingApprovals(TTL_DAYS, ceiling);
		expect(second.expired).toBe(30);
		expect(await pendingCount(ORG_ID)).toBe(0);
	});
});
