import { beforeEach, describe, expect, test } from "bun:test";
import {
	__resetMutationGateForTests,
	type CreateMutationRequest,
	type DeferredMutation,
	type MutationInterceptor,
	registerMutationInterceptor,
	runMutationGate,
	type UpdateMutationRequest,
} from "../../authz/entity-mutation-gate";
import type { DbClient } from "../../db/client";

/**
 * Policy-query stub: the builtin approval interceptor (always first in the
 * registry) queries entity_approval_policies on the request's sql handle; an
 * empty result set resolves to the default policy (create/update auto), i.e.
 * the interceptor contributes allow / an empty require-approval set, leaving
 * the outcome to the test-registered stubs.
 */
const emptySql = (() => Promise.resolve([])) as unknown as DbClient;

function createReq(): CreateMutationRequest {
	return {
		action: "create",
		organizationId: "org-1",
		principalKind: "agent",
		sql: emptySql,
		attribution: "agent",
		entityTypeSlug: "task",
		entityData: { entity_type: "task", name: "X" },
		proposal: {},
	};
}

function updateReq(
	fields: UpdateMutationRequest["fields"],
): UpdateMutationRequest {
	return {
		action: "update",
		organizationId: "org-1",
		principalKind: "agent",
		sql: emptySql,
		attribution: "agent",
		entityTypeSlug: "task",
		entityId: 1,
		fields,
	};
}

function dummyDeferred(tag: string): DeferredMutation {
	return {
		display: { action: "create", attribution: "agent" },
		queue: async () => ({ runId: 1, eventId: 1, approvalUrl: tag }),
	};
}

function stub(
	name: string,
	fn: MutationInterceptor["evaluate"],
): MutationInterceptor {
	return { name, evaluate: fn };
}

describe("entity mutation gate", () => {
	beforeEach(() => {
		__resetMutationGateForTests();
	});

	test("the approval interceptor is registered by default (statically)", async () => {
		// No registration calls at all: a create with an empty policy set resolves
		// to allow — only possible if the statically-imported builtin approval
		// interceptor actually ran (it queried policy on the request's sql).
		const decision = await runMutationGate(createReq());
		expect(decision.outcome).toBe("allow");
	});

	test("builtin registry survives a test reset", async () => {
		registerMutationInterceptor(
			stub("throwaway", async () => ({ outcome: "deny", reason: "x" })),
		);
		__resetMutationGateForTests();
		// The throwaway deny is gone; the builtin approval interceptor remains
		// and (empty policy) allows.
		const decision = await runMutationGate(createReq());
		expect(decision.outcome).toBe("allow");
	});

	test("first deny in the chain wins over a later defer", async () => {
		registerMutationInterceptor(
			stub("deny", async () => ({ outcome: "deny", reason: "nope" })),
		);
		registerMutationInterceptor(
			stub("defer", async () => ({
				outcome: "defer",
				deferred: dummyDeferred("late"),
			})),
		);
		const decision = await runMutationGate(createReq());
		expect(decision.outcome).toBe("deny");
		if (decision.outcome === "deny") expect(decision.reason).toBe("nope");
	});

	test("first defer short-circuits create/delete", async () => {
		registerMutationInterceptor(
			stub("defer1", async () => ({
				outcome: "defer",
				deferred: dummyDeferred("first"),
			})),
		);
		registerMutationInterceptor(
			stub("defer2", async () => ({
				outcome: "defer",
				deferred: dummyDeferred("second"),
			})),
		);
		const decision = await runMutationGate(createReq());
		expect(decision.outcome).toBe("defer");
		if (decision.outcome === "defer") {
			const res = await decision.deferred.queue({} as never, {} as never);
			expect(res.approvalUrl).toBe("first");
		}
	});

	test("update require-approval sets union across interceptors", async () => {
		registerMutationInterceptor(
			stub("a", async () => ({
				outcome: "fields",
				requireApproval: new Set(["a"]),
			})),
		);
		registerMutationInterceptor(
			stub("b", async () => ({
				outcome: "fields",
				requireApproval: new Set(["b"]),
			})),
		);
		const decision = await runMutationGate(
			updateReq({ a: "none", b: "none", c: "none" }),
		);
		expect(decision.outcome).toBe("fields");
		if (decision.outcome === "fields") {
			expect([...decision.requireApproval].sort()).toEqual(["a", "b"]);
		}
	});

	test("update deny wins immediately over field approvals", async () => {
		registerMutationInterceptor(
			stub("fields", async () => ({
				outcome: "fields",
				requireApproval: new Set(["a"]),
			})),
		);
		registerMutationInterceptor(
			stub("deny", async () => ({ outcome: "deny", reason: "cross-org" })),
		);
		const decision = await runMutationGate(updateReq({ a: "none" }));
		expect(decision.outcome).toBe("deny");
	});

	test("registration is idempotent by name", async () => {
		let calls = 0;
		const once = stub("once", async () => {
			calls += 1;
			return { outcome: "allow" } as const;
		});
		registerMutationInterceptor(once);
		registerMutationInterceptor(once);
		await runMutationGate(createReq());
		expect(calls).toBe(1);
	});

	test("no-opinion (null) interceptors pass through to allow", async () => {
		registerMutationInterceptor(stub("silent", async () => null));
		const decision = await runMutationGate(createReq());
		expect(decision.outcome).toBe("allow");
	});
});
