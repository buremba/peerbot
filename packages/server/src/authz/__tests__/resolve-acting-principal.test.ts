import { describe, expect, it } from "vitest";
import type { DbClient } from "../../db/client";
import { resolveActingPrincipal } from "../entity-policy";

/**
 * The single seam every write surface resolves identity through. It merges the
 * two channels an acting watcher arrives on (an explicit `watcher_source` and the
 * reaction session's own watcher), looks up the owning agent, and pins the mode —
 * so no call site has to merge them and a reaction can't dodge its agent's
 * envelope by omitting attribution. `sql` is stubbed to a fixed owner agent.
 */
function stubSql(ownerAgentId: string | null): DbClient {
	const sql = () => Promise.resolve([{ agent_id: ownerAgentId }]);
	return sql as unknown as DbClient;
}

/** A stub where the watcher row is GONE — the owner lookup returns no rows. */
function stubSqlNoWatcher(): DbClient {
	const sql = () => Promise.resolve([]);
	return sql as unknown as DbClient;
}

describe("resolveActingPrincipal", () => {
	it("the trusted session watcher wins over the agent id AND a caller tag", async () => {
		// The session watcher is stamped by the executor (trusted), so it binds even
		// with an agentId and a different explicit tag present. It folds its owner.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
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
			explicitWatcherId: 7,
			sessionWatcherId: 9,
		});
		expect(actor.id).toBe("watcher:9");
	});

	it("a plain user turn is attended with no owner to fold", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
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
});
