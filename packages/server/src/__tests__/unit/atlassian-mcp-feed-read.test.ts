import { beforeAll, describe, expect, it, mock } from "bun:test";

const calls: Array<{
	tool: string;
	args: Record<string, unknown>;
}> = [];

let responseMode: "normal" | "ambiguous-sites" = "normal";

mock.module("../../mcp-proxy/client", () => ({
	discoverTools: async () => [],
	assertSafeUrl: () => undefined,
	getMcpOAuthRequestedScopes: () => [],
	selectMcpOAuthClientAuthMethod: () => "none",
	registerMcpOAuthClient: async () => {
		throw new Error("unused in Atlassian feed read test");
	},
	probeMcpServer: async () => {
		throw new Error("unused in Atlassian feed read test");
	},
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
						text: JSON.stringify(
							responseMode === "ambiguous-sites"
								? [
										{ id: "cloud-1", url: "https://one.atlassian.net" },
										{ id: "cloud-2", url: "https://two.atlassian.net" },
									]
								: [{ id: "cloud-1", url: "https://acme.atlassian.net" }],
						),
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

let readAtlassianMcpFeed: typeof import("../../operations/atlassian-mcp-feed").readAtlassianMcpFeed;

beforeAll(async () => {
	({ readAtlassianMcpFeed } = await import("../../operations/atlassian-mcp-feed"));
});

describe("readAtlassianMcpFeed", () => {
	it("returns nextPageToken and passes it to the next source request", async () => {
		calls.length = 0;
		responseMode = "normal";
		const first = await readAtlassianMcpFeed({
			organizationId: "org-1",
			connectionId: 505,
			connectorKey: "mcp.mcp-atlassian-com",
			mcpConfig: {
				upstream_url: "https://mcp.atlassian.com/v1/mcp",
				tool_prefix: "mcp_atlassian_com",
			},
			feedConfig: { cloud_id: "cloud-1" },
			connectionConfig: {},
			baseQuery: "project = KAN",
			limit: 2,
		});

		expect(calls.map((call) => call.tool)).toEqual(["searchJiraIssuesUsingJql"]);
		expect(calls[0].args).toMatchObject({
			cloudId: "cloud-1",
			jql: "project = KAN ORDER BY updated DESC",
			maxResults: 2,
		});
		expect(first.rows.map((row) => row.key)).toEqual(["KAN-1", "KAN-2"]);
		expect(first.nextCursor).toBe("page-2");

		const second = await readAtlassianMcpFeed({
			organizationId: "org-1",
			connectionId: 505,
			connectorKey: "mcp.mcp-atlassian-com",
			mcpConfig: {
				upstream_url: "https://mcp.atlassian.com/v1/mcp",
				tool_prefix: "mcp_atlassian_com",
			},
			feedConfig: { cloud_id: "cloud-1" },
			connectionConfig: {},
			baseQuery: "project = KAN",
			cursor: first.nextCursor,
			limit: 2,
		});
		expect(calls[1].args.nextPageToken).toBe("page-2");
		expect(second.rows.map((row) => row.key)).toEqual(["KAN-3", "KAN-4"]);
		expect(second.hasMore).toBe(false);
	});

	it("rejects an ambiguous multi-site grant", async () => {
		calls.length = 0;
		responseMode = "ambiguous-sites";
		await expect(
			readAtlassianMcpFeed({
				organizationId: "org-1",
				connectionId: 505,
				connectorKey: "mcp.mcp-atlassian-com",
				mcpConfig: {
					upstream_url: "https://mcp.atlassian.com/v1/mcp",
					tool_prefix: "mcp_atlassian_com",
				},
				feedConfig: {},
				connectionConfig: {},
				baseQuery: "project = KAN",
			}),
		).rejects.toThrow("multiple accessible Jira sites");
	});

	it("rejects offsets so callers cannot force a provider page re-walk", async () => {
		calls.length = 0;
		responseMode = "normal";
		await expect(
			readAtlassianMcpFeed({
				organizationId: "org-1",
				connectionId: 505,
				connectorKey: "mcp.mcp-atlassian-com",
				mcpConfig: {
					upstream_url: "https://mcp.atlassian.com/v1/mcp",
					tool_prefix: "mcp_atlassian_com",
				},
				feedConfig: { cloud_id: "cloud-1", max_results: 1 },
				connectionConfig: {},
				baseQuery: "project = KAN",
				offset: 20,
				limit: 1,
			}),
		).rejects.toThrow("returned cursor");
		expect(calls).toHaveLength(0);
	});
});
