import { describe, expect, it } from "vitest";
import {
	evaluateEntityCreate,
	evaluateEntityDelete,
	evaluateEntityFieldRead,
	evaluateEntityFieldUpdate,
} from "../entity-policy";

describe("entity policy", () => {
	const watcher = {
		kind: "watcher" as const,
		id: "hourly-task-collaborator",
		orgId: "org-1",
	};
	const agent = { kind: "agent" as const, id: "task-agent", orgId: "org-1" };
	const admin = {
		kind: "user" as const,
		id: "admin-user",
		orgId: "org-1",
		role: "admin",
	};
	const member = {
		kind: "user" as const,
		id: "member-user",
		orgId: "org-1",
		role: "member",
	};

	it("models the current human-owned field gate as an approval obligation", () => {
		expect(
			evaluateEntityFieldUpdate({
				principal: watcher,
				resource: {
					id: 3202,
					orgId: "org-1",
					entityType: "task",
					fieldOwner: "human",
				},
				field: "rationale",
			}),
		).toBe("require_approval");
	});

	it("allows non-human updates to non-human-owned fields", () => {
		expect(
			evaluateEntityFieldUpdate({
				principal: agent,
				resource: {
					id: 3202,
					orgId: "org-1",
					entityType: "task",
					fieldOwner: "none",
				},
				field: "status",
			}),
		).toBe("allow");
	});

	it("allows admin updates without approval", () => {
		expect(
			evaluateEntityFieldUpdate({
				principal: admin,
				resource: {
					id: 3202,
					orgId: "org-1",
					entityType: "task",
					fieldOwner: "human",
				},
				field: "rationale",
			}),
		).toBe("allow");
	});

	it("models member email redaction as an obligation instead of a deny", () => {
		expect(
			evaluateEntityFieldRead({
				principal: member,
				resource: {
					id: "$member:1",
					orgId: "org-1",
					entityType: "$member",
					fieldOwner: "human",
				},
				field: "email",
			}),
		).toBe("redact");
	});

	it("allows admin member email reads", () => {
		expect(
			evaluateEntityFieldRead({
				principal: admin,
				resource: {
					id: "$member:1",
					orgId: "org-1",
					entityType: "$member",
					fieldOwner: "human",
				},
				field: "email",
			}),
		).toBe("allow");
	});

	it("denies cross-org reads before considering redaction", () => {
		expect(
			evaluateEntityFieldRead({
				principal: { ...watcher, orgId: "org-2" },
				resource: {
					id: 3202,
					orgId: "org-1",
					entityType: "task",
					fieldOwner: "none",
				},
				field: "status",
			}),
		).toBe("deny");
	});

	it("allows agent create by default while leaving an approval hook", () => {
		expect(
			evaluateEntityCreate({
				principal: agent,
				resource: {
					id: "new:task",
					orgId: "org-1",
					entityType: "task",
					fieldOwner: "none",
				},
			}),
		).toBe("allow");
	});

	it("can express watcher delete as require approval", () => {
		expect(
			evaluateEntityDelete({
				principal: watcher,
				resource: {
					id: 3202,
					orgId: "org-1",
					entityType: "task",
					fieldOwner: "none",
				},
			}),
		).toBe("require_approval");
	});
});
