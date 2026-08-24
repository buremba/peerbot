import { describe, expect, it } from "bun:test";
import {
	ATLASSIAN_MCP_FEEDS,
	buildAtlassianMcpJql,
	isAtlassianMcpUrl,
	parseAtlassianMcpIssues,
	parseAtlassianMcpJiraSite,
	parseAtlassianMcpNextPageToken,
} from "../../operations/atlassian-mcp-feed";

describe("Atlassian MCP feed helpers", () => {
	it("recognizes the Rovo MCP host and ignores other MCP URLs", () => {
		expect(isAtlassianMcpUrl("https://mcp.atlassian.com/v1/mcp")).toBe(true);
		expect(isAtlassianMcpUrl("https://mcp.example.com/rpc")).toBe(false);
	});

	it("declares a source-readable issues feed", () => {
		expect(ATLASSIAN_MCP_FEEDS.issues.key).toBe("issues");
		expect(ATLASSIAN_MCP_FEEDS.issues.operations).toEqual(["read"]);
	});

	it("builds bounded JQL and AND-composes caller JQL", () => {
		expect(buildAtlassianMcpJql({ baseQuery: "" })).toBe(
			"updated >= -90d ORDER BY updated DESC",
		);
		expect(
			buildAtlassianMcpJql({
				baseQuery: "project = KAN",
				query: 'text ~ "timeout"',
			}),
		).toBe('(project = KAN) AND (text ~ "timeout") ORDER BY updated DESC');
	});

	it("rejects caller ORDER BY instead of replacing the configured ordering", () => {
		expect(() =>
			buildAtlassianMcpJql({
				baseQuery: "project = KAN ORDER BY updated DESC",
				query: "status = Open ORDER BY key ASC",
			}),
		).toThrow("use the separate sort field");
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

	it("reads nextPageToken out of an MCP tools/call payload", () => {
		expect(
			parseAtlassianMcpNextPageToken({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [{ id: "1", key: "KAN-1" }],
							nextPageToken: "cursor-2",
						}),
					},
				],
			}),
		).toBe("cursor-2");
	});

	it("reads a cloud id out of accessible-resources MCP text", () => {
		expect(
			parseAtlassianMcpJiraSite({
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{ id: "49140293-40ce-45b6-8cdc-ec4e1356a7c8", url: "https://acme.atlassian.net" },
						]),
					},
				],
			})?.cloudId,
		).toBe("49140293-40ce-45b6-8cdc-ec4e1356a7c8");
	});

	it("fails closed instead of choosing the first accessible Jira site", () => {
		expect(
			parseAtlassianMcpJiraSite({
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{ id: "cloud-1", url: "https://one.atlassian.net" },
							{ id: "cloud-2", url: "https://two.atlassian.net" },
						]),
					},
				],
			}),
		).toBeNull();
	});
});
