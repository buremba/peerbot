import { describe, expect, it } from "bun:test";
import {
	ATLASSIAN_MCP_FEEDS,
	buildAtlassianMcpJql,
	isAtlassianMcpUrl,
	parseAtlassianCloudId,
	parseAtlassianMcpIssues,
} from "../../operations/atlassian-mcp-feed";

describe("Atlassian MCP virtual feed helpers", () => {
	it("recognizes the Rovo MCP host and ignores other MCP URLs", () => {
		expect(isAtlassianMcpUrl("https://mcp.atlassian.com/v1/mcp")).toBe(true);
		expect(isAtlassianMcpUrl("https://mcp.example.com/rpc")).toBe(false);
	});

	it("declares the same virtual issues feed the bundled Jira connector uses", () => {
		expect(ATLASSIAN_MCP_FEEDS.issues.key).toBe("issues");
		expect(ATLASSIAN_MCP_FEEDS.issues.virtual).toBe(true);
	});

	it("builds bounded JQL and AND-composes recall terms", () => {
		expect(buildAtlassianMcpJql({ baseQuery: "" })).toBe(
			"updated >= -90d ORDER BY updated DESC",
		);
		expect(
			buildAtlassianMcpJql({
				baseQuery: "project = KAN",
				terms: ["timeout"],
			}),
		).toBe('(project = KAN) AND (text ~ "timeout") ORDER BY updated DESC');
	});

	it("maps REST-shaped and flattened MCP issue payloads onto the Jira row", () => {
		const rows = parseAtlassianMcpIssues({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						issues: [
							{
								id: "10001",
								key: "KAN-1",
								fields: {
									summary: "Verify feed",
									status: { name: "To Do" },
									assignee: { displayName: "Ada" },
									labels: ["e2e"],
								},
							},
							{
								id: "10002",
								key: "KAN-2",
								summary: "Flat issue",
								status: "Done",
							},
						],
					}),
				},
			],
		});
		expect(rows).toEqual([
			expect.objectContaining({
				id: "10001",
				key: "KAN-1",
				summary: "Verify feed",
				status: "To Do",
				assignee: "Ada",
				labels: "e2e",
			}),
			expect.objectContaining({
				id: "10002",
				key: "KAN-2",
				summary: "Flat issue",
				status: "Done",
			}),
		]);
	});

	it("reads a cloud id out of accessible-resources MCP text", () => {
		expect(
			parseAtlassianCloudId({
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{ id: "49140293-40ce-45b6-8cdc-ec4e1356a7c8", url: "https://acme.atlassian.net" },
						]),
					},
				],
			}),
		).toBe("49140293-40ce-45b6-8cdc-ec4e1356a7c8");
	});
});
