import { createLogger } from "@lobu/core";
import type { Context } from "hono";
import type { McpProxy } from "./proxy.js";
import {
	authenticateRequest,
	computeScopeKey,
	type JsonRpcResponse,
	MAX_BODY_SIZE,
	parseJsonRpcResponse,
} from "./proxy-shared.js";
import { ssrfBlockResponse } from "./proxy-upstream.js";
import type { McpTool } from "./tool-cache.js";

const logger = createLogger("mcp-proxy");

export async function handleListTools(
	proxy: McpProxy,
	c: Context,
): Promise<Response> {
	const mcpId = c.req.param("mcpId");
	if (!mcpId) return c.json({ error: "Missing MCP server id" }, 400);
	const auth = await authenticateRequest(c);
	if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

	const agentId = auth.tokenData.agentId || auth.tokenData.userId;
	const requesterUserId = auth.tokenData.userId;
	if (!agentId || !requesterUserId) {
		return c.json({ error: "Invalid authentication token" }, 401);
	}
	const httpServer = await proxy.configService.getHttpServer(mcpId, agentId);
	if (!httpServer) {
		return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
	}

	// The curl-facing introspection endpoint must surface a hard SSRF block as
	// 403 — fetchToolsForMcp fails soft for agent-boot discovery and would
	// otherwise drain the blocked response and return an empty 200.
	const ssrfBlock = await ssrfBlockResponse(httpServer, mcpId, agentId);
	if (ssrfBlock) return ssrfBlock;

	try {
		const { tools, instructions } = await proxy.fetchToolsForMcp(
			mcpId,
			agentId,
			auth.tokenData,
			httpServer.internal === true ? auth.token : undefined,
			{ surfaceErrors: true },
		);
		return c.json({ tools, instructions });
	} catch (error) {
		logger.error("Failed to list tools", { mcpId, error });
		return c.json(
			{
				error: `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
			},
			502,
		);
	}
}

export async function handleCallTool(
	proxy: McpProxy,
	c: Context,
): Promise<Response> {
	const mcpId = c.req.param("mcpId");
	const toolName = c.req.param("toolName");
	if (!mcpId || !toolName) {
		return c.json({ error: "Missing MCP server id or tool name" }, 400);
	}
	const auth = await authenticateRequest(c);
	if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

	const agentId = auth.tokenData.agentId || auth.tokenData.userId;
	const requesterUserId = auth.tokenData.userId;
	if (!agentId || !requesterUserId) {
		return c.json({ error: "Invalid authentication token" }, 401);
	}
	const httpServer = await proxy.configService.getHttpServer(mcpId, agentId);
	if (!httpServer) {
		return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
	}
	const channelId = auth.tokenData.channelId || "";
	const scopeKey = computeScopeKey(httpServer, requesterUserId, channelId);

	// Parse body early so tool arguments are available for the approval message.
	let toolArguments: Record<string, unknown> = {};
	try {
		const body = await c.req.text();
		if (body) {
			if (body.length > MAX_BODY_SIZE) {
				return c.json({ error: "Request body too large" }, 413);
			}
			toolArguments = JSON.parse(body);
		}
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	// Pre-tool guardrails — same enforcement as the JSON-RPC path so this REST
	// entrypoint can't bypass the stage. Runs before approval and independently
	// of grantStore.
	if (
		await proxy.runPreToolGuardrails(
			agentId,
			auth.tokenData,
			toolName,
			toolArguments,
		)
	) {
		return c.json({
			content: [{ type: "text", text: "Tool call blocked by policy." }],
			isError: true,
		});
	}

	// Check tool approval based on annotations and grants.
	const approval = await proxy.evaluateToolApproval(
		mcpId,
		toolName,
		toolArguments,
		agentId,
		auth.tokenData,
		auth.token,
	);
	if (approval === "blocked-notified") {
		return c.json(
			{
				content: [
					{
						type: "text",
						text: "Tool call requires approval. The user has been asked to approve. Your session will end. The result will arrive as your next message.",
					},
				],
				isError: true,
			},
			403,
		);
	}
	if (approval === "blocked-no-channel") {
		return c.json(
			{
				content: [
					{
						type: "text",
						text: `Tool call requires approval. Request access approval in chat for: ${mcpId} → ${toolName}`,
					},
				],
				isError: true,
			},
			403,
		);
	}

	try {
		const jsonRpcBody = JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: toolName, arguments: toolArguments },
			id: 1,
		});

		// Forward the caller's `x-mcp-format` opt-in so internal MCPs (the
		// embedded lobu-memory server) can return raw JSON instead of formatted
		// markdown. The worker uses this for retrieval tools to surface
		// structured `result_summary` (event ids + snippet text) through the
		// `tool_use` SSE event.
		const callerFormat = c.req.header("x-mcp-format");
		const extraHeaders = callerFormat
			? { "x-mcp-format": callerFormat }
			: undefined;

		let response = await proxy.upstream.sendUpstreamRequest(
			httpServer,
			agentId,
			mcpId,
			"POST",
			jsonRpcBody,
			scopeKey,
			auth.token,
			extraHeaders,
		);

		// Detect HTTP 401 + WWW-Authenticate → start MCP OAuth 2.1 auth-code flow.
		// This path runs before JSON-RPC parsing because most compliant MCP
		// servers (Sentry, etc.) return 401 at the transport layer, not a
		// JSON-RPC error body.
		if (response.status === 401) {
			const payload = await proxy.authFlows.handleUpstream401({
				response,
				mcpId,
				agentId,
				userId: requesterUserId,
				scopeKey,
				httpServer,
				wwwAuthenticate: response.headers.get("www-authenticate"),
				platform: auth.tokenData.platform,
				channelId,
				conversationId: auth.tokenData.conversationId || "",
				teamId: auth.tokenData.teamId,
				connectionId: auth.tokenData.connectionId,
				deviceAuthFallback: true,
			});
			return c.json(
				{
					content: [
						{
							type: "text",
							text: payload
								? JSON.stringify(payload)
								: `Authentication required for ${mcpId} but OAuth discovery failed.`,
						},
					],
					isError: true,
				},
				200,
			);
		}

		let data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;

		// Re-initialize session and retry on stale-session errors.
		//
		// Primary signal: MCP streamable-HTTP transport mandates HTTP 404 when
		// the `Mcp-Session-Id` header names a session the server no longer
		// knows (e.g. upstream restarted while we held the id cached).
		//
		// Fallback signal: some MCP servers return 200 with a JSON-RPC error
		// whose message is "Server not initialized" or "Session not found…".
		// We match both wordings rather than chase specific upstream phrasing.
		if (
			response.status === 404 ||
			(data?.error &&
				/not initialized|session not found/i.test(data.error.message || ""))
		) {
			logger.info("MCP session expired, re-initializing before retry", {
				mcpId,
				toolName,
			});
			await proxy.upstream.reinitializeSession(
				httpServer,
				agentId,
				mcpId,
				scopeKey,
				auth.token,
			);

			response = await proxy.upstream.sendUpstreamRequest(
				httpServer,
				agentId,
				mcpId,
				"POST",
				jsonRpcBody,
				scopeKey,
				auth.token,
			);
			data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;
		}

		if (data?.error) {
			const errorMsg =
				data.error.message ||
				(typeof data.error === "string" ? data.error : "Upstream error");
			logger.error("Upstream returned JSON-RPC error on tool call", {
				mcpId,
				toolName,
				error: data.error,
			});

			// Detect auth errors — auto-start device-code auth flow
			if (/unauthorized|unauthenticated|forbidden/i.test(errorMsg)) {
				const autoAuthResult = await proxy.authFlows.tryAutoDeviceAuth(
					mcpId,
					agentId,
					scopeKey,
				);
				if (autoAuthResult) {
					await proxy.authFlows.fireAuthRequired(
						agentId,
						requesterUserId,
						mcpId,
						autoAuthResult,
						auth.tokenData.channelId || "",
						auth.tokenData.conversationId || "",
						auth.tokenData.teamId,
						auth.tokenData.connectionId,
						auth.tokenData.platform,
					);
				}
				return c.json(
					{
						content: [
							{
								type: "text",
								text: autoAuthResult
									? JSON.stringify(autoAuthResult)
									: `Authentication required for ${mcpId}. Call ${mcpId}_login to authenticate.`,
							},
						],
						isError: true,
					},
					200,
				);
			}

			return c.json(
				{
					content: [],
					isError: true,
					error: errorMsg,
				},
				502,
			);
		}

		const result = data?.result || {};
		return c.json({
			content: result.content || [],
			isError: result.isError || false,
		});
	} catch (error) {
		logger.error("Failed to call tool", { mcpId, toolName, error });
		return c.json(
			{
				content: [],
				isError: true,
				error: `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
			},
			502,
		);
	}
}

export async function handleListAllTools(
	proxy: McpProxy,
	c: Context,
): Promise<Response> {
	const auth = await authenticateRequest(c);
	if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

	const agentId = auth.tokenData.agentId || auth.tokenData.userId;

	const allHttpServers = await proxy.configService.getAllHttpServers(agentId);
	const allMcpIds = Array.from(allHttpServers.keys());

	const mcpServers: Record<string, { tools: McpTool[] }> = {};

	// Fetch tools in parallel, tolerate failures
	const results = await Promise.allSettled(
		allMcpIds.map(async (mcpId) => {
			const { tools } = await proxy.fetchToolsForMcp(
				mcpId,
				agentId,
				auth.tokenData,
				auth.token,
			);
			return { mcpId, tools };
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled" && result.value.tools.length > 0) {
			mcpServers[result.value.mcpId] = { tools: result.value.tools };
		}
	}

	return c.json({ mcpServers });
}
