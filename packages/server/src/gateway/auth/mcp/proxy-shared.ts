import { verifyWorkerToken, type WorkerTokenData } from "@lobu/core";
import type { Context } from "hono";
import { getOrgId, orgContext } from "../../../lobu/stores/org-context.js";
import { getRevokedTokenStore } from "../revoked-token-store.js";
import type { McpTool } from "./tool-cache.js";

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// Bound upstream MCP calls so a slow/hung third-party server can't pin a
// worker turn (and the gateway request serving it) indefinitely. Applies to
// POST/DELETE (JSON-RPC calls) only — GET opens the streamable-HTTP SSE
// listening stream, which is long-lived by design and must not be aborted.
// 120s matches the worker-side MCP call budget.
export const UPSTREAM_FETCH_TIMEOUT_MS = Number(
	process.env.MCP_PROXY_FETCH_TIMEOUT_MS ?? 120_000,
);

export function upstreamTimeoutSignal(method: string): AbortSignal | undefined {
	return method.toUpperCase() === "GET"
		? undefined
		: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS);
}

/** Standard MCP `initialize` request body. */
export const INITIALIZE_BODY = JSON.stringify({
	jsonrpc: "2.0",
	method: "initialize",
	params: {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "lobu-gateway", version: "1.0.0" },
	},
	id: 0,
});

/** Standard MCP `notifications/initialized` body. */
export const INITIALIZED_NOTIFICATION_BODY = JSON.stringify({
	jsonrpc: "2.0",
	method: "notifications/initialized",
});

/** Payload shape surfaced to the user when an MCP upstream needs auth. */
export type AuthRequiredPayload = {
	status: "login_required" | "pending";
	url?: string;
	userCode?: string;
	message: string;
	expiresInSeconds?: number;
};

/**
 * Parse a JSON-RPC response body that may be either a plain JSON object
 * (Content-Type: application/json) or a single-event SSE stream
 * (Content-Type: text/event-stream). Streamable-HTTP MCP servers may return
 * either form per the MCP spec.
 */
export async function parseJsonRpcResponse(
	response: Response,
): Promise<unknown> {
	const contentType = response.headers.get("content-type") || "";
	if (contentType.includes("text/event-stream")) {
		const text = await response.text();
		// SSE frames: sequence of `event:`/`data:` lines separated by blank lines.
		// For request/response JSON-RPC we expect the last `data:` payload to be
		// the JSON-RPC response object.
		let payload = "";
		for (const line of text.split(/\r?\n/)) {
			if (line.startsWith("data:")) {
				payload = line.slice(5).trimStart();
			}
		}
		if (!payload) {
			throw new Error("SSE response contained no data payload");
		}
		return JSON.parse(payload);
	}
	return response.json();
}

export interface JsonRpcResponse {
	jsonrpc: string;
	id: unknown;
	result?: {
		tools?: McpTool[];
		content?: unknown[];
		isError?: boolean;
	};
	error?: { code: number; message: string };
}

export interface HttpMcpServerConfig {
	id: string;
	upstreamUrl: string;
	oauth?: import("@lobu/core").McpOAuthConfig;
	inputs?: unknown[];
	headers?: Record<string, string>;
	/** Credential scoping strategy: "user" (default) or "channel" (shared in a Slack channel). */
	authScope?: "user" | "channel";
	/** True when the upstream is the same embedded Lobu process (lobu-memory). */
	internal?: boolean;
}

export interface McpConfigSource {
	getHttpServer(
		id: string,
		agentId?: string,
	): Promise<HttpMcpServerConfig | undefined>;
	getAllHttpServers(
		agentId?: string,
	): Promise<Map<string, HttpMcpServerConfig>>;
}

export async function authenticateRequest(
	c: Context,
): Promise<{ tokenData: WorkerTokenData; token: string } | null> {
	const sessionToken = extractSessionToken(c);
	if (!sessionToken) return null;

	const tokenData = verifyWorkerToken(sessionToken);
	if (!tokenData) return null;

	if (
		tokenData.jti &&
		(await getRevokedTokenStore().isRevoked(tokenData.jti))
	) {
		return null;
	}

	return { tokenData, token: sessionToken };
}

/**
 * Run MCP proxy work inside the organization bound to the worker token.
 *
 * The Postgres secret store resolves org-scoped credentials from
 * AsyncLocalStorage, so authenticated MCP routes must install the token's
 * organization context before reading OAuth credentials.
 */
export function runWithWorkerOrgContext<T>(
	tokenData: WorkerTokenData,
	fn: () => T,
): T {
	return runWithOrganizationContext(tokenData.organizationId, fn);
}

export function runWithOrganizationContext<T>(
	organizationId: string | null | undefined,
	fn: () => T,
): T {
	if (!organizationId) {
		throw new Error("MCP organization context requires organizationId");
	}
	return orgContext.run({ organizationId }, fn);
}

export function extractSessionToken(c: Context): string | null {
	const authHeader = c.req.header("authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.substring(7);
	}

	return null;
}

export function buildUpstreamHeaders(
	sessionId: string | null,
	configHeaders?: Record<string, string>,
	credentialToken?: string,
	internal?: boolean,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		// MCP streamable-HTTP spec requires both — servers like DeepWiki reject
		// plain `application/json` with 406 Not Acceptable.
		Accept: "application/json, text/event-stream",
	};

	// Merge custom headers from server config (e.g. static auth tokens)
	if (configHeaders) {
		for (const [key, value] of Object.entries(configHeaders)) {
			headers[key] = value;
		}
	}

	// Per-user credential takes precedence over config headers for Authorization
	if (credentialToken) {
		headers.Authorization = `Bearer ${credentialToken}`;
	}

	// Stamp internal MCP requests so the embedded Lobu multi-tenant
	// middleware promotes the worker JWT to admin scope for this org.
	if (internal) {
		headers["X-Lobu-Memory-Direct-Auth"] = "1";
	}

	if (sessionId) {
		headers["Mcp-Session-Id"] = sessionId;
	}

	return headers;
}

/**
 * Compute the credential scope key from the server config + request context.
 * Returns `channel-<channelId>` when `authScope === "channel"` (and channelId
 * is present), otherwise `userId` for per-user scope.
 */
export function computeScopeKey(
	httpServer: HttpMcpServerConfig,
	userId: string,
	channelId: string | undefined,
): string {
	if (httpServer.authScope === "channel" && channelId) {
		return `channel-${channelId}`;
	}
	return userId;
}

/**
 * Build a session-store key for the upstream Mcp-Session-Id associated
 * with a specific (org, agent, mcp, scope) tuple. The session store is a
 * process-wide Map, and agentId is NOT globally unique (agents PK is
 * (organization_id, id)), so the key MUST be org-scoped to stop two orgs
 * sharing the same agentId+mcpId from bleeding upstream session handles into
 * each other. Scoping by scopeKey additionally prevents two users (or
 * user-vs-channel credentials) within an org from sharing a single upstream
 * session. The org is read from `runWithOrganizationContext` (every caller
 * runs inside it) so no signature need carry it.
 */
export function buildSessionKey(
	agentId: string,
	mcpId: string,
	scopeKey?: string,
): string {
	const orgId = getOrgId();
	const scope = scopeKey ?? "_unscoped";
	return `mcp:session:${orgId}:${agentId}:${mcpId}:${scope}`;
}

export async function getRequestBodyAsText(c: Context): Promise<string> {
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		return "";
	}

	try {
		return await c.req.text();
	} catch {
		return "";
	}
}

export function sendJsonRpcError(
	c: Context,
	code: number,
	message: string,
	id: unknown = null,
): Response {
	return c.json(
		{
			jsonrpc: "2.0",
			id,
			error: { code, message },
		},
		200,
	);
}
