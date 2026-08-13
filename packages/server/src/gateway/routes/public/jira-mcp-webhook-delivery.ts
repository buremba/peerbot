import type { DbClient } from "../../../db/client.js";
import {
	activateBehaviorSignal,
	dispatchBehaviorRunsBestEffort,
	type BehaviorActivationResult,
} from "../../../behaviors/activation.js";
import {
	deriveConnectorActivationSignals,
	loadConnectorDeriveFeedContext,
} from "../../../behaviors/connector-derived.js";
import {
	atlassianDocumentToText,
	ATLASSIAN_JIRA_ISSUES_FEED_KEY,
	isAtlassianMcpConfig,
	mapAtlassianIssueToRow,
} from "../../../operations/atlassian-mcp-feed.js";
import { insertEvent } from "../../../utils/insert-event.js";
import type { AppWebhookProvider } from "./app-webhooks.js";

interface JiraMcpFeedTarget {
	connectionId: number;
	feedId: number;
	connectorKey: string;
	config: Record<string, unknown>;
	siteUrl: string;
}

function strField(node: unknown, key: string): string | undefined {
	if (node === null || typeof node !== "object") return undefined;
	const value = (node as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJson(rawBody: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return undefined;
	}
}

function siteHost(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return null;
	}
}

async function resolveJiraMcpFeedTarget(params: {
	sql: DbClient;
	organizationId: string;
	siteHost: string;
}): Promise<JiraMcpFeedTarget | null> {
	const rows = (await params.sql`
		SELECT f.id AS feed_id, f.connection_id, f.config AS feed_config,
		       c.connector_key, c.config AS connection_config, cd.mcp_config
		FROM feeds f
		JOIN connections c ON c.id = f.connection_id
		JOIN LATERAL (
			SELECT mcp_config
			FROM connector_definitions
			WHERE organization_id = c.organization_id
			  AND key = c.connector_key
			  AND status = 'active'
			ORDER BY updated_at DESC
			LIMIT 1
		) cd ON TRUE
		WHERE f.organization_id = ${params.organizationId}
		  AND f.feed_key = ${ATLASSIAN_JIRA_ISSUES_FEED_KEY}
		  AND f.status = 'active'
		  AND f.deleted_at IS NULL
		  AND c.status NOT IN ('paused', 'revoked')
		  AND c.deleted_at IS NULL
	`) as Array<{
		feed_id: number;
		connection_id: number;
		feed_config: Record<string, unknown> | null;
		connector_key: string;
		connection_config: Record<string, unknown> | null;
		mcp_config: Record<string, unknown> | null;
	}>;

	const matches: JiraMcpFeedTarget[] = [];
	for (const row of rows) {
		if (!isAtlassianMcpConfig(row.mcp_config)) continue;
		const config = {
			...(row.connection_config ?? {}),
			...(row.feed_config ?? {}),
		};
		const configuredUrl =
			typeof config.site_url === "string" ? config.site_url : undefined;
		if (siteHost(configuredUrl) !== params.siteHost.toLowerCase()) continue;
		matches.push({
			connectionId: Number(row.connection_id),
			feedId: Number(row.feed_id),
			connectorKey: row.connector_key,
			config,
			siteUrl: configuredUrl as string,
		});
	}
	if (matches.length > 1) {
		throw new Error(
			`Multiple active Atlassian MCP issue feeds match Jira site ${params.siteHost}`,
		);
	}
	return matches[0] ?? null;
}

async function resolveJiraMcpFeedTargetByConnection(params: {
	sql: DbClient;
	organizationId: string;
	connectionId: number;
}): Promise<JiraMcpFeedTarget | null> {
	const rows = (await params.sql`
		SELECT f.id AS feed_id, f.connection_id, f.config AS feed_config,
		       c.connector_key, c.config AS connection_config, cd.mcp_config
		FROM feeds f
		JOIN connections c ON c.id = f.connection_id
		JOIN LATERAL (
			SELECT mcp_config
			FROM connector_definitions
			WHERE organization_id = c.organization_id
			  AND key = c.connector_key
			  AND status = 'active'
			ORDER BY updated_at DESC
			LIMIT 1
		) cd ON TRUE
		WHERE f.organization_id = ${params.organizationId}
		  AND f.connection_id = ${params.connectionId}
		  AND f.feed_key = ${ATLASSIAN_JIRA_ISSUES_FEED_KEY}
		  AND f.status = 'active'
		  AND f.deleted_at IS NULL
		  AND c.status NOT IN ('paused', 'revoked')
		  AND c.deleted_at IS NULL
	`) as Array<{
		feed_id: number;
		connection_id: number;
		feed_config: Record<string, unknown> | null;
		connector_key: string;
		connection_config: Record<string, unknown> | null;
		mcp_config: Record<string, unknown> | null;
	}>;
	const row = rows[0];
	if (!row || rows.length !== 1 || !isAtlassianMcpConfig(row.mcp_config)) {
		return null;
	}
	const config = {
		...(row.connection_config ?? {}),
		...(row.feed_config ?? {}),
	};
	const configuredUrl =
		typeof config.site_url === "string" ? config.site_url : undefined;
	if (!configuredUrl || !siteHost(configuredUrl)) return null;
	return {
		connectionId: Number(row.connection_id),
		feedId: Number(row.feed_id),
		connectorKey: row.connector_key,
		config,
		siteUrl: configuredUrl,
	};
}

function issueUrl(target: JiraMcpFeedTarget, issueKey?: string): string {
	if (!issueKey) return target.siteUrl;
	return `${target.siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(issueKey)}`;
}

async function landJiraMcpWebhookEvent(params: {
	sql: DbClient;
	organizationId: string;
	target: JiraMcpFeedTarget;
	payload: Record<string, unknown>;
}): Promise<boolean> {
	const eventType = strField(params.payload, "webhookEvent");
	const issue =
		params.payload.issue && typeof params.payload.issue === "object"
			? (params.payload.issue as Record<string, unknown>)
			: null;
	const issueRow = mapAtlassianIssueToRow(issue, params.target.config);
	const issueId =
		issueRow && typeof issueRow.id === "string" ? issueRow.id : undefined;
	const issueKey =
		issueRow && typeof issueRow.key === "string" ? issueRow.key : undefined;

	let event: {
		originId: string;
		kind: "issue" | "comment";
		title: string | null;
		content: string | null;
		authorName: string | null;
		sourceUrl: string;
		occurredAt: string | null;
		parentOriginId?: string;
		metadata: Record<string, unknown>;
	};

	if (
		eventType === "jira:issue_created" ||
		eventType === "jira:issue_updated"
	) {
		if (!issueId || !issueRow) {
			throw new Error(`Jira ${eventType} delivery is missing issue.id`);
		}
		event = {
			originId: `jira_issue_${issueId}`,
			kind: "issue",
			title:
				typeof issueRow.summary === "string"
					? issueRow.summary
					: (issueKey ?? null),
			content:
				typeof issueRow.description === "string" ? issueRow.description : null,
			authorName:
				typeof issueRow.reporter === "string"
					? issueRow.reporter
					: typeof issueRow.assignee === "string"
						? issueRow.assignee
						: null,
			sourceUrl:
				typeof issueRow.url === "string"
					? issueRow.url
					: issueUrl(params.target, issueKey),
			occurredAt:
				eventType === "jira:issue_updated"
					? typeof issueRow.updated_at === "string"
						? issueRow.updated_at
						: typeof issueRow.created_at === "string"
							? issueRow.created_at
							: null
					: typeof issueRow.created_at === "string"
						? issueRow.created_at
						: typeof issueRow.updated_at === "string"
							? issueRow.updated_at
							: null,
			metadata: {
				key: issueKey ?? null,
				status: issueRow.status ?? null,
				assignee: issueRow.assignee ?? null,
				reporter: issueRow.reporter ?? null,
				updated_at: issueRow.updated_at ?? null,
			},
		};
	} else if (eventType === "comment_created") {
		const comment =
			params.payload.comment && typeof params.payload.comment === "object"
				? (params.payload.comment as Record<string, unknown>)
				: null;
		const commentId = comment ? strField(comment, "id") : undefined;
		if (!comment || !commentId) {
			throw new Error("Jira comment_created delivery is missing comment.id");
		}
		const author =
			comment.author && typeof comment.author === "object"
				? (comment.author as Record<string, unknown>)
				: null;
		event = {
			originId: `jira_comment_${commentId}`,
			kind: "comment",
			title: issueKey ? `Comment on ${issueKey}` : "Jira comment",
			content: atlassianDocumentToText(comment.body) || null,
			authorName:
				(author &&
					(strField(author, "displayName") ??
						strField(author, "emailAddress") ??
						strField(author, "name"))) ??
				null,
			sourceUrl: issueUrl(params.target, issueKey),
			occurredAt:
				strField(comment, "created") ?? strField(comment, "updated") ?? null,
			...(issueId ? { parentOriginId: `jira_issue_${issueId}` } : {}),
			metadata: {
				issue_key: issueKey ?? null,
				updated_at:
					strField(comment, "updated") ?? strField(comment, "created") ?? null,
			},
		};
	} else {
		return false;
	}

	const deriveContext = await loadConnectorDeriveFeedContext(
		{
			organizationId: params.organizationId,
			connectorKey: params.target.connectorKey,
			feedKey: ATLASSIAN_JIRA_ISSUES_FEED_KEY,
			feedId: params.target.feedId,
		},
		params.sql,
	);
	// Verified webhooks are live pushes, not a cold-start backfill. Virtual feeds
	// never have sync runs, so bypass only that gate and retain the persisted
	// eventKinds catalog check.
	deriveContext.feedPreviouslySynced = true;
	const activations: BehaviorActivationResult[] = [];
	await insertEvent(
		{
			organizationId: params.organizationId,
			connectorKey: params.target.connectorKey,
			connectionId: params.target.connectionId,
			feedKey: ATLASSIAN_JIRA_ISSUES_FEED_KEY,
			feedId: params.target.feedId,
			originId: event.originId,
			originType: event.kind,
			semanticType: event.kind,
			title: event.title,
			content: event.content,
			payloadData: params.payload,
			authorName: event.authorName,
			sourceUrl: event.sourceUrl,
			occurredAt: event.occurredAt,
			parentOriginId: event.parentOriginId,
			entityIds: [],
			metadata: event.metadata,
		},
		{
			onConflictUpdate: true,
			afterPersist: async (persisted, tx) => {
				const signals = deriveConnectorActivationSignals(
					deriveContext,
					{
						connectionId: params.target.connectionId,
						originId: event.originId,
						kind: event.kind,
						title: event.title,
						payloadText: event.content,
						sourceUrl: event.sourceUrl,
						occurredAt: event.occurredAt ?? new Date(),
						metadata: event.metadata,
					},
					persisted.change,
					persisted.id,
				);
				for (const signal of signals) {
					activations.push(
						...(await activateBehaviorSignal({
							organizationId: params.organizationId,
							signal,
							db: tx,
						})),
					);
				}
			},
		},
	);
	await dispatchBehaviorRunsBestEffort(activations);
	return true;
}

/**
 * Route signed Jira App deliveries by exact org + site host to an active Rovo
 * issues feed. Until the legacy Jira connector is deleted, an org without such
 * a feed falls through to its existing raw app-install event path.
 */
export function createJiraWebhookDelivery(): NonNullable<
	AppWebhookProvider["onDelivery"]
> {
	return async ({ rawBody, install, sql }) => {
		const payload = parseJson(rawBody);
		if (!payload || typeof payload !== "object") {
			return { triggered: false, handled: false };
		}
		const target = await resolveJiraMcpFeedTarget({
			sql,
			organizationId: install.organizationId,
			siteHost: install.externalTenantId,
		});
		if (!target) return { triggered: false, handled: false };
		const triggered = await landJiraMcpWebhookEvent({
			sql,
			organizationId: install.organizationId,
			target,
			payload: payload as Record<string, unknown>,
		});
		return triggered
			? { triggered: true }
			: { triggered: false, handled: false };
	};
}

/**
 * Land a per-connection Jira dynamic-webhook delivery on the exact Atlassian
 * MCP connection whose callback URL received it. Authentication and raw-body
 * verification happen in the shared connector webhook ingest pipeline before
 * this function runs.
 */
export async function deliverJiraMcpConnectionWebhook(params: {
	sql: DbClient;
	organizationId: string;
	connectionId: number;
	rawBody: Uint8Array;
}): Promise<{ handled: boolean; triggered: boolean }> {
	const payload = parseJson(params.rawBody);
	if (!payload || typeof payload !== "object") {
		return { handled: false, triggered: false };
	}
	const target = await resolveJiraMcpFeedTargetByConnection(params);
	if (!target) return { handled: false, triggered: false };
	const triggered = await landJiraMcpWebhookEvent({
		sql: params.sql,
		organizationId: params.organizationId,
		target,
		payload: payload as Record<string, unknown>,
	});
	return { handled: true, triggered };
}
