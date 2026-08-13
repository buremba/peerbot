import { randomBytes } from "node:crypto";
import { getErrorMessage } from "@lobu/core";
import { resolveBaseUrl } from "../auth/base-url";
import { CredentialService } from "../auth/credentials";
import { normalizeScopeList } from "../auth/oauth/scopes";
import { type DbClient, getDb } from "../db/client";
import {
	persistSecretValue,
	resolveSecretValue,
} from "../gateway/secrets/index";
import { orgContext } from "../lobu/stores/org-context";
import { PostgresSecretStore } from "../lobu/stores/postgres-secret-store";
import { isAtlassianMcpConfig } from "../operations/atlassian-mcp-feed";
import { resolveAuthCredentials } from "../utils/auth-credential-secrets";
import logger from "../utils/logger";

const JIRA_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const JIRA_API_ROOT = "https://api.atlassian.com/ex/jira";
const WEBHOOK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const WEBHOOK_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface AtlassianMcpWebhookConnection {
	id: number;
	organizationId: string;
	status: string;
	config: Record<string, unknown>;
	mcpConfig: Record<string, unknown> | null;
}

interface JiraWebhookCredentials {
	accessToken: string;
}

interface JiraDynamicWebhook {
	id?: number | string;
	url?: string;
	expirationDate?: string;
}

interface JiraWebhookListResponse {
	values?: JiraDynamicWebhook[];
	isLast?: boolean;
	startAt?: number;
	maxResults?: number;
}

interface JiraWebhookRegistrationResponse {
	webhookRegistrationResult?: Array<{
		createdWebhookId?: number | string;
		errors?: string[];
	}>;
}

interface JiraWebhookRefreshResponse {
	expirationDate?: string;
}

interface JiraProject {
	key?: string;
}

interface JiraProjectSearchResponse {
	values?: JiraProject[];
	isLast?: boolean;
	startAt?: number;
	maxResults?: number;
}

export interface AtlassianMcpWebhookResult {
	handled: boolean;
	changed: boolean;
	status?: "active" | "disabled";
}

function stringConfig(
	config: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = config[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function enabled(config: Record<string, unknown>): boolean {
	return config.webhook_enabled === true || config.webhook_enabled === "true";
}

function callbackBaseUrl(baseUrl: string, connectionId: number): URL {
	return new URL(
		`${baseUrl.replace(/\/+$/, "")}/api/v1/webhooks/${connectionId}`,
	);
}

function callbackUrl(
	baseUrl: string,
	connectionId: number,
): string {
	return callbackBaseUrl(baseUrl, connectionId).href;
}

function hasCallbackPath(value: string | undefined, expected: URL): boolean {
	if (!value) return false;
	try {
		const candidate = new URL(value);
		candidate.search = "";
		return candidate.href === expected.href;
	} catch {
		return false;
	}
}

function jiraApiBase(cloudId: string): string {
	return `${JIRA_API_ROOT}/${encodeURIComponent(cloudId)}/rest/api/3`;
}

function expiresSoon(value: unknown, nowMs: number): boolean {
	if (typeof value !== "string") return true;
	const expiresAt = new Date(value).getTime();
	return (
		!Number.isFinite(expiresAt) ||
		expiresAt <= nowMs + WEBHOOK_REFRESH_WINDOW_MS
	);
}

function errorText(response: Response, body: string): string {
	const detail = body.trim().replace(/\s+/g, " ").slice(0, 500);
	return detail
		? `Jira webhook API returned ${response.status}: ${detail}`
		: `Jira webhook API returned ${response.status}`;
}

async function jiraJson<T>(
	fetchImpl: typeof fetch,
	url: string,
	accessToken: string,
	init: RequestInit,
): Promise<T> {
	const response = await fetchImpl(url, {
		...init,
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const body = await response.text();
	if (!response.ok) throw new Error(errorText(response, body));
	if (!body.trim()) return {} as T;
	return JSON.parse(body) as T;
}

async function listJiraWebhooks(
	fetchImpl: typeof fetch,
	apiBase: string,
	accessToken: string,
): Promise<JiraDynamicWebhook[]> {
	const all: JiraDynamicWebhook[] = [];
	let startAt = 0;
	for (let page = 0; page < 100; page += 1) {
		const url = new URL(`${apiBase}/webhook`);
		url.searchParams.set("startAt", String(startAt));
		url.searchParams.set("maxResults", "100");
		const result = await jiraJson<JiraWebhookListResponse>(
			fetchImpl,
			url.href,
			accessToken,
			{ method: "GET" },
		);
		const values = result.values ?? [];
		all.push(...values);
		if (result.isLast === true || values.length === 0) return all;
		const nextStart =
			(typeof result.startAt === "number" ? result.startAt : startAt) +
			(typeof result.maxResults === "number"
				? result.maxResults
				: values.length);
		if (
			nextStart <= startAt ||
			(result.isLast !== false && values.length < 100)
		) {
			return all;
		}
		startAt = nextStart;
	}
	throw new Error("Jira webhook listing exceeded 100 pages");
}

function quoteJqlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function listJiraProjectKeys(
	fetchImpl: typeof fetch,
	apiBase: string,
	accessToken: string,
): Promise<Set<string>> {
	const projectKeys = new Set<string>();
	let startAt = 0;
	for (let page = 0; page < 100; page += 1) {
		const url = new URL(`${apiBase}/project/search`);
		url.searchParams.set("startAt", String(startAt));
		url.searchParams.set("maxResults", "100");
		const result = await jiraJson<JiraProjectSearchResponse>(
			fetchImpl,
			url.href,
			accessToken,
			{ method: "GET" },
		);
		const values = result.values ?? [];
		for (const project of values) {
			const key = project.key?.trim();
			if (key) projectKeys.add(key);
		}
		if (result.isLast === true || values.length === 0) return projectKeys;
		const nextStart =
			(typeof result.startAt === "number" ? result.startAt : startAt) +
			(typeof result.maxResults === "number"
				? result.maxResults
				: values.length);
		if (
			nextStart <= startAt ||
			(result.isLast !== false && values.length < 100)
		) {
			return projectKeys;
		}
		startAt = nextStart;
	}
	throw new Error("Jira project listing exceeded 100 pages");
}

async function jiraProjectJql(
	fetchImpl: typeof fetch,
	apiBase: string,
	accessToken: string,
): Promise<string> {
	const projectKeys = await listJiraProjectKeys(
		fetchImpl,
		apiBase,
		accessToken,
	);
	if (projectKeys.size === 0) {
		throw new Error(
			"Jira webhook registration requires at least one accessible project",
		);
	}
	// Code-unit sort, not localeCompare: reconciliation equality-compares this
	// string against the webhook_project_jql persisted at registration, so
	// ordering must not vary with the process locale.
	const sortedKeys = [...projectKeys].sort();
	return `project IN (${sortedKeys.map(quoteJqlString).join(", ")})`;
}

async function loadConnection(
	sql: DbClient,
	organizationId: string,
	connectionId: number,
): Promise<AtlassianMcpWebhookConnection | null> {
	const rows = await sql`
		SELECT c.id, c.organization_id, c.status, c.config, cd.mcp_config
		FROM connections c
		LEFT JOIN LATERAL (
			SELECT mcp_config
			FROM connector_definitions
			WHERE organization_id = c.organization_id
			  AND key = c.connector_key
			  AND status = 'active'
			ORDER BY updated_at DESC
			LIMIT 1
		) cd ON TRUE
		WHERE c.id = ${connectionId}
		  AND c.organization_id = ${organizationId}
		  AND c.deleted_at IS NULL
		LIMIT 1
	`;
	const row = rows[0] as
		| {
				id: number;
				organization_id: string;
				status: string;
				config: Record<string, unknown> | null;
				mcp_config: Record<string, unknown> | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		id: Number(row.id),
		organizationId: row.organization_id,
		status: row.status,
		config: row.config ?? {},
		mcpConfig: row.mcp_config,
	};
}

async function resolveJiraCredentials(
	sql: DbClient,
	connection: AtlassianMcpWebhookConnection,
): Promise<JiraWebhookCredentials> {
	const accountSlug = stringConfig(
		connection.config,
		"jira_webhook_auth_profile_slug",
	);
	const appSlug = stringConfig(
		connection.config,
		"jira_webhook_app_profile_slug",
	);
	if (!accountSlug || !appSlug) {
		throw new Error(
			"Jira webhook authorization requires both jira_webhook_auth_profile_slug and jira_webhook_app_profile_slug",
		);
	}
	const rows = await sql`
		SELECT id, slug, connector_key, profile_kind, status, auth_data,
		       account_id, provider
		FROM auth_profiles
		WHERE organization_id = ${connection.organizationId}
		  AND slug IN (${accountSlug}, ${appSlug})
	`;
	const accountProfile = rows.find((row) => row.slug === accountSlug) as
		| {
				id: number;
				connector_key: string | null;
				profile_kind: string;
				status: string;
				auth_data: Record<string, unknown> | null;
				account_id: string | null;
				provider: string | null;
		  }
		| undefined;
	const appProfile = rows.find((row) => row.slug === appSlug) as
		| {
				id: number;
				connector_key: string | null;
				profile_kind: string;
				status: string;
				auth_data: Record<string, unknown> | null;
				provider: string | null;
		  }
		| undefined;
	if (
		!accountProfile ||
		accountProfile.profile_kind !== "oauth_account" ||
		accountProfile.status !== "active" ||
		accountProfile.connector_key !== "jira" ||
		accountProfile.provider?.toLowerCase() !== "jira" ||
		!accountProfile.account_id
	) {
		throw new Error(
			`Jira webhook account profile '${accountSlug}' is missing, inactive, or not a Jira OAuth account`,
		);
	}
	if (
		!appProfile ||
		appProfile.profile_kind !== "oauth_app" ||
		appProfile.status !== "active" ||
		appProfile.connector_key !== "jira" ||
		appProfile.provider?.toLowerCase() !== "jira"
	) {
		throw new Error(
			`Jira webhook app profile '${appSlug}' is missing, inactive, or not a Jira OAuth app`,
		);
	}
	const appCredentials = await resolveAuthCredentials({
		organizationId: connection.organizationId,
		authProfileId: Number(appProfile.id),
		authData: appProfile.auth_data,
	});
	const clientId = appCredentials.JIRA_CLIENT_ID;
	const clientSecret = appCredentials.JIRA_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error(
			`Jira webhook app profile '${appSlug}' does not contain JIRA_CLIENT_ID and JIRA_CLIENT_SECRET`,
		);
	}
	// Token refresh owns its own per-account advisory transaction. Use the root
	// pool rather than nesting that transaction inside the per-webhook lock.
	const tokens = await new CredentialService(getDb()).getConnectionTokens(
		connection.id,
		accountProfile.account_id,
		{
			tokenUrl: JIRA_TOKEN_URL,
			clientId,
			clientSecret,
			authMethod: "client_secret_post",
		},
	);
	if (!tokens?.accessToken) {
		throw new Error(
			`Jira webhook account profile '${accountSlug}' has no access token`,
		);
	}
	if (!normalizeScopeList(tokens.scope).includes("manage:jira-webhook")) {
		throw new Error(
			`Jira webhook account profile '${accountSlug}' is missing manage:jira-webhook consent`,
		);
	}
	return { accessToken: tokens.accessToken };
}

const WEBHOOK_STATE_KEYS = [
	"webhook_external_id",
	"webhook_callback_token",
	"webhook_signature_secret",
	"webhook_signature_header",
	"webhook_algorithm",
	"webhook_signature_prefix",
	"webhook_dedupe_header",
	"webhook_project_jql",
	"webhook_expires_at",
	"webhook_status",
	"webhook_error",
] as const;

function stripWebhookState(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...config };
	for (const key of WEBHOOK_STATE_KEYS) delete next[key];
	return next;
}

async function persistConfig(
	sql: DbClient,
	connection: AtlassianMcpWebhookConnection,
	config: Record<string, unknown>,
): Promise<void> {
	await sql`
		UPDATE connections
		SET config = ${sql.json(config)}, updated_at = NOW()
		WHERE id = ${connection.id}
		  AND organization_id = ${connection.organizationId}
		  AND deleted_at IS NULL
	`;
	connection.config = config;
}

async function unregisterUnderLock(params: {
	sql: DbClient;
	connection: AtlassianMcpWebhookConnection;
	fetchImpl: typeof fetch;
	baseUrl: string;
}): Promise<AtlassianMcpWebhookResult> {
	const { connection } = params;
	const externalId = stringConfig(connection.config, "webhook_external_id");
	const callbackTokenRef = stringConfig(
		connection.config,
		"webhook_callback_token",
	);
	// Config evidence proves a registration committed. The registration tx
	// persists the callback-token secret outside itself, so a crash between the
	// provider POST and the config commit leaves that secret row as the only
	// durable trace. Neither present means the provider was never contacted —
	// skip inspection rather than fail teardown on prerequisites (cloud_id,
	// Jira consent) that may never have existed, which would block disabling
	// or deleting a connection that never registered.
	let shouldInspectProvider = Boolean(externalId) || Boolean(callbackTokenRef);
	if (!shouldInspectProvider && enabled(connection.config)) {
		const orphans = await orgContext.run(
			{ organizationId: connection.organizationId },
			() =>
				new PostgresSecretStore().list(
					`webhook/${connection.id}/callback-token`,
				),
		);
		shouldInspectProvider = orphans.length > 0;
	}
	const webhookIds = new Set<number>();
	if (externalId && Number.isSafeInteger(Number(externalId))) {
		webhookIds.add(Number(externalId));
	}
	if (shouldInspectProvider) {
		const cloudId =
			stringConfig(connection.config, "cloud_id") ??
			stringConfig(connection.config, "site_cloud_id");
		if (!cloudId) {
			throw new Error("Atlassian MCP connection has no resolved Jira cloud_id");
		}
		const credentials = await resolveJiraCredentials(params.sql, connection);
		const apiBase = jiraApiBase(cloudId);
		const accessToken = credentials.accessToken;
		const webhooks = await listJiraWebhooks(
			params.fetchImpl,
			apiBase,
			accessToken,
		);
		const expectedPath = callbackBaseUrl(params.baseUrl, connection.id);
		for (const item of webhooks) {
			const id = Number(item.id);
			if (Number.isSafeInteger(id) && hasCallbackPath(item.url, expectedPath)) {
				webhookIds.add(id);
			}
		}
		if (webhookIds.size > 0) {
			await jiraJson(params.fetchImpl, `${apiBase}/webhook`, accessToken, {
				method: "DELETE",
				body: JSON.stringify({ webhookIds: [...webhookIds] }),
			});
		}
	}
	await orgContext.run({ organizationId: connection.organizationId }, () =>
		new PostgresSecretStore().delete(
			callbackTokenRef ?? `webhook/${connection.id}/callback-token`,
		),
	);
	// A connection that never registered has nothing to strip — skip the write
	// so every disabled-path reconcile doesn't bump updated_at.
	if (WEBHOOK_STATE_KEYS.some((key) => key in connection.config)) {
		await persistConfig(
			params.sql,
			connection,
			stripWebhookState(connection.config),
		);
	}
	return {
		handled: true,
		changed: webhookIds.size > 0,
		status: "disabled",
	};
}

async function markError(params: {
	sql: DbClient;
	organizationId: string;
	connectionId: number;
	error: unknown;
}): Promise<void> {
	const message = getErrorMessage(params.error).slice(0, 500);
	await params.sql`
		UPDATE connections
		SET config = COALESCE(config, '{}'::jsonb) || ${params.sql.json({
			webhook_status: "error",
			webhook_error: message,
		})}::jsonb,
		updated_at = NOW()
		WHERE id = ${params.connectionId}
		  AND organization_id = ${params.organizationId}
		  AND deleted_at IS NULL
	`;
}

async function ensureUnderLock(params: {
	sql: DbClient;
	connection: AtlassianMcpWebhookConnection;
	baseUrl: string;
	fetchImpl: typeof fetch;
	nowMs: number;
}): Promise<AtlassianMcpWebhookResult> {
	const { connection, sql } = params;
	if (!isAtlassianMcpConfig(connection.mcpConfig)) {
		return { handled: false, changed: false };
	}
	if (
		!enabled(connection.config) ||
		connection.status === "paused" ||
		connection.status === "revoked"
	) {
		return unregisterUnderLock({
			sql,
			connection,
			fetchImpl: params.fetchImpl,
			baseUrl: params.baseUrl,
		});
	}
	const cloudId =
		stringConfig(connection.config, "cloud_id") ??
		stringConfig(connection.config, "site_cloud_id");
	if (!cloudId) {
		throw new Error("Atlassian MCP connection has no resolved Jira cloud_id");
	}
	const credentials = await resolveJiraCredentials(sql, connection);
	const secretStore = new PostgresSecretStore();
	const existingCallbackTokenRef = stringConfig(
		connection.config,
		"webhook_callback_token",
	);
	const storedCallbackToken = existingCallbackTokenRef
		? await orgContext.run({ organizationId: connection.organizationId }, () =>
				resolveSecretValue(secretStore, existingCallbackTokenRef),
			)
		: undefined;
	if (existingCallbackTokenRef && !storedCallbackToken) {
		throw new Error("Stored Jira webhook callback token cannot be resolved");
	}
	const hadCallbackToken = Boolean(storedCallbackToken);
	const callbackToken = storedCallbackToken ?? randomBytes(32).toString("hex");
	const callbackTokenRef =
		existingCallbackTokenRef ??
		(await orgContext.run({ organizationId: connection.organizationId }, () =>
			persistSecretValue(
				secretStore,
				`webhook/${connection.id}/callback-token`,
				callbackToken,
			),
		));

	const apiBase = jiraApiBase(cloudId);
	// OAuth-app dynamic webhooks authenticate with Atlassian's bearer JWT.
	// Keep the legacy callback-token secret only as durable crash-window evidence
	// for teardown; Jira drops callback query parameters from deliveries.
	const targetUrl = callbackUrl(params.baseUrl, connection.id);
	const callbackPath = callbackBaseUrl(params.baseUrl, connection.id);
	const webhooks = await listJiraWebhooks(
		params.fetchImpl,
		apiBase,
		credentials.accessToken,
	);
	const projectJql = await jiraProjectJql(
		params.fetchImpl,
		apiBase,
		credentials.accessToken,
	);
	// Compare against our persisted copy, not the jqlFilter Jira echoes back:
	// Jira normalizes the stored JQL, so a provider-side compare would delete
	// and re-register the webhook on every reconcile.
	const projectScopeMatches =
		stringConfig(connection.config, "webhook_project_jql") === projectJql;
	const ownedCallbacks = webhooks.filter(
		(item) => item.id !== undefined && hasCallbackPath(item.url, callbackPath),
	);
	let matches = projectScopeMatches
		? ownedCallbacks.filter((item) => item.url === targetUrl)
		: [];
	const staleCallbacks = projectScopeMatches
		? ownedCallbacks.filter((item) => item.url !== targetUrl)
		: ownedCallbacks;
	if (!hadCallbackToken || staleCallbacks.length > 0) {
		const staleIds = (!hadCallbackToken ? ownedCallbacks : staleCallbacks).map(
			(item) => Number(item.id),
		);
		if (staleIds.length > 0) {
			await jiraJson(
				params.fetchImpl,
				`${apiBase}/webhook`,
				credentials.accessToken,
				{
					method: "DELETE",
					body: JSON.stringify({ webhookIds: staleIds }),
				},
			);
		}
		if (!hadCallbackToken) matches = [];
	}
	if (matches.length > 1) {
		const extras = matches.slice(1).map((item) => Number(item.id));
		await jiraJson(
			params.fetchImpl,
			`${apiBase}/webhook`,
			credentials.accessToken,
			{ method: "DELETE", body: JSON.stringify({ webhookIds: extras }) },
		);
	}

	let externalId =
		matches[0]?.id !== undefined ? String(matches[0].id) : undefined;
	let changed = false;
	const providerExpiry = matches[0]?.expirationDate;
	let refreshedExpiry: string | undefined;
	let lifetimeExtended = false;
	if (
		externalId &&
		expiresSoon(
			providerExpiry ?? connection.config.webhook_expires_at,
			params.nowMs,
		)
	) {
		const refresh = await jiraJson<JiraWebhookRefreshResponse>(
			params.fetchImpl,
			`${apiBase}/webhook/refresh`,
			credentials.accessToken,
			{
				method: "PUT",
				body: JSON.stringify({ webhookIds: [Number(externalId)] }),
			},
		);
		refreshedExpiry = refresh.expirationDate;
		lifetimeExtended = true;
		changed = true;
	}
	if (!externalId) {
		const registration = await jiraJson<JiraWebhookRegistrationResponse>(
			params.fetchImpl,
			`${apiBase}/webhook`,
			credentials.accessToken,
			{
				method: "POST",
				body: JSON.stringify({
					url: targetUrl,
					webhooks: [
						{
							jqlFilter: projectJql,
							events: [
								"jira:issue_created",
								"jira:issue_updated",
								"comment_created",
							],
						},
					],
				}),
			},
		);
		const result = registration.webhookRegistrationResult?.[0];
		if (result?.createdWebhookId === undefined) {
			throw new Error(
				`Jira webhook registration failed: ${result?.errors?.join("; ") || "no webhook id returned"}`,
			);
		}
		externalId = String(result.createdWebhookId);
		lifetimeExtended = true;
		changed = true;
	}
	const expiresAt = externalId
		? (refreshedExpiry ??
			(lifetimeExtended
				? new Date(params.nowMs + WEBHOOK_LIFETIME_MS).toISOString()
				: (providerExpiry ??
					stringConfig(connection.config, "webhook_expires_at"))))
		: undefined;
	if (!expiresAt) {
		throw new Error("Jira webhook reconciliation returned no expiration date");
	}
	await persistConfig(sql, connection, {
		...connection.config,
		webhook_callback_token: callbackTokenRef,
		webhook_external_id: externalId,
		webhook_project_jql: projectJql,
		webhook_expires_at: expiresAt,
		webhook_status: "active",
		webhook_error: null,
	});
	logger.info(
		{ connection_id: connection.id, external_id: externalId, changed },
		"Reconciled Atlassian MCP Jira webhook",
	);
	return { handled: true, changed, status: "active" };
}

export async function ensureAtlassianMcpJiraWebhook(params: {
	organizationId: string;
	connectionId: number;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	sql?: DbClient;
	now?: Date;
}): Promise<AtlassianMcpWebhookResult> {
	const sql = params.sql ?? getDb();
	try {
		return await sql.begin(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
				`atlassian_mcp_webhook:${params.organizationId}:${params.connectionId}`,
			]);
			const connection = await loadConnection(
				tx,
				params.organizationId,
				params.connectionId,
			);
			if (!connection) return { handled: false, changed: false };
			return ensureUnderLock({
				sql: tx,
				connection,
				baseUrl:
					params.baseUrl ??
					resolveBaseUrl({ request: null }).replace(/\/+$/, ""),
				fetchImpl: params.fetchImpl ?? fetch,
				nowMs: (params.now ?? new Date()).getTime(),
			});
		});
	} catch (error) {
		try {
			await markError({
				sql,
				organizationId: params.organizationId,
				connectionId: params.connectionId,
				error,
			});
		} catch (markFailure) {
			// The reconcile error is the actionable one — never mask it with a
			// failure of the best-effort status write.
			logger.warn(
				{
					connection_id: params.connectionId,
					error: getErrorMessage(markFailure),
				},
				"Failed to record Atlassian MCP webhook error status",
			);
		}
		throw error;
	}
}

export async function unregisterAtlassianMcpJiraWebhook(params: {
	organizationId: string;
	connectionId: number;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	sql?: DbClient;
}): Promise<AtlassianMcpWebhookResult> {
	const sql = params.sql ?? getDb();
	return sql.begin(async (tx) => {
		await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
			`atlassian_mcp_webhook:${params.organizationId}:${params.connectionId}`,
		]);
		const connection = await loadConnection(
			tx,
			params.organizationId,
			params.connectionId,
		);
		if (!connection || !isAtlassianMcpConfig(connection.mcpConfig)) {
			return { handled: false, changed: false };
		}
		return unregisterUnderLock({
			sql: tx,
			connection,
			fetchImpl: params.fetchImpl ?? fetch,
			baseUrl:
				params.baseUrl ?? resolveBaseUrl({ request: null }).replace(/\/+$/, ""),
		});
	});
}

export async function refreshDueAtlassianMcpJiraWebhooks(
	params: { baseUrl?: string; fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<{ scanned: number; refreshed: number; errors: number }> {
	const sql = getDb();
	const refreshBefore = new Date(
		Date.now() + WEBHOOK_REFRESH_WINDOW_MS,
	).toISOString();
	const rows = (await sql`
		SELECT c.id, c.organization_id
		FROM connections c
		JOIN LATERAL (
			SELECT mcp_config
			FROM connector_definitions
			WHERE organization_id = c.organization_id
			  AND key = c.connector_key
			  AND status = 'active'
			ORDER BY updated_at DESC
			LIMIT 1
		) cd ON TRUE
		WHERE c.deleted_at IS NULL
		  AND c.status = 'active'
		  AND c.config->>'webhook_enabled' = 'true'
		  AND (
			c.config->>'webhook_external_id' IS NULL
			OR c.config->>'webhook_status' <> 'active'
			OR c.config->>'webhook_expires_at' IS NULL
			OR c.config->>'webhook_expires_at' !~
			   '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})$'
			OR c.config->>'webhook_expires_at' <= ${refreshBefore}
		  )
		  AND cd.mcp_config IS NOT NULL
		ORDER BY c.id
		LIMIT ${params.limit ?? 100}
	`) as Array<{ id: number; organization_id: string }>;
	let refreshed = 0;
	let errors = 0;
	for (const row of rows) {
		try {
			const result = await ensureAtlassianMcpJiraWebhook({
				organizationId: row.organization_id,
				connectionId: Number(row.id),
				baseUrl: params.baseUrl,
				fetchImpl: params.fetchImpl,
			});
			if (result.changed) refreshed += 1;
		} catch (error) {
			errors += 1;
			logger.warn(
				{ connection_id: row.id, error: getErrorMessage(error) },
				"Atlassian MCP Jira webhook refresh failed",
			);
		}
	}
	return { scanned: rows.length, refreshed, errors };
}
