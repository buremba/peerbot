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

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup";
import { expirePendingApprovals } from "../expire-pending-approvals";

const ORG_ID = "approval-expiry-org";
const TTL_DAYS = 7;

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
	return Number(rows[0].id);
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

	test("is idempotent — a second pass expires nothing new", async () => {
		await seedApproval({
			approvalStatus: "pending",
			ageDays: TTL_DAYS + 5,
		});

		const first = await expirePendingApprovals(TTL_DAYS);
		expect(first.expired).toBe(1);

		// The UPDATE re-asserts `approval_status = 'pending'`, so the row it just
		// took terminal no longer matches. This is the same predicate that makes
		// two overlapping replicas safe: only one UPDATE can ever match a row.
		const second = await expirePendingApprovals(TTL_DAYS);
		expect(second.expired).toBe(0);
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
