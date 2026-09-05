/**
 * `manage_view_templates` is a union of per-action variants, so the schema —
 * not the handler — decides what each action requires and accepts. These pin
 * what the flat contract could not express: `json_template`, `version` and
 * `tab_name` are required by the one action that needs each rather than
 * checked by hand, a field that belongs to another action is an error on this
 * one instead of a silent no-op (the flat object accepted `version` on `set`),
 * and the registry's per-action access filtering — which only ever applied to
 * union variants — now keeps the write actions out of a read-scope listing.
 */
import { describe, expect, it } from "bun:test";
import { ManageViewTemplatesSchema } from "@lobu/core/contracts/tools/manage-view-templates";
import { getAllTools } from "../../tools/registry";
import { validateToolArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

const validate = (args: unknown) =>
	validateToolArgs("manage_view_templates", ManageViewTemplatesSchema, args);

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ToolUserError);
		return (err as ToolUserError).message;
	}
	throw new Error("expected validation to throw");
}

const ref = { resource_type: "entity_type", resource_id: "deal" } as const;

describe("manage_view_templates union contract", () => {
	it("requires json_template for set, version for rollback and tab_name for remove_tab, at the schema", () => {
		expect(messageOf(() => validate({ action: "set", ...ref }))).toMatch(/json_template/);
		expect(messageOf(() => validate({ action: "rollback", ...ref }))).toMatch(/version/);
		expect(messageOf(() => validate({ action: "remove_tab", ...ref }))).toMatch(/tab_name/);
	});

	it("rejects a field another action takes instead of ignoring it", () => {
		const set = messageOf(() =>
			validate({ action: "set", ...ref, json_template: { type: "div" }, version: 3 }),
		);
		expect(set).toMatch(/unknown argument\(s\): version/);
		expect(set).toMatch(
			/valid arguments for action 'set' are: action, resource_type, resource_id, json_template, tab_name, tab_order, change_notes$/,
		);

		const clear = messageOf(() => validate({ action: "clear", ...ref, tab_name: "Pipeline" }));
		expect(clear).toMatch(/unknown argument\(s\): tab_name/);
		expect(clear).toMatch(
			/valid arguments for action 'clear' are: action, resource_type, resource_id$/,
		);
	});

	it("accepts each action's full field set, with a numeric or slug resource_id", () => {
		expect(
			validate({
				action: "set",
				resource_type: "entity",
				resource_id: 42,
				json_template: { type: "div" },
				tab_name: "Pipeline",
				tab_order: 2,
				change_notes: "first cut",
			}),
		).toMatchObject({ resource_id: 42, tab_order: 2 });
		expect(validate({ action: "get", ...ref, tab_name: "Pipeline" })).toEqual({
			action: "get",
			...ref,
			tab_name: "Pipeline",
		});
		expect(validate({ action: "rollback", ...ref, version: 3 })).toEqual({
			action: "rollback",
			...ref,
			version: 3,
		});
		expect(validate({ action: "remove_tab", ...ref, tab_name: "Pipeline" })).toEqual({
			action: "remove_tab",
			...ref,
			tab_name: "Pipeline",
		});
		expect(validate({ action: "clear", ...ref })).toEqual({ action: "clear", ...ref });
	});
});

/**
 * What an MCP client actually sees: the union is flattened to one object
 * (hosts reject a top-level `anyOf`), so per-action requirements survive only
 * as prose on the `action` enum.
 */
describe("manage_view_templates wire schema", () => {
	const listedFor = (maxAccessLevel: "read" | "admin") =>
		getAllTools({ publicOnly: false, maxAccessLevel }).find(
			(tool) => tool.name === "manage_view_templates",
		);

	it("hides the write actions from a read-scope listing", () => {
		expect(listedFor("read")?.inputSchema.properties.action.enum).toEqual(["get"]);
		expect(listedFor("admin")?.inputSchema.properties.action.enum).toEqual([
			"set",
			"get",
			"rollback",
			"remove_tab",
			"clear",
		]);
	});

	it("names each action's required fields on the flattened enum", () => {
		const description: string =
			listedFor("admin")?.inputSchema.properties.action.description ?? "";
		const lineFor = (action: string) =>
			description.split("\n").find((line) => line.startsWith(`- ${action}:`));
		expect(lineFor("set")).toContain("Required: resource_type, resource_id, json_template.");
		expect(lineFor("get")).toContain("Required: resource_type, resource_id.");
		expect(lineFor("rollback")).toContain("Required: resource_type, resource_id, version.");
		expect(lineFor("remove_tab")).toContain("Required: resource_type, resource_id, tab_name.");
		expect(lineFor("clear")).toContain("Required: resource_type, resource_id.");
	});
});
