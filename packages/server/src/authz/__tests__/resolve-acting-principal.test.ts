import { describe, expect, it } from "vitest";
import type { DbClient } from "../../db/client";
import { resolveActingPrincipal } from "../entity-policy";

/**
 * The single seam every write surface resolves identity through. It merges the
 * two channels an acting watcher arrives on (an explicit `watcher_source` and the
 * reaction session's own watcher), looks up the owning agent, and pins the mode —
 * so no call site has to merge them and a reaction can't dodge its agent's
 * envelope by omitting attribution.
 *
 * The stub routes by query text: the watcher-owner JOIN (`FROM watchers`) returns a
 * row iff `ownerAgentId` is set; the direct-agent existence probe (`FROM agents`,
 * no join) returns a row iff `agentExists`. This lets a test model an agent that was
 * deleted out from under a live session (agentExists=false) distinctly from a
 * missing watcher.
 */
function stubSql(
	ownerAgentId: string | null,
	agentExists = true,
): DbClient {
	const sql = (strings: TemplateStringsArray) => {
		const text = strings.join(" ");
		if (text.includes("FROM watchers")) {
			return Promise.resolve(
				ownerAgentId == null ? [] : [{ agent_id: ownerAgentId }],
			);
		}
		// Direct-agent existence probe: SELECT 1 AS one FROM agents ...
		return Promise.resolve(agentExists ? [{ one: 1 }] : []);
	};
	return sql as unknown as DbClient;
}

/** A stub where the watcher row is GONE — the owner JOIN returns no rows. */
function stubSqlNoWatcher(): DbClient {
	return stubSql(null);
}

const ORG = "org-1";

describe("resolveActingPrincipal", () => {
	it("the trusted session watcher wins over the agent id AND a caller tag", async () => {
		// The session watcher is stamped by the executor (trusted), so it binds even
		// with an agentId and a different explicit tag present. It folds its owner.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitWatcherId: 7,
			sessionWatcherId: 9,
			sourceForMode: "direct-api",
		});
		expect(actor).toEqual({
			kind: "watcher",
			// The trusted SESSION watcher (9) wins over the caller-supplied tag (7).
			id: "watcher:9",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
			mode: "autonomous",
		});
	});

	it("an authed agent's caller-supplied tag for a FOREIGN watcher is ignored", async () => {
		// The exploit: a restricted agent tags a watcher owned by someone else (or a
		// nonexistent id) to null out ownerAgentId and skip its own deny rows. The
		// explicit tag must NOT override the authenticated agent identity.
		const actor = await resolveActingPrincipal(stubSql("other-owner"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitWatcherId: 7,
			sourceForMode: "direct-api",
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "agent-1",
			ownerAgentId: null,
			ownerResolved: true,
			mode: "attended",
		});
	});

	it("an authed agent tagging its OWN watcher is honored (owner matches)", async () => {
		const actor = await resolveActingPrincipal(stubSql("agent-1"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitWatcherId: 7,
			sourceForMode: "direct-api",
		});
		expect(actor).toEqual({
			kind: "watcher",
			id: "watcher:7",
			ownerAgentId: "agent-1",
			ownerResolved: true,
			mode: "autonomous",
		});
	});

	it("an explicit watcher_source binds the watcher + folds its owning agent, autonomous", async () => {
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			explicitWatcherId: 7,
			sourceForMode: "direct-api",
		});
		expect(actor).toEqual({
			kind: "watcher",
			id: "watcher:7",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
			mode: "autonomous",
		});
	});

	it("the reaction SESSION watcher binds even with no explicit watcher_source", async () => {
		// This is the reaction root fix: a script that omits watcher_source still
		// acts as its watcher, so its agent's envelope binds.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			sessionWatcherId: 9,
		});
		expect(actor).toEqual({
			kind: "watcher",
			id: "watcher:9",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
			mode: "autonomous",
		});
	});

	it("the trusted session watcher wins over an explicit tag (no retag to dodge policy)", async () => {
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			explicitWatcherId: 7,
			sessionWatcherId: 9,
		});
		expect(actor.id).toBe("watcher:9");
	});

	it("a plain user turn is attended with no owner to fold", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			userId: "user-1",
			sourceForMode: "direct-api",
		});
		expect(actor).toEqual({
			kind: "user",
			id: null,
			ownerAgentId: null,
			ownerResolved: true,
			mode: "attended",
		});
	});

	it("an agent on a watcher-run source is autonomous", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			agentId: "agent-1",
			sourceForMode: "watcher-run",
		});
		expect(actor.mode).toBe("autonomous");
	});

	it("a session watcher whose row is GONE resolves ownerResolved=false (gate fails closed)", async () => {
		// The reaction's watcher was hard-deleted mid-flight. We still act as the
		// watcher, but the owner lookup fails → ownerResolved=false, so the gate must
		// deny rather than run the write against the looser org default.
		const actor = await resolveActingPrincipal(stubSqlNoWatcher(), {
			organizationId: ORG,
			sessionWatcherId: 9,
		});
		expect(actor).toEqual({
			kind: "watcher",
			id: "watcher:9",
			ownerAgentId: null,
			ownerResolved: false,
			mode: "autonomous",
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
			sourceForMode: "direct-api",
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "deleted-agent",
			ownerAgentId: null,
			ownerResolved: false,
			mode: "attended",
		});
	});

	it("a session watcher whose OWNING AGENT was deleted resolves ownerResolved=false", async () => {
		// There is no watcher→agent FK, so an in-flight watcher's agent_id can dangle
		// after the owner is deleted. The owner JOIN requires the agent row, so the
		// lookup returns no rows → ownerResolved=false → gate denies. (stubSql(null)
		// models the JOIN finding nothing because the agent side is gone.)
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			sessionWatcherId: 9,
		});
		expect(actor.ownerResolved).toBe(false);
		expect(actor.kind).toBe("watcher");
	});
});
