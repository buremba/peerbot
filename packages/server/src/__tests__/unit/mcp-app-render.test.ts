import { describe, expect, it } from "bun:test";
import type { Env } from "../../index";
import { renderLobuView } from "../../tools/mcp_app";
import type { ToolContext } from "../../tools/registry";

describe("render_lobu_view secure display boundary", () => {
	it("redacts credential-shaped text from model-selected blocks", async () => {
		const view = await renderLobuView(
			{
				action: "render",
				blocks: [
					{ type: "text", value: "Authorization: Bearer abcdefghijklmnop" },
					{ type: "code", value: "client_secret=super-secret-value" },
					{ type: "text", value: "ghp_abcdefghijklmnop" },
				],
			},
			{} as Env,
			{} as ToolContext,
		);

		expect(view.blocks).toEqual([
			{ type: "text", value: "Authorization=[redacted]" },
			{ type: "code", value: "client_secret=[redacted]" },
			{ type: "text", value: "[redacted]" },
		]);
	});
});
