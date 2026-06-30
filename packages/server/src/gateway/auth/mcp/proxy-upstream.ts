import { createLogger } from "@lobu/core";
import { isInternalUrl } from "../../proxy/ssrf-guard.js";
import {
	buildSessionKey,
	buildUpstreamHeaders,
	type HttpMcpServerConfig,
	INITIALIZE_BODY,
	INITIALIZED_NOTIFICATION_BODY,
	upstreamTimeoutSignal,
} from "./proxy-shared.js";

const logger = createLogger("mcp-proxy");

/**
 * SSRF guard: if the upstream URL resolves to an internal/reserved network
 * (and the server isn't an embedded internal MCP), log it and return a 403
 * JSON-RPC error response. Returns null when the request may proceed.
 */
export async function ssrfBlockResponse(
	httpServer: HttpMcpServerConfig,
	mcpId: string,
	agentId: string,
): Promise<Response | null> {
	if (httpServer.internal || !(await isInternalUrl(httpServer.upstreamUrl))) {
		return null;
	}
	logger.warn("Blocked SSRF attempt to internal URL", {
		url: httpServer.upstreamUrl,
		mcpId,
		agentId,
	});
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32600,
				message: "Upstream URL resolves to a blocked internal network",
			},
		}),
		{ status: 403, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * Upstream MCP transport client: owns the per-process session-id cache,
 * resolves per-scope credentials, and performs the initialize handshake and
 * non-streamed JSON-RPC egress to MCP upstreams.
 */
export class McpUpstreamClient {
	private readonly SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
	/**
	 * Per-process MCP upstream session-id cache. The session id is opaque to
	 * the gateway and only valid for the upstream MCP server, so on a gateway
	 * restart the worker simply re-runs `initialize` and gets a new session —
	 * no cross-replica coherence needed.
	 */
	private readonly sessions = new Map<
		string,
		{ sessionId: string; expiresAt: number }
	>();

	getSession(key: string): string | null {
		const entry = this.sessions.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.sessions.delete(key);
			return null;
		}
		// Refresh TTL on read.
		entry.expiresAt = Date.now() + this.SESSION_TTL_SECONDS * 1000;
		return entry.sessionId;
	}

	setSession(key: string, sessionId: string): void {
		this.sessions.set(key, {
			sessionId,
			expiresAt: Date.now() + this.SESSION_TTL_SECONDS * 1000,
		});
	}

	deleteSession(key: string): void {
		this.sessions.delete(key);
	}

	/**
	 * Single egress point for non-streamed JSON-RPC calls to an MCP upstream.
	 * The internal lobu-memory server accepts the worker JWT directly; runs the
	 * SSRF guard and tracks the upstream session id.
	 */
	async sendUpstreamRequest(
		httpServer: HttpMcpServerConfig,
		agentId: string,
		mcpId: string,
		method: string,
		body?: string,
		scopeKey?: string,
		directAuthToken?: string,
		extraHeaders?: Record<string, string>,
	): Promise<Response> {
		const sessionKey = buildSessionKey(agentId, mcpId, scopeKey);
		const sessionId = this.getSession(sessionKey);

		// Internal MCPs (lobu-memory) live in the same Lobu process and accept
		// the worker JWT directly.
		const credentialToken = httpServer.internal ? directAuthToken : undefined;

		const ssrfBlock = await ssrfBlockResponse(httpServer, mcpId, agentId);
		if (ssrfBlock) return ssrfBlock;

		const headers = buildUpstreamHeaders(
			sessionId,
			credentialToken,
			httpServer.internal === true,
		);
		if (extraHeaders) {
			for (const [key, value] of Object.entries(extraHeaders)) {
				headers[key] = value;
			}
		}

		const response = await fetch(httpServer.upstreamUrl, {
			method,
			headers,
			body: body || undefined,
			signal: upstreamTimeoutSignal(method),
		});

		// Track session
		const newSessionId = response.headers.get("Mcp-Session-Id");
		if (newSessionId) {
			this.setSession(sessionKey, newSessionId);
		}

		return response;
	}

	/** Send the MCP `initialize` request to an upstream and return the raw response. */
	async sendInitialize(
		httpServer: HttpMcpServerConfig,
		agentId: string,
		mcpId: string,
		scopeKey?: string,
		directAuthToken?: string,
	): Promise<Response> {
		return this.sendUpstreamRequest(
			httpServer,
			agentId,
			mcpId,
			"POST",
			INITIALIZE_BODY,
			scopeKey,
			directAuthToken,
		);
	}

	/** Send the MCP `notifications/initialized` notification (best-effort). */
	async sendInitializedNotification(
		httpServer: HttpMcpServerConfig,
		agentId: string,
		mcpId: string,
		scopeKey?: string,
		directAuthToken?: string,
	): Promise<void> {
		await this.sendUpstreamRequest(
			httpServer,
			agentId,
			mcpId,
			"POST",
			INITIALIZED_NOTIFICATION_BODY,
			scopeKey,
			directAuthToken,
		).catch(() => {
			/* noop */
		});
	}

	/**
	 * Re-initialize an MCP session by sending initialize + notifications/initialized.
	 * Called when upstream returns "Server not initialized" (stale session).
	 */
	async reinitializeSession(
		httpServer: HttpMcpServerConfig,
		agentId: string,
		mcpId: string,
		scopeKey?: string,
		directAuthToken?: string,
	): Promise<void> {
		// Clear stale session
		this.deleteSession(buildSessionKey(agentId, mcpId, scopeKey));

		const initResponse = await this.sendInitialize(
			httpServer,
			agentId,
			mcpId,
			scopeKey,
			directAuthToken,
		);
		await initResponse.text(); // consume response (may be JSON or SSE-framed)

		await this.sendInitializedNotification(
			httpServer,
			agentId,
			mcpId,
			scopeKey,
			directAuthToken,
		);

		logger.info("Re-initialized MCP session", { mcpId, agentId });
	}
}
