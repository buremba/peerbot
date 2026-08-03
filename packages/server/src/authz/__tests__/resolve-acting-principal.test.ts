import { describe, expect, it } from "vitest";
import type { DbClient } from "../../db/client";
import { resolveActingPrincipal } from "../entity-policy";

/**
 * The single seam every write surface resolves identity through. It merges the
 * two channels an acting behavior arrives on (an explicit `behavior_source` and the
 * reaction session's own behavior), looks up the owning agent —
 * so no call site has to merge them and a reaction can't dodge its agent's
 * envelope by omitting attribution.
 *
 * The stub routes by query text: the behavior-owner JOIN (`FROM behaviors`) returns a
 * row iff `ownerAgentId` is set; the direct-agent existence probe (`FROM agents`,
 * no join) returns a row iff `agentExists`. This lets a test model an agent that was
 * deleted out from under a live session (agentExists=false) distinctly from a
 * missing behavior.
 */
function stubSql(
	ownerAgentId: string | null,
	agentExists = true,
): DbClient {
	const sql = (strings: TemplateStringsArray) => {
		const text = strings.join(" ");
		if (text.includes("FROM behaviors")) {
			return Promise.resolve(
				ownerAgentId == null ? [] : [{ agent_id: ownerAgentId }],
			);
		}
		// Direct-agent existence probe: SELECT 1 AS one FROM agents ...
		return Promise.resolve(agentExists ? [{ one: 1 }] : []);
	};
	return sql as unknown as DbClient;
}

/** A stub where the behavior row is GONE — the owner JOIN returns no rows. */
function stubSqlNoBehavior(): DbClient {
	return stubSql(null);
}

const ORG = "org-1";

describe("resolveActingPrincipal", () => {
	it("the trusted session behavior wins over the agent id AND a caller tag", async () => {
		// The session behavior is stamped by the executor (trusted), so it binds even
		// with an agentId and a different explicit tag present. It folds its owner.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitBehaviorId: 7,
			sessionBehaviorId: 9,
		});
		expect(actor).toEqual({
			kind: "behavior",
			// The trusted SESSION behavior (9) wins over the caller-supplied tag (7).
			id: "behavior:9",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("an authed agent's caller-supplied tag for a FOREIGN behavior is ignored", async () => {
		// The exploit: a restricted agent tags a behavior owned by someone else (or a
		// nonexistent id) to null out ownerAgentId and skip its own deny rows. The
		// explicit tag must NOT override the authenticated agent identity.
		const actor = await resolveActingPrincipal(stubSql("other-owner"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitBehaviorId: 7,
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "agent-1",
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("an authed agent tagging its OWN behavior is honored (owner matches)", async () => {
		const actor = await resolveActingPrincipal(stubSql("agent-1"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitBehaviorId: 7,
		});
		expect(actor).toEqual({
			kind: "behavior",
			id: "behavior:7",
			ownerAgentId: "agent-1",
			ownerResolved: true,
		});
	});

	it("an explicit behavior_source binds the behavior + folds its owning agent", async () => {
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			explicitBehaviorId: 7,
		});
		expect(actor).toEqual({
			kind: "behavior",
			id: "behavior:7",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("the reaction SESSION behavior binds even with no explicit behavior_source", async () => {
		// This is the reaction root fix: a script that omits behavior_source still
		// acts as its behavior, so its agent's envelope binds.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			sessionBehaviorId: 9,
		});
		expect(actor).toEqual({
			kind: "behavior",
			id: "behavior:9",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("the trusted session behavior wins over an explicit tag (no retag to dodge policy)", async () => {
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			explicitBehaviorId: 7,
			sessionBehaviorId: 9,
		});
		expect(actor.id).toBe("behavior:9");
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

	it("a session behavior whose row is GONE resolves ownerResolved=false (gate fails closed)", async () => {
		// The reaction's behavior was hard-deleted mid-flight. We still act as the
		// behavior, but the owner lookup fails → ownerResolved=false, so the gate must
		// deny rather than run the write against the looser org default.
		const actor = await resolveActingPrincipal(stubSqlNoBehavior(), {
			organizationId: ORG,
			sessionBehaviorId: 9,
		});
		expect(actor).toEqual({
			kind: "behavior",
			id: "behavior:9",
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

	it("a session behavior whose OWNING AGENT was deleted resolves ownerResolved=false", async () => {
		// There is no behavior→agent FK, so an in-flight behavior's agent_id can dangle
		// after the owner is deleted. The owner JOIN requires the agent row, so the
		// lookup returns no rows → ownerResolved=false → gate denies. (stubSql(null)
		// models the JOIN finding nothing because the agent side is gone.)
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			sessionBehaviorId: 9,
		});
		expect(actor.ownerResolved).toBe(false);
		expect(actor.kind).toBe("behavior");
	});
});
