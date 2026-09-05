/**
 * `manage_conversations` is a union of per-action variants, so the schema —
 * not the handler — decides what each action requires and accepts. These pin
 * the three consequences the flat contract could not express: a field can be
 * required for one action while staying optional (or absent) for the others,
 * a field belonging to `send` is an error on `list` rather than silently
 * ignored, and the registry's per-action access filtering — which only ever
 * applied to union variants — now keeps write-tier `send` out of a read-scope
 * client's listing.
 */
import { describe, expect, it } from "bun:test";
import { ManageConversationsSchema } from "@lobu/core/contracts/tools/manage-conversations";
import { getAllTools } from "../../tools/registry";
import { validateToolArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

const validate = (args: unknown) =>
	validateToolArgs("manage_conversations", ManageConversationsSchema, args);

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ToolUserError);
		return (err as ToolUserError).message;
	}
	throw new Error("expected validation to throw");
}

describe("manage_conversations union contract", () => {
	it("requires conversation_id for get and text for send, at the schema", () => {
		expect(messageOf(() => validate({ action: "get", agent_id: "researcher" }))).toMatch(
			/conversation_id/,
		);
		expect(messageOf(() => validate({ action: "send", agent_id: "researcher" }))).toMatch(
			/text/,
		);
	});

	it("rejects a send field on list instead of ignoring it", () => {
		const msg = messageOf(() =>
			validate({ action: "list", agent_id: "researcher", text: "hi", wait: true }),
		);
		expect(msg).toMatch(/unknown argument\(s\): text, wait/);
		expect(msg).toMatch(/valid arguments for action 'list' are: action, agent_id/);
	});

	it("accepts each action's full field set", () => {
		expect(validate({ action: "list", agent_id: "researcher" })).toEqual({
			action: "list",
			agent_id: "researcher",
		});
		expect(
			validate({ action: "get", agent_id: "researcher", platform: "slack", conversation_id: "c1" }),
		).toMatchObject({ conversation_id: "c1" });
		expect(
			validate({
				action: "send",
				agent_id: "researcher",
				thread: "daily",
				text: "hi",
				model: "openai/gpt-5",
				wait: false,
				timeout_ms: 5000,
			}),
		).toMatchObject({ text: "hi", timeout_ms: 5000 });
	});
});

/**
 * What an MCP client actually sees: the union is flattened to one object
 * (hosts reject a top-level `anyOf`), so per-action requirements survive only
 * as prose on the `action` enum — and a duplicated property keeps the FIRST
 * variant's description, which is why `conversation_id` documents both the
 * action that requires it and the one that treats it as optional.
 */
describe("manage_conversations wire schema", () => {
	const listedFor = (maxAccessLevel: "read" | "admin") =>
		getAllTools({ publicOnly: false, maxAccessLevel }).find(
			(tool) => tool.name === "manage_conversations",
		);

	it("hides write-tier send from a read-scope listing", () => {
		expect(listedFor("read")?.inputSchema.properties.action.enum).toEqual([
			"list",
			"get",
		]);
		expect(listedFor("admin")?.inputSchema.properties.action.enum).toEqual([
			"list",
			"get",
			"send",
		]);
	});

	it("names each action's required fields on the flattened enum", () => {
		const description: string =
			listedFor("admin")?.inputSchema.properties.action.description ?? "";
		const lineFor = (action: string) =>
			description.split("\n").find((line) => line.startsWith(`- ${action}:`));
		expect(lineFor("list")).toContain("Required: agent_id.");
		expect(lineFor("get")).toContain("Required: agent_id, conversation_id.");
		expect(lineFor("send")).toContain("Required: agent_id, text.");
	});

	it("documents conversation_id for both actions that carry it", () => {
		const description: string =
			listedFor("admin")?.inputSchema.properties.conversation_id.description ??
			"";
		expect(description).toContain("`get`");
		expect(description).toContain("`send`");
	});
});
