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

describe("resolveActingPrincipal", () => {
	it("a watcher channel wins over the agent id — it only tightens (folds the owner)", async () => {
		// Resolving to a watcher is strictly MORE restrictive than the agent alone:
		// it folds the owning agent's rows on top. So even with an agentId present,
		// a watcher channel binds the watcher — there's no way to escape agent policy.
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
});
