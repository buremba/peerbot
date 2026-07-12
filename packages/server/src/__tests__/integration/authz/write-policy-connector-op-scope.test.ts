/**
 * Real-PG tests for per-operation connector_action scope. A policy row scoped to a
 * single operation_key tightens the blanket `execute` rule for THAT operation alone;
 * every other operation still follows the blanket. The op-specific row wins over the
 * blanket via the resolver's scope specificity — mirrored in the UI model.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resolveWriteEffect } from "../../../authz/entity-policy";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

async function seedConnectorPolicy(args: {
	orgId: string;
	principalKind?: string | null;
	principalId?: string | null;
	operationKey?: string | null;
	effect: string;
}): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ id: number }>`
    INSERT INTO write_approval_policies
      (organization_id, resource_class, principal_kind, principal_id, operation_key)
    VALUES
      (${args.orgId}, 'connector_action', ${args.principalKind ?? null},
       ${args.principalId ?? null}, ${args.operationKey ?? null})
    RETURNING id
  `;
	const id = Number(rows[0].id);
	await sql`
    INSERT INTO write_policy_action_effects (policy_id, action, effect)
    VALUES (${id}, 'execute', ${args.effect})
  `;
	return id;
}

const execFor = (orgId: string, agentId: string, operationKey: string | null) =>
	resolveWriteEffect({
		organizationId: orgId,
		resourceClass: "connector_action",
		principalKind: "agent",
		principalId: agentId,
		action: "execute",
		operationKey,
	});

describe("connector_action per-operation scope", () => {
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	let orgId: string;
	beforeEach(async () => {
		const org = await createTestOrganization();
		orgId = org.id;
		await createTestAgent({ organizationId: orgId, agentId: "op-agent" });
	});

	it("a per-op rule tightens ONLY its operation; others follow the blanket", async () => {
		// Blanket: every op auto. Per-op: place_order needs approval.
		await seedConnectorPolicy({
			orgId,
			principalKind: "agent",
			principalId: "op-agent",
			effect: "auto",
		});
		await seedConnectorPolicy({
			orgId,
			principalKind: "agent",
			principalId: "op-agent",
			operationKey: "deliveroo.place_order",
			effect: "approval",
		});
		// The scoped op resolves approval; a different op resolves the blanket auto.
		expect(await execFor(orgId, "op-agent", "deliveroo.place_order")).toBe(
			"approval",
		);
		expect(await execFor(orgId, "op-agent", "slack.send_message")).toBe("auto");
		// The blanket itself (no op) stays auto.
		expect(await execFor(orgId, "op-agent", null)).toBe("auto");
	});

	it("a per-op rule can only TIGHTEN — the blanket floor still binds if stricter", async () => {
		// Blanket denies; a per-op 'auto' must NOT loosen it below the blanket.
		await seedConnectorPolicy({
			orgId,
			principalKind: "agent",
			principalId: "op-agent",
			effect: "deny",
		});
		await seedConnectorPolicy({
			orgId,
			principalKind: "agent",
			principalId: "op-agent",
			operationKey: "slack.send_message",
			effect: "auto",
		});
		// Blanket deny + per-op auto → folded most-restrictive → deny.
		expect(await execFor(orgId, "op-agent", "slack.send_message")).toBe("deny");
	});

	it("with no per-op rule, an op follows the blanket", async () => {
		await seedConnectorPolicy({
			orgId,
			principalKind: "agent",
			principalId: "op-agent",
			operationKey: "slack.send_message",
			effect: "approval",
		});
		// A DIFFERENT op with no rule and no blanket → class default (auto).
		expect(await execFor(orgId, "op-agent", "deliveroo.place_order")).toBe(
			"auto",
		);
		// The op that DOES have a rule resolves it.
		expect(await execFor(orgId, "op-agent", "slack.send_message")).toBe(
			"approval",
		);
	});

	it("an org (any-principal) per-op floor binds the agent for that op", async () => {
		// Org floor: place_order approval for ANY principal. Agent has no override.
		await seedConnectorPolicy({
			orgId,
			operationKey: "deliveroo.place_order",
			effect: "approval",
		});
		expect(await execFor(orgId, "op-agent", "deliveroo.place_order")).toBe(
			"approval",
		);
		// Another op falls back to the class default (auto).
		expect(await execFor(orgId, "op-agent", "slack.send_message")).toBe("auto");
	});

	it("connector-qualified keys don't alias: two connectors' same bare op are distinct (F1)", async () => {
		// linear::create_issue = deny, but github::create_issue must stay auto. The
		// qualified key is what the gate passes, so a rule on one connector's op can't
		// leak to another connector that exposes the same bare operation key.
		await seedConnectorPolicy({
			orgId,
			principalKind: "agent",
			principalId: "op-agent",
			operationKey: "linear::create_issue",
			effect: "deny",
		});
		expect(await execFor(orgId, "op-agent", "linear::create_issue")).toBe(
			"deny",
		);
		expect(await execFor(orgId, "op-agent", "github::create_issue")).toBe(
			"auto",
		);
	});
});
