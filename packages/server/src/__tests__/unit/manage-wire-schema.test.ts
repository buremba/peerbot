/**
 * Invariant tests over the SERIALIZED wire schema for the `manage_*` admin
 * tools — what an MCP client actually sees in `tools/list`. These are
 * property assertions (not snapshots) guarding the discoverability invariants
 * established when `flattenUnionSchema` started deriving per-action metadata
 * from the variants. A failure here is a real regression in what clients can
 * discover about the action surface; read the failing assertion, not a diff.
 *
 * DB-free: the registry's tool list is static after module load, so
 * `getAllTools()` returns the same serialized shape regardless of auth/DB
 * state. Mirrors `validate-args.test.ts` (also `bun:test`, also under
 * `src/__tests__/unit/`, also imports the registry directly).
 */
import { describe, expect, it } from "bun:test";
import { getAllTools } from "../../tools/registry";
import { SdkScriptResultSchema } from "../../tools/sdk_run";
import { validateToolResult } from "../../tools/validate-args";

const TOOLS = getAllTools({ publicOnly: false, maxAccessLevel: "admin" });
const byName = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Extract the action-name strings a client sees on the wire. Handles both
 * shapes the registry emits: flattened unions expose `action.enum`, flat-style
 * tools expose `action.anyOf` of const literals. Mirrors `actionsOf()` in
 * `auth/__tests__/tool-access.test.ts`.
 */
function actionsOf(schema: any): string[] | null {
	const action = schema?.properties?.action;
	if (Array.isArray(action?.enum)) return action.enum.map(String);
	if (typeof action?.const === "string") return [action.const];
	if (Array.isArray(action?.anyOf)) {
		const consts = action.anyOf
			.map((v: any) => v?.const)
			.filter((v: unknown): v is string => typeof v === "string");
		return consts.length > 0 ? consts : null;
	}
	return null;
}

/** Tools whose input schema is a discriminated union of action variants. */
const MANAGE_TOOLS = TOOLS.filter((t) => t.name.startsWith("manage_"));

describe("manage_* wire schema: action discoverability", () => {
	it("every manage_* tool exposes a flat object input schema (no top-level anyOf/oneOf)", () => {
		for (const tool of MANAGE_TOOLS) {
			const schema = tool.inputSchema as any;
			expect(schema.type, `${tool.name} inputSchema must be an object`).toBe(
				"object",
			);
			expect(
				schema.anyOf ?? schema.oneOf,
				`${tool.name} must not leak a top-level union to the wire`,
			).toBeUndefined();
		}
	});

	it("every manage_* tool exposes a non-empty action set", () => {
		for (const tool of MANAGE_TOOLS) {
			const actions = actionsOf(tool.inputSchema);
			expect(
				actions && actions.length > 0,
				`${tool.name} should expose at least one action`,
			).toBe(true);
		}
	});

	it("every action a client can pick carries a description (no bare enum/const)", () => {
		// Two shapes reach the wire and both must stay self-describing:
		//
		//  - Union-flattened tools (manage_connections, manage_catalog, ...):
		//    `action.enum` + a generated multi-line `description` that names
		//    each action. A new variant added without a per-action description
		//    would render as a bare `- name` line — caught by asserting the
		//    description line for each action contains a colon (prose follows).
		//
		//  - Flat tools (manage_entity, manage_agents, ...): `action.anyOf` of
		//    `{const, description}` literals — the per-action prose lives on
		//    each literal, not the field. Assert each anyOf entry has non-empty
		//    description text.
		for (const tool of MANAGE_TOOLS) {
			const action = (tool.inputSchema as any)?.properties?.action;
			if (!action) continue;

			if (Array.isArray(action.anyOf)) {
				for (const entry of action.anyOf) {
					if (typeof entry?.const !== "string") continue;
					expect(
						typeof entry.description === "string" &&
							entry.description.trim().length > 0,
						`${tool.name}: action '${entry.const}' has no description in anyOf`,
					).toBe(true);
				}
				continue;
			}

			if (Array.isArray(action.enum)) {
				const description: string = action.description ?? "";
				for (const name of action.enum) {
					// Generated lines look like `- name: prose. Required: ...`.
					// A bare `- name` (no colon) means the variant lacks a
					// per-action description. Anchor the match so `list` can't
					// hit the `- list_channel_bindings:` line and false-pass.
					const line = description
						.split("\n")
						.find((l) => l === `- ${name}` || l.startsWith(`- ${name}:`) || l.startsWith(`- ${name} `));
					expect(
						line && line.includes(":"),
						`${tool.name}: action '${name}' has no prose on the wire (line: ${line ?? "<missing>"})`,
					).toBe(true);
				}
			}
		}
	});
});

describe("manage_connections × manage_catalog: the browse → install link", () => {
	it("manage_catalog outputSchema references source_uri (machine-traceable)", () => {
		const catalog = byName.get("manage_catalog");
		expect(catalog, "manage_catalog must be registered").toBeDefined();
		// outputSchema is the raw union; stringify to scan all variants without
		// walking the anyOf. The point is that `source_uri` is structurally
		// declared, not buried under Type.Unknown().
		const out = JSON.stringify(catalog?.outputSchema);
		expect(
			out.includes("source_uri"),
			"manage_catalog outputSchema must declare source_uri so clients can trace it to install_connector",
		).toBe(true);
	});

	it("manage_connections inputSchema has connector_id and source_uri install paths", () => {
		const conns = byName.get("manage_connections");
		const connectorId = (conns?.inputSchema as any)?.properties?.connector_id;
		const sourceUri = (conns?.inputSchema as any)?.properties?.source_uri;
		expect(connectorId, "manage_connections must accept connector_id").toBeDefined();
		expect(sourceUri, "manage_connections must accept source_uri").toBeDefined();
		expect(
			connectorId?.description?.includes("install_connector"),
			`connector_id description must name install_connector; got: ${connectorId?.description}`,
		).toBe(true);
		expect(
			sourceUri?.description?.includes("install_connector"),
			`source_uri description must name install_connector; got: ${sourceUri?.description}`,
		).toBe(true);
	});

	it("install_connector surfaces the XOR source constraint in its action description", () => {
		const conns = byName.get("manage_connections");
		const description: string =
			(conns?.inputSchema as any)?.properties?.action?.description ?? "";
		// The variant description names the mutually-exclusive install inputs.
		expect(
			description.includes("install_connector"),
			"action enum must describe install_connector",
		).toBe(true);
		expect(
			description.includes("connector_id"),
			"install_connector description must mention catalog connector_id",
		).toBe(true);
		expect(
			description.toLowerCase().includes("exactly one") ||
				description.toLowerCase().includes("mutually exclusive"),
			`install_connector description must document the source XOR constraint; got:\n${description}`,
		).toBe(true);
	});

	it("each tool's top-level description names the other (workflow link)", () => {
		const catalogDesc = byName.get("manage_catalog")?.description ?? "";
		const connsDesc = byName.get("manage_connections")?.description ?? "";
		expect(
			catalogDesc.includes("manage_connections"),
			"manage_catalog description should point to manage_connections",
		).toBe(true);
		expect(
			connsDesc.includes("manage_catalog"),
			"manage_connections description should point to manage_catalog",
		).toBe(true);
	});
});

describe("run_sdk / query_sdk: script contract on the wire", () => {
	it("both tools advertise the sandbox result outputSchema", () => {
		for (const name of ["run_sdk", "query_sdk"]) {
			const tool = byName.get(name);
			expect(tool?.outputSchema, `${name} must declare outputSchema`).toBeDefined();
			const out = JSON.stringify(tool?.outputSchema);
			expect(out.includes("return_value"), `${name} outputSchema must declare return_value`).toBe(true);
		}
	});

	it("a representative runSandbox result validates against SdkScriptResultSchema", () => {
		// Mirrors the object assembled in sdk_run.ts runSandbox(). If this
		// drifts (renamed field, changed type), structuredContent silently
		// degrades to text-only — catch it here instead.
		const sample = {
			success: false,
			return_value: { anything: [1, "two", null] },
			logs: [{ level: "warn", message: "m", data: { k: 1 }, ts: 123 }],
			error: { name: "TypeError", message: "boom", stack: "s", line: 3, column: 7 },
			duration_ms: 42,
			sdk_calls: 2,
			sdk_call_trace: [
				{ path: "entities.list", orgPath: [], access: "read", args: [{}], skipped: false },
			],
			side_effect_preview: [
				{ path: "entities.create", orgPath: ["acme"], access: "write", args: [{}], skipped: true },
				{ path: "connections.connect", orgPath: ["acme"], access: "admin", args: [{}], skipped: true },
			],
			dry_run: true,
		};
		expect(validateToolResult(SdkScriptResultSchema, sample)).not.toBeNull();
		// Success path: optional fields absent (undefined is dropped on the wire).
		const minimal = {
			success: true,
			logs: [],
			duration_ms: 1,
			sdk_calls: 0,
			sdk_call_trace: [],
			side_effect_preview: [],
			dry_run: false,
		};
		expect(validateToolResult(SdkScriptResultSchema, minimal)).not.toBeNull();
	});

	it("the script field documents ctx and where the return value lands", () => {
		for (const name of ["run_sdk", "query_sdk"]) {
			const script = (byName.get(name)?.inputSchema as any)?.properties?.script;
			expect(script?.description?.includes("organization_id"), `${name} script must document ctx`).toBe(true);
			expect(script?.description?.includes("return_value"), `${name} script must document return_value`).toBe(true);
			expect(script?.description?.includes("search_sdk"), `${name} script must point at search_sdk`).toBe(true);
		}
	});
});

describe("manage_connections: per-action required fields surface on the wire", () => {
	// Spot-check a few actions whose required fields are non-trivial. The
	// general invariant (every action's required fields named in the enum
	// description) holds because flattenUnionSchema derives them from each
	// variant's `required` array; these assertions pin it for the actions a
	// client is most likely to call blind.
	const conns = byName.get("manage_connections");
	const description: string =
		(conns?.inputSchema as any)?.properties?.action?.description ?? "";

	it("get names connection_id as required", () => {
		expect(description).toContain("get:");
		// The "Required:" segment for get should name connection_id.
		const getLine = description.split("\n").find((l) => l.startsWith("- get:"));
		expect(getLine).toBeDefined();
		expect(getLine?.includes("connection_id")).toBe(true);
	});

	it("connect names connector_key as required", () => {
		const line = description.split("\n").find((l) => l.startsWith("- connect:"));
		expect(line).toBeDefined();
		expect(line?.includes("connector_key")).toBe(true);
	});

	it("bind_channel names agent_id, connection_id, channel_id as required", () => {
		const line = description
			.split("\n")
			.find((l) => l.startsWith("- bind_channel:"));
		expect(line).toBeDefined();
		for (const f of ["agent_id", "connection_id", "channel_id"]) {
			expect(line?.includes(f), `bind_channel required line missing ${f}`).toBe(
				true,
			);
		}
	});
});
