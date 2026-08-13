import { beforeAll, describe, expect, it, mock } from "bun:test";

const calls: Array<{
	tool: string;
	args: Record<string, unknown>;
}> = [];

mock.module("../../mcp-proxy/client", () => ({
	callTool: async (
		_connectorKey: string,
		_config: unknown,
		_orgId: string,
		toolName: string,
		toolArgs: Record<string, unknown>,
	) => {
		calls.push({ tool: toolName, args: toolArgs });
		if (toolName === "getAccessibleAtlassianResources") {
			return {
				isError: false,
				content: [
					{
						type: "text",
						text: JSON.stringify([{ id: "cloud-1", url: "https://acme.atlassian.net" }]),
					},
				],
			};
		}
		const token = typeof toolArgs.nextPageToken === "string" ? toolArgs.nextPageToken : undefined;
		if (!token) {
			return {
				isError: false,
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{ id: "1", key: "KAN-1", summary: "one" },
								{ id: "2", key: "KAN-2", summary: "two" },
							],
							nextPageToken: "page-2",
						}),
					},
				],
			};
		}
		return {
			isError: false,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						issues: [
							{ id: "3", key: "KAN-3", summary: "three" },
							{ id: "4", key: "KAN-4", summary: "four" },
						],
					}),
				},
			],
		};
	},
}));

let readAtlassianMcpVirtualFeed: typeof import("../../operations/atlassian-mcp-feed").readAtlassianMcpVirtualFeed;

beforeAll(async () => {
	({ readAtlassianMcpVirtualFeed } = await import("../../operations/atlassian-mcp-feed"));
});

describe("readAtlassianMcpVirtualFeed", () => {
	it("pages with nextPageToken and windows offset/limit across pages", async () => {
		calls.length = 0;
		const result = await readAtlassianMcpVirtualFeed({
			organizationId: "org-1",
			connectionId: 505,
			connectorKey: "mcp.mcp-atlassian-com",
			mcpConfig: {
				upstream_url: "https://mcp.atlassian.com/v1/mcp",
				tool_prefix: "mcp_atlassian_com",
			},
			feedConfig: {},
			connectionConfig: {},
			query: "project = KAN",
			offset: 2,
			limit: 2,
		});

		expect(calls.map((call) => call.tool)).toEqual([
			"getAccessibleAtlassianResources",
			"searchJiraIssuesUsingJql",
			"searchJiraIssuesUsingJql",
		]);
		expect(calls[1].args).toMatchObject({
			cloudId: "cloud-1",
			jql: "project = KAN ORDER BY updated DESC",
			maxResults: 2,
		});
		expect(calls[1].args.nextPageToken).toBeUndefined();
		expect(calls[2].args.nextPageToken).toBe("page-2");
		expect(result.rows.map((row) => row.key)).toEqual(["KAN-3", "KAN-4"]);
	});
});
