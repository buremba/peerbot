/**
 * Contract-kernel equivalence + validation.
 *
 * 1. The access surface (per-(tool, action) tier + public readability + SDK
 *    manifests) must stay byte-identical to the fixture captured BEFORE the
 *    contract migration — proves contract-derived policy replaced the
 *    hand-written tables without any behavior change. This fixture is
 *    FROZEN: a diff here is an access-control change and must be reviewed as
 *    one (then regenerate deliberately).
 * 2. The visible tools/list surface is pinned by its own fixture; regenerate
 *    when the surface changes intentionally.
 * 3. Contracts must stay in lockstep with their TypeBox schemas and the SDK
 *    metadata (drift fails here, not in production).
 *
 * Regenerate fixtures (from packages/server):
 *   bun -e 'import { snapshotAccessSurface, snapshotToolsList } from "./src/tools/contracts/__tests__/snapshot-tool-surface.ts";
 *     await Bun.write("./src/tools/contracts/__tests__/fixtures/access-surface.snapshot.json", JSON.stringify(snapshotAccessSurface(), null, "\t"));
 *     await Bun.write("./src/tools/contracts/__tests__/fixtures/tools-list.snapshot.json", JSON.stringify(snapshotToolsList(), null, "\t"));'
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { METHOD_METADATA } from "../../../sandbox/method-metadata";
import { ManageSchedulesSchema } from "../../admin/manage_schedules";
import {
	ListWatchersSchema,
	ManageWatchersSchema,
} from "../../admin/manage_watchers";
import { GetWatcherSchema } from "../../get_watchers";
import {
	buildContractNamespace,
	CAPABILITY_CONTRACTS,
	type CapabilityContract,
} from "../index";
import {
	snapshotAccessSurface,
	snapshotToolsList,
} from "./snapshot-tool-surface";

const SCHEMAS_BY_TOOL: Record<string, unknown> = {
	manage_watchers: ManageWatchersSchema,
	list_watchers: ListWatchersSchema,
	get_watcher: GetWatcherSchema,
	manage_schedules: ManageSchedulesSchema,
};

function schemaActions(schema: any): Set<string> {
	const fromProperty = schema?.properties?.action;
	if (Array.isArray(fromProperty?.anyOf)) {
		return new Set(
			fromProperty.anyOf
				.map((v: any) => v?.const)
				.filter((v: unknown): v is string => typeof v === "string"),
		);
	}
	const variants = schema?.anyOf ?? schema?.oneOf;
	if (Array.isArray(variants)) {
		return new Set(
			variants
				.map((v: any) => v?.properties?.action?.const)
				.filter((v: unknown): v is string => typeof v === "string"),
		);
	}
	return new Set();
}

function fixture(name: string) {
	return JSON.parse(
		readFileSync(join(__dirname, "fixtures", name), "utf8"),
	);
}

describe("contract equivalence", () => {
	it("access surface is identical to the pre-migration fixture", () => {
		const live = JSON.parse(JSON.stringify(snapshotAccessSurface()));
		expect(live).toEqual(fixture("access-surface.snapshot.json"));
	});

	it("tools/list surface matches its fixture", () => {
		const live = JSON.parse(JSON.stringify(snapshotToolsList()));
		expect(live).toEqual(fixture("tools-list.snapshot.json"));
	});
});

describe("contract validation", () => {
	for (const contract of CAPABILITY_CONTRACTS as readonly CapabilityContract[]) {
		const hasPerActionPolicy = contract.tools.some((t) => t.actions);
		if (!hasPerActionPolicy && !contract.sdkNamespace) continue;
		describe(`capability ${contract.key}`, () => {
			for (const tool of contract.tools) {
				if (!tool.actions) continue;
				it(`${tool.name} contract actions match the TypeBox schema`, () => {
					const schema = SCHEMAS_BY_TOOL[tool.name];
					expect(
						schema,
						`add ${tool.name} to SCHEMAS_BY_TOOL in this test`,
					).toBeDefined();
					expect(new Set(Object.keys(tool.actions ?? {}))).toEqual(
						schemaActions(schema),
					);
				});
			}

			if (contract.sdkNamespace) {
				it("every SDK method (incl. docs-only) has METHOD_METADATA", () => {
					for (const m of contract.sdkMethods ?? []) {
						expect(
							METHOD_METADATA[`${contract.sdkNamespace}.${m.method}`],
							`${contract.sdkNamespace}.${m.method}`,
						).toBeDefined();
					}
				});

				it("generated namespace methods route to the contract action", async () => {
					const calls: Array<{ tool: string; args: any }> = [];
					const recordingHandler =
						(tool: string) => async (args: any) => {
							calls.push({ tool, args });
							return { ok: true };
						};
					const bindings = Object.fromEntries(
						contract.tools.map((t) => [t.name, recordingHandler(t.name)]),
					);
					const ns = buildContractNamespace(contract, bindings, {}, {});

					for (const m of contract.sdkMethods ?? []) {
						if (m.docsOnly) {
							expect(ns[m.method]).toBeUndefined();
							continue;
						}
						expect(ns[m.method]).toBeTypeOf("function");
						if (!m.action) continue;
						calls.length = 0;
						// A caller-supplied `action` must never override the contract's.
						await ns[m.method]({ action: "delete", watcher_id: 7 });
						expect(calls[0]?.tool).toBe(m.tool);
						expect(calls[0]?.args.action).toBe(m.action);
					}
				});
			}
		});
	}
});
