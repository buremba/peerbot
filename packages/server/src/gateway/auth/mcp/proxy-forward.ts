import {
	createLogger,
	getErrorMessage,
	verifyWorkerToken,
} from "@lobu/core";
import type { Context } from "hono";
import type { McpProxy } from "./proxy.js";
import {
	buildSessionKey,
	buildUpstreamHeaders,
	computeScopeKey,
	extractSessionToken,
	getRequestBodyAsText,
	type HttpMcpServerConfig,
	MAX_BODY_SIZE,
	runWithWorkerOrgContext,
	sendJsonRpcError,
	UPSTREAM_FETCH_TIMEOUT_MS,
	upstreamTimeoutSignal,
} from "./proxy-shared.js";
import { ssrfBlockResponse } from "./proxy-upstream.js";

const logger = createLogger("mcp-proxy");

export async function handleProxyRequest(
	proxy: McpProxy,
	c: Context,
): Promise<Response> {
	const mcpId = c.req.param("mcpId") || c.req.header("x-mcp-id");
	const sessionToken = extractSessionToken(c);

	logger.info("Handling MCP proxy request", {
		method: c.req.method,
		path: c.req.path,
		mcpId,
		hasSessionToken: !!sessionToken,
	});

	if (!mcpId) {
		return sendJsonRpcError(c, -32600, "Missing MCP ID");
	}

	if (!sessionToken) {
		return sendJsonRpcError(c, -32600, "Missing authentication token");
	}

	const tokenData = verifyWorkerToken(sessionToken);
	if (!tokenData) {
		return sendJsonRpcError(c, -32600, "Invalid authentication token");
	}
	if (!tokenData.organizationId) {
		return sendJsonRpcError(c, -32600, "Worker token missing organizationId");
	}

	return runWithWorkerOrgContext(tokenData, () =>
		handleProxyRequestAuthenticated(proxy, c, mcpId, sessionToken, tokenData),
	);
}

async function handleProxyRequestAuthenticated(
	proxy: McpProxy,
	c: Context,
	mcpId: string,
	sessionToken: string,
	tokenData: NonNullable<ReturnType<typeof verifyWorkerToken>>,
): Promise<Response> {
	const agentId = tokenData.agentId || tokenData.userId;
	const httpServer = await proxy.configService.getHttpServer(mcpId, agentId);

	if (!httpServer) {
		return sendJsonRpcError(c, -32601, `MCP server '${mcpId}' not found`);
	}

	// Pre-tool guardrails + tool approval for tools/call JSON-RPC requests.
	// Clone the request so the body can be read twice (once here, once in
	// forwardRequest). NOTE: this runs on any POST, NOT gated on grantStore —
	// guardrail enforcement must not depend on the approval subsystem being
	// configured (the approval check below is what's gated on grantStore).
	if (c.req.method === "POST") {
		try {
			const clonedReq = c.req.raw.clone();
			const bodyText = await clonedReq.text();
			if (bodyText) {
				const jsonRpc = JSON.parse(bodyText);

				// JSON-RPC 2.0 / the MCP streamable-HTTP transport permit BATCH
				// requests: a top-level ARRAY of request objects. The single-request
				// gate below keys on `jsonRpc.method`, which is `undefined` for an
				// array — so a batched `tools/call` would skip BOTH the pre-tool
				// guardrails and the approval gate and be forwarded verbatim, and a
				// spec-compliant upstream executes the whole batch. The worker's MCP
				// client never legitimately batches tool calls, so reject any batch
				// containing one rather than forward it unguarded. Batches with no
				// tools/call (e.g. notification batches) still pass through.
				if (Array.isArray(jsonRpc)) {
					if (jsonRpc.some((m) => m?.method === "tools/call")) {
						logger.warn(
							"Rejecting batched tools/call — guardrails and approval cannot be enforced on a JSON-RPC batch",
							{ mcpId, agentId },
						);
						return sendJsonRpcError(
							c,
							-32600,
							"Batched tools/call is not permitted; send each tool call as a single JSON-RPC request.",
						);
					}
				} else if (jsonRpc.method === "tools/call" && jsonRpc.params?.name) {
					const toolName = jsonRpc.params.name;
					const toolArgs = jsonRpc.params.arguments || {};

					// Pre-tool guardrails run before approval so a blocked tool never
					// enters the approval funnel, and independently of grantStore.
					if (
						await proxy.runPreToolGuardrails(
							agentId,
							tokenData,
							toolName,
							toolArgs,
						)
					) {
						return c.json({
							jsonrpc: "2.0",
							id: jsonRpc.id,
							result: {
								content: [
									{ type: "text", text: "Tool call blocked by policy." },
								],
								isError: true,
							},
						});
					}

					// Tool approval is gated on the approval subsystem (grantStore).
					if (proxy.grantStore) {
						const approval = await proxy.evaluateToolApproval(
							mcpId,
							toolName,
							toolArgs,
							agentId,
							tokenData,
							sessionToken,
						);
						if (approval !== "allow") {
							return c.json({
								jsonrpc: "2.0",
								id: jsonRpc.id,
								result: {
									content: [
										{
											type: "text",
											text: "Tool call requires approval. The user has been asked to approve. Your session will end. The result will arrive as your next message.",
										},
									],
									isError: true,
								},
							});
						}
					}
				}
			}
		} catch {
			// If body parsing fails, just forward the request as-is
		}
	}

	const scopeKey = computeScopeKey(tokenData.userId);

	try {
		return await forwardRequest(proxy, c, httpServer, agentId, mcpId, scopeKey, {
			workerToken: sessionToken,
		});
	} catch (error) {
		logger.error("Failed to proxy MCP request", { error, mcpId });
		return sendJsonRpcError(
			c,
			-32603,
			`Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

async function forwardRequest(
	proxy: McpProxy,
	c: Context,
	httpServer: HttpMcpServerConfig,
	agentId: string,
	mcpId: string,
	scopeKey?: string,
	authContext?: {
		workerToken?: string;
	},
): Promise<Response> {
	const ssrfBlock = await ssrfBlockResponse(httpServer, mcpId, agentId);
	if (ssrfBlock) {
		return sendJsonRpcError(
			c,
			-32600,
			"Upstream URL resolves to a blocked internal network",
		);
	}

	const sessionKey = buildSessionKey(agentId, mcpId, scopeKey);
	let sessionId = proxy.upstream.getSession(sessionKey);

	const bodyText = await getRequestBodyAsText(c);

	// Body size validation
	if (bodyText.length > MAX_BODY_SIZE) {
		logger.warn("Request body too large", {
			mcpId,
			agentId,
			size: bodyText.length,
		});
		return new Response("Request body too large", { status: 413 });
	}

	// Internal MCPs (lobu-memory) accept the worker JWT directly.
	const credentialToken = httpServer.internal
		? authContext?.workerToken
		: undefined;

	// If no active session exists, re-initialize before forwarding
	if (!sessionId && c.req.method === "POST") {
		try {
			await proxy.upstream.reinitializeSession(
				httpServer,
				agentId,
				mcpId,
				scopeKey,
				credentialToken,
			);
			sessionId = proxy.upstream.getSession(sessionKey);
		} catch (error) {
			logger.warn("Pre-emptive MCP re-initialization failed", {
				mcpId,
				error: getErrorMessage(error),
			});
		}
	}

	logger.info("Proxying MCP request", {
		mcpId,
		agentId,
		method: c.req.method,
		hasSession: !!sessionId,
		bodyLength: bodyText.length,
	});

	const headers = buildUpstreamHeaders(
		sessionId,
		credentialToken,
		httpServer.internal === true,
	);

	let response = await fetch(httpServer.upstreamUrl, {
		method: c.req.method,
		headers,
		body: bodyText || undefined,
		signal: upstreamTimeoutSignal(c.req.method),
	});

	// Stale-session recovery: if upstream returns 404 we sent a session id
	// it no longer recognizes (e.g. server restart). Drop the cached id,
	// re-init, and retry once with the same payload. Only meaningful for
	// POST — GET/DELETE on an unknown session should surface the 404 as-is.
	if (
		response.status === 404 &&
		sessionId &&
		c.req.method === "POST" &&
		bodyText
	) {
		logger.info(
			"Upstream 404 on cached session id — re-initializing and retrying",
			{ mcpId, agentId },
		);
		try {
			await proxy.upstream.reinitializeSession(
				httpServer,
				agentId,
				mcpId,
				scopeKey,
				credentialToken,
			);
			sessionId = proxy.upstream.getSession(sessionKey);
			const retryHeaders = buildUpstreamHeaders(
				sessionId,
				credentialToken,
				httpServer.internal === true,
			);
			response = await fetch(httpServer.upstreamUrl, {
				method: c.req.method,
				headers: retryHeaders,
				body: bodyText,
				// Retry path is POST-only (guarded above) — always bounded.
				signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
			});
		} catch (error) {
			logger.warn("Stale-session recovery failed on forward", {
				mcpId,
				error: getErrorMessage(error),
			});
		}
	}

	const newSessionId = response.headers.get("Mcp-Session-Id");
	if (newSessionId) {
		proxy.upstream.setSession(sessionKey, newSessionId);
		logger.debug("Stored MCP session ID", {
			mcpId,
			agentId,
			sessionId: newSessionId,
		});
	}

	const responseHeaders = new Headers();
	const contentType = response.headers.get("content-type");
	if (contentType) {
		responseHeaders.set("Content-Type", contentType);
	}
	if (newSessionId) {
		responseHeaders.set("Mcp-Session-Id", newSessionId);
	}

	return new Response(response.body, {
		status: response.status,
		headers: responseHeaders,
	});
}
