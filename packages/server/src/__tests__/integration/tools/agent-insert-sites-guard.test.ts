/**
 * Structural guard: every `INSERT INTO agents` site must seed the shared
 * fresh-agent provisioning defaults.
 *
 * This bug was six divergent create paths. Two baked a system-key `models` list,
 * one seeded only `pre_approved_tools`, and three seeded neither — so whether a
 * brand-new agent could run at all depended on which code path happened to
 * create it. Convergence is not self-enforcing: the next create path added
 * without `resolveNewAgentProvisioningDefaults()` silently reintroduces it, and
 * the symptom surfaces far away ("Agent reply finished without calling
 * completeWindow") with no hint at provisioning.
 *
 * So this test fails on an UNKNOWN insert site rather than trying to prove
 * runtime behavior. A new site is not necessarily wrong — but it must be looked
 * at and then listed here deliberately, which is the whole point.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// packages/server/src/__tests__/integration/tools → packages/server/src
const SERVER_SRC = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

/**
 * The sanctioned `INSERT INTO agents` sites, each of which must resolve its
 * fresh-agent defaults from the shared helper. Paths are relative to
 * `packages/server/src`.
 */
const SANCTIONED_INSERT_SITES = [
	// The shared UPSERT — reached by AgentMetadataStore.createAgent, i.e. the
	// POST /api/v1/agents route. Also the UPDATE path, so its DO UPDATE SET
	// clause deliberately omits models/pre_approved_tools.
	"lobu/stores/postgres-stores.ts",
	// The web UI create route (POST /agents).
	"lobu/agent-routes.ts",
	// The manage_agents create tool (MCP + REST proxy).
	"tools/admin/manage_agents.ts",
	// Boot provisioning for the org's default personal agent.
	"auth/default-provisioning.ts",
	// Boot provisioning for the org's builder/system agent.
	"auth/builder-provisioning.ts",
].sort();

const PROVISIONING_HELPER = "resolveNewAgentProvisioningDefaults";

function findAgentInsertSites(): string[] {
	// `git grep` keeps this honest against the real tree (respects .gitignore,
	// no stale build output) and is fast enough to run inline.
	const res = spawnSync(
		"git",
		["grep", "-l", "INSERT INTO agents", "--", "src/**/*.ts"],
		{ cwd: path.resolve(SERVER_SRC, ".."), encoding: "utf8" },
	);
	return res.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^src\//, ""))
		// Tests may insert agent rows freely — they are not production paths.
		.filter((file) => !file.includes("__tests__"))
		.sort();
}

describe("agents insert-site guard", () => {
	it("every INSERT INTO agents site is a known, sanctioned one", () => {
		const found = findAgentInsertSites();
		expect(found.length).toBeGreaterThan(0); // guard against a broken grep
		expect(found).toEqual(SANCTIONED_INSERT_SITES);
	});

	it("every sanctioned site resolves the shared provisioning defaults", async () => {
		for (const relPath of SANCTIONED_INSERT_SITES) {
			const source = await readFile(path.join(SERVER_SRC, relPath), "utf8");
			expect(
				source.includes(PROVISIONING_HELPER),
				`${relPath} inserts into agents but never calls ${PROVISIONING_HELPER}(). ` +
					"A freshly created agent must carry a system-key models list and the " +
					"lobu-memory pre-approval, or it silently fails to run.",
			).toBe(true);
		}
	});
});
