/**
 * Atlassian Rovo MCP virtual-feed adapter.
 *
 * MCP install is tools-only (`feeds: null`). Rovo already exposes
 * `searchJiraIssuesUsingJql`, the same primitive the bundled Jira virtual
 * feed uses. This module stamps that feed onto an Atlassian MCP definition
 * and reads it through the existing MCP proxy — no second connector, no
 * approval-gated manage_operations execute.
 */

import { callTool } from "../mcp-proxy/client";
import type { McpProxyConfig } from "../mcp-proxy/types";

export const ATLASSIAN_JIRA_ISSUES_FEED_KEY = "issues";

export const ATLASSIAN_JIRA_ISSUE_COLUMNS = [
	{ name: "id", type: "string" },
	{ name: "key", type: "string" },
	{ name: "summary", type: "string" },
	{ name: "status", type: "string" },
	{ name: "assignee", type: "string" },
	{ name: "reporter", type: "string" },
	{ name: "priority", type: "string" },
	{ name: "project_key", type: "string" },
	{ name: "project_name", type: "string" },
	{ name: "labels", type: "string" },
	{ name: "created_at", type: "string" },
	{ name: "updated_at", type: "string" },
	{ name: "description", type: "string" },
	{ name: "url", type: "string" },
] as const;

/** Same issues feed the bundled Jira connector declares. */
export const ATLASSIAN_MCP_FEEDS = {
	issues: {
		key: ATLASSIAN_JIRA_ISSUES_FEED_KEY,
		name: "Issues",
		description:
			"Live Jira issues via JQL. Reads call Rovo searchJiraIssuesUsingJql; nothing is copied into events.",
		virtual: true,
		configSchema: {
			type: "object",
			properties: {
				cloud_id: {
					type: "string",
					description:
						"Atlassian Cloud id (usually auto-set on the connection after OAuth). Optional feed-level override for multi-site tokens.",
				},
				query: {
					type: "string",
					description:
						"Base JQL for virtual reads (platform config.query). Empty defaults to updated >= -90d.",
				},
				jql: {
					type: "string",
					description:
						"Fallback JQL when query is unset (same as the bundled Jira feed).",
				},
				max_results: {
					type: "integer",
					minimum: 1,
					maximum: 100,
					description:
						"Optional cap on issues returned per virtual-feed read. The uncapped default request size is 50.",
				},
			},
		},
		eventKinds: {
			issue: {
				description: "A Jira issue",
				metadataSchema: {
					type: "object",
					properties: {
						key: { type: "string" },
						status: { type: "string" },
						assignee: { type: "string" },
						reporter: { type: "string" },
						updated_at: { type: "string" },
					},
				},
			},
			comment: {
				description: "A comment on a Jira issue",
				metadataSchema: {
					type: "object",
					properties: {
						updated_at: { type: "string" },
					},
				},
			},
		},
	},
};

const SORT_COLUMNS: Record<string, string> = {
	updated: "updated",
	updated_at: "updated",
	created: "created",
	created_at: "created",
	key: "key",
	priority: "priority",
	status: "status",
};

export function isAtlassianMcpUrl(url: string | null | undefined): boolean {
	if (!url) return false;
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "mcp.atlassian.com" || host.endsWith(".mcp.atlassian.com");
	} catch {
		return false;
	}
}

export function isAtlassianMcpConfig(
	raw: Record<string, unknown> | null | undefined,
): raw is Record<string, unknown> & { upstream_url: string } {
	if (!raw) return false;
	const upstream =
		typeof raw.upstream_url === "string"
			? raw.upstream_url
			: typeof raw.upstreamUrl === "string"
				? raw.upstreamUrl
				: null;
	return isAtlassianMcpUrl(upstream);
}

export function normalizeMcpProxyConfig(
	raw: Record<string, unknown>,
): McpProxyConfig | null {
	const upstream =
		typeof raw.upstream_url === "string"
			? raw.upstream_url
			: typeof raw.upstreamUrl === "string"
				? raw.upstreamUrl
				: null;
	if (!upstream) return null;
	return {
		upstream_url: upstream,
		tool_prefix:
			typeof raw.tool_prefix === "string"
				? raw.tool_prefix
				: typeof raw.toolPrefix === "string"
					? raw.toolPrefix
					: "",
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function actorName(user: unknown): string | undefined {
	if (!user || typeof user !== "object") {
		return typeof user === "string" && user.trim() ? user.trim() : undefined;
	}
	const record = user as Record<string, unknown>;
	return (
		asString(record.displayName) ??
		asString(record.emailAddress) ??
		asString(record.name)
	);
}

function namedField(value: unknown): string | undefined {
	if (typeof value === "string") return asString(value);
	if (!value || typeof value !== "object") return undefined;
	return asString((value as Record<string, unknown>).name);
}

function adfToText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	const node = value as { type?: string; text?: string; content?: unknown[] };
	if (node.type === "hardBreak") return "\n";
	if (typeof node.text === "string") return node.text;
	if (Array.isArray(node.content)) {
		return node.content.map((child) => adfToText(child)).join("").trim();
	}
	return "";
}

function escapeJqlString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function splitTrailingOrderBy(jql: string): { body: string; orderBy: string | null } {
	let quote: '"' | "'" | null = null;
	let escaped = false;
	let depth = 0;
	for (let i = 0; i < jql.length; i += 1) {
		const char = jql[i];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (
			depth === 0 &&
			(i === 0 || /\s/.test(jql[i - 1])) &&
			/^order\s+by\b/i.test(jql.slice(i))
		) {
			return { body: jql.slice(0, i).trim(), orderBy: jql.slice(i).trim() };
		}
	}
	return { body: jql.trim(), orderBy: null };
}

export function buildAtlassianMcpJql(args: {
	baseQuery: string;
	terms?: string[];
	sort?: { column: string; order: "asc" | "desc" };
}): string {
	const trimmed = args.baseQuery.trim();
	const jql = trimmed.length > 0 ? trimmed : "updated >= -90d";
	let { body, orderBy } = splitTrailingOrderBy(jql);
	if (!body && orderBy) body = "updated >= -90d";

	const terms = (args.terms ?? []).map((term) => term.trim()).filter(Boolean);
	if (terms.length > 0) {
		const textClauses = terms
			.map((term) => `text ~ "${escapeJqlString(term)}"`)
			.join(" AND ");
		body = body.length > 0 ? `(${body}) AND (${textClauses})` : textClauses;
	}

	if (orderBy) {
		if (args.sort) {
			throw new Error(
				"Jira virtual feed: cannot apply sort when the base JQL already contains ORDER BY",
			);
		}
		return body.length > 0 ? `${body} ${orderBy}` : orderBy;
	}

	if (args.sort) {
		const field = SORT_COLUMNS[args.sort.column];
		if (!field) {
			throw new Error(
				`Jira virtual feed sort column '${args.sort.column}' is unsupported`,
			);
		}
		const dir = args.sort.order === "asc" ? "ASC" : "DESC";
		return body.length > 0
			? `${body} ORDER BY ${field} ${dir}`
			: `ORDER BY ${field} ${dir}`;
	}

	return body.length > 0
		? `${body} ORDER BY updated DESC`
		: "updated >= -90d ORDER BY updated DESC";
}

function issueUrl(
	issue: Record<string, unknown>,
	fields: Record<string, unknown>,
	config: Record<string, unknown>,
): string | undefined {
	const key = asString(issue.key);
	const siteUrl = asString(config.site_url);
	const cloudId = asString(config.cloud_id);
	const siteCloudId = asString(config.site_cloud_id);
	if (siteUrl && key && cloudId && siteCloudId && cloudId === siteCloudId) {
		return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
	}
	return asString(issue.self) ?? asString(fields.url) ?? asString(issue.url);
}

export function mapAtlassianIssueToRow(
	raw: unknown,
	config: Record<string, unknown> = {},
): Record<string, unknown> | null {
	if (!raw || typeof raw !== "object") return null;
	const issue = raw as Record<string, unknown>;
	const fields =
		issue.fields && typeof issue.fields === "object"
			? (issue.fields as Record<string, unknown>)
			: issue;
	const id = asString(issue.id) ?? asString(issue.key) ?? asString(fields.id);
	if (!id) return null;
	const labelsRaw = fields.labels ?? issue.labels;
	const labels = Array.isArray(labelsRaw)
		? labelsRaw.filter((label): label is string => typeof label === "string").join(", ")
		: asString(labelsRaw) ?? null;
	return {
		id,
		key: asString(issue.key) ?? asString(fields.key) ?? null,
		summary: asString(fields.summary) ?? asString(issue.summary) ?? null,
		status: namedField(fields.status) ?? namedField(issue.status) ?? null,
		assignee: actorName(fields.assignee ?? issue.assignee) ?? null,
		reporter: actorName(fields.reporter ?? issue.reporter) ?? null,
		priority: namedField(fields.priority) ?? namedField(issue.priority) ?? null,
		project_key:
			asString((fields.project as { key?: unknown } | undefined)?.key) ??
			asString(fields.projectKey) ??
			asString(issue.project_key) ??
			null,
		project_name:
			asString((fields.project as { name?: unknown } | undefined)?.name) ??
			asString(fields.projectName) ??
			null,
		labels,
		created_at: asString(fields.created) ?? asString(issue.created) ?? null,
		updated_at: asString(fields.updated) ?? asString(issue.updated) ?? null,
		description:
			adfToText(fields.description ?? issue.description) || null,
		url: issueUrl(issue, fields, config) ?? null,
	};
}

function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.search(/[\[{]/);
		if (start < 0) return null;
		try {
			return JSON.parse(trimmed.slice(start));
		} catch {
			return null;
		}
	}
}

function collectIssues(value: unknown, into: unknown[]): void {
	if (!value) return;
	if (Array.isArray(value)) {
		for (const item of value) collectIssues(item, into);
		return;
	}
	if (typeof value === "string") {
		collectIssues(tryParseJson(value), into);
		return;
	}
	if (typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") {
		collectIssues(tryParseJson(record.text), into);
		return;
	}
	if (Array.isArray(record.issues)) {
		into.push(...record.issues);
		return;
	}
	if (Array.isArray(record.values)) {
		into.push(...record.values);
		return;
	}
	if (Array.isArray(record.content)) {
		collectIssues(record.content, into);
		return;
	}
	if (asString(record.id) || asString(record.key)) {
		into.push(record);
	}
}

export function parseAtlassianMcpIssues(
	payload: unknown,
	config: Record<string, unknown> = {},
): Record<string, unknown>[] {
	const collected: unknown[] = [];
	collectIssues(payload, collected);
	const rows: Record<string, unknown>[] = [];
	for (const item of collected) {
		const row = mapAtlassianIssueToRow(item, config);
		if (row) rows.push(row);
	}
	return rows;
}

export function parseAtlassianMcpNextPageToken(payload: unknown): string | undefined {
	if (!payload) return undefined;
	if (typeof payload === "string") {
		return parseAtlassianMcpNextPageToken(tryParseJson(payload));
	}
	if (Array.isArray(payload)) {
		for (const item of payload) {
			const token = parseAtlassianMcpNextPageToken(item);
			if (token) return token;
		}
		return undefined;
	}
	if (typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") {
		return parseAtlassianMcpNextPageToken(tryParseJson(record.text));
	}
	return (
		asString(record.nextPageToken) ??
		asString(record.next_page_token) ??
		parseAtlassianMcpNextPageToken(record.content)
	);
}

function mcpTextError(content: unknown, fallback: string): string {
	if (Array.isArray(content)) {
		const text = (content[0] as { text?: string } | undefined)?.text;
		if (typeof text === "string" && text.trim()) return text;
	}
	return fallback;
}

export function parseAtlassianCloudId(payload: unknown): string | undefined {
	const collected: unknown[] = [];
	collectIssues(payload, collected);
	if (typeof payload === "object" && payload) collected.unshift(payload);
	for (const item of collected) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const id =
			asString(record.id) ??
			asString(record.cloudId) ??
			asString(record.cloud_id);
		if (id) return id;
	}
	if (typeof payload === "string") {
		const parsed = tryParseJson(payload);
		if (parsed !== payload) return parseAtlassianCloudId(parsed);
	}
	return undefined;
}

export async function readAtlassianMcpVirtualFeed(params: {
	organizationId: string;
	connectionId: number;
	connectorKey: string;
	mcpConfig: McpProxyConfig;
	feedConfig: Record<string, unknown>;
	connectionConfig: Record<string, unknown>;
	query: string;
	terms?: string[];
	limit?: number;
	offset?: number;
	sort?: { column: string; order: "asc" | "desc" };
}): Promise<{
	rows: Record<string, unknown>[];
	columns: { name: string; type: string }[];
	total?: number;
}> {
	const config = { ...params.connectionConfig, ...params.feedConfig };
	let cloudId = asString(config.cloud_id) ?? asString(config.cloudId);
	if (!cloudId) {
		const resources = await callTool(
			params.connectorKey,
			params.mcpConfig,
			params.organizationId,
			"getAccessibleAtlassianResources",
			{},
			params.connectionId,
		);
		if (resources.isError) {
			throw new Error("Atlassian MCP did not return an accessible site for this connection");
		}
		cloudId = parseAtlassianCloudId(resources.content);
	}
	if (!cloudId) {
		throw new Error(
			"Jira virtual feed requires a cloud_id. Reconnect the Atlassian connection or set config.cloud_id.",
		);
	}

	const jql = buildAtlassianMcpJql({
		baseQuery: params.query,
		terms: params.terms,
		sort: params.sort,
	});
	const offset = Math.max(0, params.offset ?? 0);
	const limit = Math.max(1, params.limit ?? 50);
	const pageSize = Math.min(
		100,
		Math.max(1, Number(config.max_results) || Math.min(limit, 50)),
	);
	const needed = offset + limit;
	const rows: Record<string, unknown>[] = [];
	let nextPageToken: string | undefined;

	// Walk Rovo pages until the requested window is filled. Jira's token has
	// no random access, so we fetch and discard the prefix — same as bundled
	// jira liveSearch.
	for (let page = 0; page < 20 && rows.length < needed; page += 1) {
		const result = await callTool(
			params.connectorKey,
			params.mcpConfig,
			params.organizationId,
			"searchJiraIssuesUsingJql",
			{
				cloudId,
				jql,
				maxResults: pageSize,
				...(nextPageToken ? { nextPageToken } : {}),
			},
			params.connectionId,
		);
		if (result.isError) {
			throw new Error(mcpTextError(result.content, "searchJiraIssuesUsingJql failed"));
		}
		const pageRows = parseAtlassianMcpIssues(result.content, config);
		rows.push(...pageRows);
		nextPageToken = parseAtlassianMcpNextPageToken(result.content);
		if (pageRows.length === 0 || !nextPageToken) break;
	}

	return {
		rows: rows.slice(offset, offset + limit),
		columns: [...ATLASSIAN_JIRA_ISSUE_COLUMNS],
	};
}
