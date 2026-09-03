import { describe, expect, it } from "vitest";
import type { DbClient } from "../../db/client";
import { resolveActingPrincipal } from "../entity-policy";

/**
 * The single seam every write surface resolves identity through. The stub
 * models the two independent facts the production query returns: whether the
 * Automation row exists and whether its optional managed agent still exists.
 */
function stubSql(
	ownerAgentId: string | null,
	agentExists = true,
	automationExists = true,
): DbClient {
	const sql = (strings: TemplateStringsArray) => {
		const text = strings.join(" ");
		if (text.includes("FROM automations")) {
			if (!automationExists) return Promise.resolve([]);
			return Promise.resolve([
				{
					managed_agent_id: ownerAgentId,
					owner_resolved: ownerAgentId == null ? true : agentExists,
				},
			]);
		}
		// Direct-agent existence probe: SELECT 1 AS one FROM agents ...
		return Promise.resolve(agentExists ? [{ one: 1 }] : []);
	};
	return sql as unknown as DbClient;
}

/** A stub where the Automation row itself is gone. */
function stubSqlNoAutomation(): DbClient {
	return stubSql(null, true, false);
}

const ORG = "org-1";

describe("resolveActingPrincipal", () => {
	it("the trusted session automation wins over the agent id AND a caller tag", async () => {
		// The session automation is stamped by the executor (trusted), so it binds even
		// with an agentId and a different explicit tag present. It folds its owner.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitAutomationId: 7,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			// The trusted SESSION automation (9) wins over the caller-supplied tag (7).
			id: "automation:9",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("an authed agent's caller-supplied tag for a FOREIGN automation is ignored", async () => {
		// The exploit: a restricted agent tags an automation owned by someone else (or a
		// nonexistent id) to null out ownerAgentId and skip its own deny rows. The
		// explicit tag must NOT override the authenticated agent identity.
		const actor = await resolveActingPrincipal(stubSql("other-owner"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitAutomationId: 7,
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "agent-1",
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("an authed agent cannot tag an agentless Automation to shed its own policy", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitAutomationId: 7,
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "agent-1",
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("an authed agent tagging its OWN automation is honored (owner matches)", async () => {
		const actor = await resolveActingPrincipal(stubSql("agent-1"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitAutomationId: 7,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:7",
			ownerAgentId: "agent-1",
			ownerResolved: true,
		});
	});

	it("an explicit automation_source binds the automation + folds its owning agent", async () => {
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			explicitAutomationId: 7,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:7",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("the reaction SESSION automation binds even with no explicit automation_source", async () => {
		// This is the reaction root fix: a script that omits automation_source still
		// acts as its automation, so its agent's envelope binds.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:9",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("the trusted session automation wins over an explicit tag (no retag to dodge policy)", async () => {
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			explicitAutomationId: 7,
			sessionAutomationId: 9,
		});
		expect(actor.id).toBe("automation:9");
	});

	it("an agentless session Automation remains a resolved Automation principal", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:9",
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("an invalid empty-string agent assignment fails closed", async () => {
		const actor = await resolveActingPrincipal(stubSql("", false), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:9",
			ownerAgentId: "",
			ownerResolved: false,
		});
	});

	it("a plain user turn has no owner to fold", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			userId: "user-1",
		});
		expect(actor).toEqual({
			kind: "user",
			id: null,
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("a session automation whose row is GONE resolves ownerResolved=false (gate fails closed)", async () => {
		// The reaction's automation was hard-deleted mid-flight. We still act as the
		// automation, but the owner lookup fails → ownerResolved=false, so the gate must
		// deny rather than run the write against the looser org default.
		const actor = await resolveActingPrincipal(stubSqlNoAutomation(), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:9",
			ownerAgentId: null,
			ownerResolved: false,
		});
	});

	it("a bound agent DELETED out from under a live session resolves ownerResolved=false", async () => {
		// The fail-open r16 opened: an admin deletes agent A, its delete trigger
		// cascades A's deny/approval rows, but A's still-live session keeps its bound
		// agentId. Without an existence check the gate finds no A-specific rows and
		// falls back to the (looser) org default — connector_action → auto. The
		// resolver must mark A unresolved so every gate denies.
		const actor = await resolveActingPrincipal(stubSql(null, false), {
			organizationId: ORG,
			agentId: "deleted-agent",
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "deleted-agent",
			ownerAgentId: null,
			ownerResolved: false,
		});
	});

	it("a session automation whose OWNING AGENT was deleted resolves ownerResolved=false", async () => {
		// There is no automation→agent FK, so an in-flight automation's agent_id can dangle
		// after the owner is deleted. The owner JOIN requires the agent row, so the
		// lookup returns no rows → ownerResolved=false → gate denies. (stubSql(null)
		// models the JOIN finding nothing because the agent side is gone.)
		const actor = await resolveActingPrincipal(stubSql("deleted-owner", false), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor.ownerResolved).toBe(false);
		expect(actor.kind).toBe("automation");
	});
});
