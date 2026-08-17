/**
 * Per-connection ACL sync serialization.
 *
 * The generation fence covers the fresh STAMP, never the edge writes that
 * precede it, so two overlapping syncs of ONE connection can publish a leak the
 * fence cannot detect: the loser's stamp is refused, but its edges are already
 * in the graph under the winner's `fresh` state. These cases pin the ordering
 * that makes that interleaving impossible.
 */

import { describe, expect, it } from "vitest";
import { withAclConnectionSyncLock } from "../../../authz/acl-sync-lock";
import { cleanupTestDatabase } from "../../setup/test-db";

const connectionId = "conn-acl-sync-lock";

/** Resolves once `signal` fires, so a holder can be pinned open deterministically. */
function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("per-connection ACL sync lock", () => {
	it("runs the body and reports that it ran", async () => {
		await cleanupTestDatabase();
		const outcome = await withAclConnectionSyncLock(connectionId, async () => 42);
		expect(outcome.ran).toBe(true);
		expect(outcome.value).toBe(42);
	});

	it("skips a second sync of the SAME connection while one is in flight", async () => {
		const held = deferred();
		let secondRan = false;

		const holder = withAclConnectionSyncLock(connectionId, async () => {
			await held.promise;
			return "first";
		});

		// The holder is inside its body only once the lock is taken; poll for the
		// contended outcome rather than sleeping a fixed interval.
		let contended = await withAclConnectionSyncLock(connectionId, async () => {
			secondRan = true;
			return "second";
		});
		for (let i = 0; i < 100 && contended.ran; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			contended = await withAclConnectionSyncLock(connectionId, async () => {
				secondRan = true;
				return "second";
			});
		}

		held.release();
		const first = await holder;

		expect(first.ran).toBe(true);
		expect(first.value).toBe("first");
		// The decisive assertion: the second sync did not merely fail to stamp, it
		// never ran its body at all, so it wrote no edges.
		expect(contended.ran).toBe(false);
		expect(secondRan).toBe(false);
	});

	it("does not serialize DIFFERENT connections", async () => {
		const held = deferred();
		const holder = withAclConnectionSyncLock(`${connectionId}-a`, async () => {
			await held.promise;
			return "a";
		});

		const other = await withAclConnectionSyncLock(`${connectionId}-b`, async () => "b");

		held.release();
		await holder;

		expect(other.ran).toBe(true);
		expect(other.value).toBe("b");
	});

	it("releases the lock when the body throws", async () => {
		await expect(
			withAclConnectionSyncLock(connectionId, async () => {
				throw new Error("sync exploded");
			}),
		).rejects.toThrow("sync exploded");

		// A leaked session lock would wedge this connection until the pod restarted.
		const after = await withAclConnectionSyncLock(connectionId, async () => "recovered");
		expect(after.ran).toBe(true);
		expect(after.value).toBe("recovered");
	});
});
