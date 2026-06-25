import { randomUUID } from "node:crypto";
import {
	createLogger,
	getErrorMessage,
	type GuardrailRegistry,
	runGuardrailInstances,
	type WorkerTokenData,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  enabledInlineGuardrails,
  resolveAgentGuardrails,
} from "../../guardrails/aggregator.js";
import { recordGuardrailTrip } from "../../guardrails/audit.js";
import { requiresToolApproval } from "../../permissions/approval-policy.js";
import type { GrantStore } from "../../permissions/grant-store.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import type { AgentSettingsStore } from "../settings/agent-settings-store.js";
import { storePendingTool } from "./pending-tool-store.js";
import {
	McpAuthFlows,
	type OnAuthRequiredHandler,
} from "./proxy-auth-flows.js";
import { handleProxyRequest } from "./proxy-forward.js";
import {
	handleCallTool,
	handleListAllTools,
	handleListTools,
} from "./proxy-rest-routes.js";
import {
	buildSessionKey,
	computeScopeKey,
	type JsonRpcResponse,
	type McpConfigSource,
	parseJsonRpcResponse,
	runWithOrganizationContext,
} from "./proxy-shared.js";
import { McpUpstreamClient } from "./proxy-upstream.js";
import type { CachedMcpServer, McpTool, McpToolCache } from "./tool-cache.js";

const logger = createLogger("mcp-proxy");

export class McpProxy {
	// Tool-approval cards may sit in-thread for a long time before the user
	// actually clicks (Slack notifications, async review, etc.). The pending
	// invocation key holds the args needed to execute the tool after approval;
	// 24h gives users a realistic window to respond. Anything shorter silently
	// drops late clicks (the take-on-claim returns null and the click no-ops).
	private readonly PENDING_TOOL_TTL = 24 * 60 * 60; // 24 hours
	private app: Hono;
	private readonly toolCache?: McpToolCache;
	/** @internal Used by the route-handler modules (proxy-forward, proxy-rest-routes). */
	readonly grantStore?: GrantStore;
	/** @internal Used by the route-handler modules (proxy-forward, proxy-rest-routes). */
	readonly agentSettingsStore?: AgentSettingsStore;
	/** @internal Used by the route-handler modules (proxy-forward, proxy-rest-routes). */
	readonly guardrailRegistry?: GuardrailRegistry;
	/** @internal Upstream transport client (sessions, credentials, egress). */
	readonly upstream: McpUpstreamClient;
	/** @internal Auth-flow helper (401 handling, OAuth/device-code kickoff). */
	readonly authFlows: McpAuthFlows;

	/** Callback invoked when a tool call is blocked for approval. */
	public onToolBlocked?: (
		requestId: string,
		agentId: string,
		userId: string,
		mcpId: string,
		toolName: string,
		args: Record<string, unknown>,
		grantPattern: string,
		channelId: string,
		conversationId: string,
		teamId: string | undefined,
		connectionId: string | undefined,
		platform: string | undefined,
		source: string | undefined,
	) => Promise<void>;

	/** Callback invoked when an MCP auth flow is started or already pending. */
	public get onAuthRequired(): OnAuthRequiredHandler | undefined {
		return this.authFlows.onAuthRequired;
	}

	public set onAuthRequired(handler: OnAuthRequiredHandler | undefined) {
		this.authFlows.onAuthRequired = handler;
	}

	constructor(
		readonly configService: McpConfigSource,
		options: {
			secretStore: WritableSecretStore;
			toolCache?: McpToolCache;
			grantStore?: GrantStore;
			/** Absolute gateway URL for OAuth redirect_uri construction. */
			publicGatewayUrl?: string;
			/** Source of per-agent guardrail enable lists for the pre-tool stage. */
			agentSettingsStore?: AgentSettingsStore;
			/** Shared registry of guardrails; pre-tool stage entries are queried. */
			guardrailRegistry?: GuardrailRegistry;
		},
	) {
		this.toolCache = options.toolCache;
		this.grantStore = options.grantStore;
		this.agentSettingsStore = options.agentSettingsStore;
		this.guardrailRegistry = options.guardrailRegistry;
		this.upstream = new McpUpstreamClient(options.secretStore);
		this.authFlows = new McpAuthFlows(
			configService,
			options.secretStore,
			options.publicGatewayUrl,
		);
		this.app = new Hono();
		this.setupRoutes();
		logger.debug("MCP proxy initialized");
	}

	getApp(): Hono {
		return this.app;
	}

	/**
	 * Execute an MCP tool call directly (internal use, no HTTP auth).
	 * Used by the interaction bridge to execute tool calls after user approval.
	 */
	async executeToolDirect(
		agentId: string,
		userId: string,
		mcpId: string,
		toolName: string,
		args: Record<string, unknown>,
		options: { organizationId: string },
	): Promise<{
		content: Array<{ type: string; text: string }>;
		isError: boolean;
	}> {
		return runWithOrganizationContext(options?.organizationId, () =>
			this.executeToolDirectScoped(agentId, userId, mcpId, toolName, args),
		);
	}

	private async executeToolDirectScoped(
		agentId: string,
		userId: string,
		mcpId: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		isError: boolean;
	}> {
		const httpServer = await this.configService.getHttpServer(mcpId, agentId);
		if (!httpServer) {
			return {
				content: [{ type: "text", text: `MCP server '${mcpId}' not found` }],
				isError: true,
			};
		}

		// executeToolDirect is called from the interaction bridge after user
		// approval, where no channelId is carried — so we can only honor
		// authScope="user" here. For channel-scoped servers, fall back to
		// userId (still correct for the requesting user's personal credential).
		const scopeKey = computeScopeKey(httpServer, userId, undefined);

		const jsonRpcBody = JSON.stringify({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: toolName, arguments: args },
			id: 1,
		});

		try {
			const response = await this.upstream.sendUpstreamRequest(
				httpServer,
				agentId,
				mcpId,
				"POST",
				jsonRpcBody,
				scopeKey,
			);

			if (!response.ok) {
				const text = await response.text();
				return {
					content: [
						{
							type: "text",
							text: `Tool call failed: ${response.status} ${text}`,
						},
					],
					isError: true,
				};
			}

			const json = (await parseJsonRpcResponse(response)) as {
				result?: {
					content?: Array<{ type: string; text: string }>;
					isError?: boolean;
				};
				content?: Array<{ type: string; text: string }>;
				isError?: boolean;
			};
			const result = json.result || json;
			return {
				content: result.content || [
					{ type: "text", text: JSON.stringify(result) },
				],
				isError: result.isError || false,
			};
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Tool execution error: ${String(error)}`,
					},
				],
				isError: true,
			};
		}
	}

	/**
	 * Check if this request is an MCP proxy request (has X-Mcp-Id header)
	 * Used by gateway to determine if root path requests should be handled by MCP proxy
	 */
	isMcpRequest(c: Context): boolean {
		return !!c.req.header("x-mcp-id");
	}

	/**
	 * Fetch tools and instructions for a specific MCP server.
	 * Performs MCP initialize handshake first to capture server instructions,
	 * then fetches tool list.
	 */
	async fetchToolsForMcp(
		mcpId: string,
		agentId: string,
		tokenData: WorkerTokenData,
		workerToken?: string,
		options?: { surfaceErrors?: boolean },
	): Promise<{ tools: McpTool[]; instructions?: string }> {
		return runWithOrganizationContext(tokenData.organizationId, () =>
			this.fetchToolsForMcpScoped(
				mcpId,
				agentId,
				tokenData,
				workerToken,
				options,
			),
		);
	}

	private async fetchToolsForMcpScoped(
		mcpId: string,
		agentId: string,
		tokenData: WorkerTokenData,
		workerToken?: string,
		options?: { surfaceErrors?: boolean },
	): Promise<{ tools: McpTool[]; instructions?: string }> {
		if (this.toolCache) {
			const cached = this.toolCache.getServerInfo(mcpId, agentId);
			if (cached) return cached;
		}

		const httpServer = await this.configService.getHttpServer(mcpId, agentId);
		if (!httpServer) {
			return { tools: [] };
		}

		const userId = tokenData?.userId;
		const channelId = tokenData?.channelId || "";
		const scopeKey = computeScopeKey(httpServer, userId, channelId);

		try {
			// Clear any stale session before fresh tool discovery
			this.upstream.deleteSession(buildSessionKey(agentId, mcpId, scopeKey));

			// Step 1: Send initialize to capture server instructions
			let instructions: string | undefined;
			try {
				const initResponse = await this.upstream.sendInitialize(
					httpServer,
					agentId,
					mcpId,
					scopeKey,
					workerToken,
				);

				// Tool discovery runs before the agent has a chance to call anything.
				// If the server demands OAuth, kick off the auth-code flow here so the
				// "Connect X" link reaches the user up-front.
				if (initResponse.status === 401) {
					const wwwAuth = initResponse.headers.get("www-authenticate");
					await initResponse.body?.cancel().catch(() => {
						/* noop */
					});
					await this.authFlows.fireAuthCodeFlowFromDiscovery({
						mcpId,
						agentId,
						httpServer,
						wwwAuthenticate: wwwAuth,
						scopeKey,
						tokenData,
					});
					return { tools: [] };
				}

				const initData = (await parseJsonRpcResponse(initResponse)) as {
					result?: { instructions?: string };
					error?: { code: number; message: string };
				};

				if (initData?.result?.instructions) {
					instructions = initData.result.instructions;
					logger.info("Captured MCP server instructions", {
						mcpId,
						length: instructions.length,
					});
				}

				// Step 2: Send initialized notification (required by MCP spec)
				await this.upstream.sendInitializedNotification(
					httpServer,
					agentId,
					mcpId,
					scopeKey,
					workerToken,
				);
			} catch (initError) {
				logger.warn("MCP initialize failed (continuing with tools/list)", {
					mcpId,
					error:
						getErrorMessage(initError),
				});
			}

			// Step 3: Fetch tools list
			const jsonRpcBody = JSON.stringify({
				jsonrpc: "2.0",
				method: "tools/list",
				params: {},
				id: 1,
			});

			const response = await this.upstream.sendUpstreamRequest(
				httpServer,
				agentId,
				mcpId,
				"POST",
				jsonRpcBody,
				scopeKey,
				workerToken,
			);

			if (response.status === 401) {
				const wwwAuth = response.headers.get("www-authenticate");
				await response.body?.cancel().catch(() => {
					/* noop */
				});
				await this.authFlows.fireAuthCodeFlowFromDiscovery({
					mcpId,
					agentId,
					httpServer,
					wwwAuthenticate: wwwAuth,
					scopeKey,
					tokenData,
				});
				return { tools: [] };
			}

			const data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;
			const tools: McpTool[] = data?.result?.tools || [];

			const serverInfo: CachedMcpServer = { tools, instructions };
			if (this.toolCache && tools.length > 0) {
				this.toolCache.setServerInfo(mcpId, serverInfo, agentId);
			}

			return serverInfo;
		} catch (error) {
			logger.warn("Failed to fetch tools for MCP, retrying once", {
				mcpId,
				error: getErrorMessage(error),
			});

			// Retry once after a short delay (upstream may still be starting)
			await new Promise((r) => setTimeout(r, 2000));
			try {
				const retryBody = JSON.stringify({
					jsonrpc: "2.0",
					method: "tools/list",
					params: {},
					id: 1,
				});
				const retryResponse = await this.upstream.sendUpstreamRequest(
					httpServer,
					agentId,
					mcpId,
					"POST",
					retryBody,
					scopeKey,
					workerToken,
				);
				const retryData = (await parseJsonRpcResponse(
					retryResponse,
				)) as JsonRpcResponse;
				const retryTools: McpTool[] = retryData?.result?.tools || [];
				if (retryTools.length > 0) {
					const serverInfo: CachedMcpServer = { tools: retryTools };
					if (this.toolCache) {
						this.toolCache.setServerInfo(mcpId, serverInfo, agentId);
					}
					logger.info("Retry succeeded for MCP tool fetch", {
						mcpId,
						toolCount: retryTools.length,
					});
					return serverInfo;
				}
			} catch (retryError) {
				logger.error("Retry also failed for MCP tool fetch", {
					mcpId,
					error:
						retryError instanceof Error
							? retryError.message
							: String(retryError),
				});
				// The curl-facing REST endpoint surfaces upstream failures as 502;
				// agent-boot discovery (the default) fails soft so one unreachable
				// MCP doesn't block the worker from starting.
				if (options?.surfaceErrors) throw retryError;
			}
			if (options?.surfaceErrors) throw error;
			return { tools: [] };
		}
	}

	private setupRoutes() {
		// REST API endpoints for curl-based tool access (registered BEFORE catch-all)
		this.app.get("/tools", (c) => handleListAllTools(this, c));
		this.app.get("/:mcpId/tools", (c) => handleListTools(this, c));
		this.app.post("/:mcpId/tools/:toolName", (c) => handleCallTool(this, c));

		// Path-based routes (catch-all for MCP streamable-HTTP transport)
		this.app.all("/:mcpId", (c) => handleProxyRequest(this, c));
		this.app.all("/:mcpId/*", (c) => handleProxyRequest(this, c));
	}

	/**
	* Run the agent's resolved pre-tool guardrails (built-in names + skill-
	* declared SKILL.md guardrails) for a `tools/call`. Returns true if a
	* guardrail tripped and the call must be blocked — the caller then returns a
	* generic, platform-shaped "blocked by policy" response (the specific reason
	* is never surfaced to the worker; that would be an evasion oracle).
	*
	* Shared by BOTH tool-call entrypoints — the JSON-RPC forward path
	* (`handleProxyRequest`) and the REST `handleCallTool` — so neither can
	* bypass the stage, and independent of `grantStore` so guardrails enforce
	* even when the approval subsystem isn't configured.
	*
	* Fails OPEN on store/registry-level errors (per-guardrail throws already
	* fail open in the runner); judge guardrails fail CLOSED by design.
	*
	* @internal Public only for the route-handler modules.
	*/
	async runPreToolGuardrails(
		agentId: string,
		tokenData: {
			userId: string;
			conversationId?: string;
			organizationId?: string;
		},
		toolName: string,
		toolArgs: Record<string, unknown>,
	): Promise<boolean> {
		if (!this.guardrailRegistry || !this.agentSettingsStore) return false;
		try {
			const settings = await this.agentSettingsStore.getSettings(agentId);
			const resolved = resolveAgentGuardrails(
				settings ?? { guardrails: [] },
				(settings?.skillsConfig?.skills ?? []).filter((s) => s.enabled),
				this.guardrailRegistry,
				{ inline: enabledInlineGuardrails(settings) },
			);
			const list = resolved.byStage["pre-tool"];
			if (list.length === 0) return false;
			const outcome = await runGuardrailInstances("pre-tool", list, {
				agentId,
				userId: tokenData.userId,
				toolName,
				arguments: toolArgs,
				conversationId: tokenData.conversationId,
			});
			if (!outcome.tripped) return false;
			// Resolve org id with a metadata fallback — per-job tokens carry it, but
			// legacy deployment-lifetime tokens may not, and an unaudited trip is a
			// security log gap.
			let resolvedOrgId = tokenData.organizationId;
			if (!resolvedOrgId) {
				try {
					const md = await this.agentSettingsStore.getMetadata(agentId);
					resolvedOrgId = md?.organizationId;
				} catch (lookupErr) {
					logger.warn(
						{
							agentId,
							err:
								lookupErr instanceof Error
									? lookupErr.message
									: String(lookupErr),
						},
						"Pre-tool guardrail trip: orgId metadata lookup failed (audit may be skipped)",
					);
				}
			}
			void recordGuardrailTrip({
				organizationId: resolvedOrgId,
				agentId,
				userId: tokenData.userId,
				conversationId: tokenData.conversationId,
				stage: "pre-tool",
				guardrail: outcome.tripped.guardrail,
				reason: outcome.tripped.reason,
				metadata: outcome.tripped.metadata,
			});
			logger.info(
				{ agentId, toolName, guardrail: outcome.tripped.guardrail },
				"Pre-tool guardrail tripped — blocking tool call with generic policy message",
			);
			return true;
		} catch (err) {
			// Fail open on store/registry-level errors — the runner already
			// fail-opens on per-guardrail throws.
			logger.warn(
				{
					agentId,
					toolName,
					err: getErrorMessage(err),
				},
				"Pre-tool guardrail check failed — proceeding without guardrails",
			);
			return false;
		}
	}

	/**
	 * Shared tool-approval gate used by the REST (`handleCallTool`) and JSON-RPC
	 * (`handleProxyRequest`) call paths. Resolves tool annotations, checks the
	 * grant store, and — if blocked — stores the pending invocation and fires
	 * `onToolBlocked`. Returns:
	 * - `"allow"`: not blocked (no approval needed, or a grant exists);
	 * - `"blocked-notified"`: blocked and the user was asked to approve;
	 * - `"blocked-no-channel"`: blocked but no `onToolBlocked` handler is wired,
	 *   so no approval card could be sent.
	 *
	 * @internal Public only for the route-handler modules.
	 */
	async evaluateToolApproval(
		mcpId: string,
		toolName: string,
		toolArgs: Record<string, unknown>,
		agentId: string,
		tokenData: WorkerTokenData,
		token: string,
	): Promise<"allow" | "blocked-notified" | "blocked-no-channel"> {
		if (!this.grantStore) return "allow";

		const { found, annotations } = await this.getToolAnnotations(
			mcpId,
			toolName,
			agentId,
			tokenData,
			token,
		);
		// Fail closed: when tool annotations can't be fetched (upstream error,
		// SSRF block, timeout, etc.), `found` is false. The previous behaviour
		// returned "allow" here, which let destructive tools bypass approval
		// whenever discovery failed. Require approval unless we have annotations
		// that explicitly say the tool is safe.
		if (found && !requiresToolApproval(annotations)) return "allow";

		const pattern = `/mcp/${mcpId}/tools/${toolName}`;
		if (await this.grantStore.hasGrant(agentId, pattern)) return "allow";

		logger.info("Tool call blocked: requires approval", {
			agentId,
			mcpId,
			toolName,
			pattern,
		});

		if (!this.onToolBlocked) return "blocked-no-channel";
		if (!tokenData.organizationId) {
			logger.error(
				{ agentId, mcpId, toolName },
				"Refusing to store pending MCP tool approval without organizationId",
			);
			return "blocked-no-channel";
		}

		const requestId = `ta_${randomUUID()}`;
		await storePendingTool(
			requestId,
			{
				mcpId,
				toolName,
				args: toolArgs,
				agentId,
				userId: tokenData.userId,
				organizationId: tokenData.organizationId,
				channelId: tokenData.channelId || "",
				conversationId: tokenData.conversationId || "",
				teamId: tokenData.teamId,
				connectionId: tokenData.connectionId,
			},
			this.PENDING_TOOL_TTL,
		).catch((err: unknown) =>
			logger.error(
				{ requestId, error: String(err) },
				"Failed to store pending tool invocation",
			),
		);

		await this.onToolBlocked(
			requestId,
			agentId,
			tokenData.userId,
			mcpId,
			toolName,
			toolArgs,
			pattern,
			tokenData.channelId || "",
			tokenData.conversationId || "",
			tokenData.teamId,
			tokenData.connectionId,
			tokenData.platform,
			tokenData.source,
		).catch((err) =>
			logger.error(
				{ requestId, error: String(err) },
				"onToolBlocked callback failed",
			),
		);

		return "blocked-notified";
	}

	private async getToolAnnotations(
		mcpId: string,
		toolName: string,
		agentId: string,
		tokenData: WorkerTokenData,
		workerToken?: string,
	): Promise<{ found: boolean; annotations?: McpTool["annotations"] }> {
		let tools: McpTool[] | null = null;
		if (this.toolCache) {
			tools = this.toolCache.get(mcpId, agentId);
		}

		if (!tools) {
			// Forward the worker JWT so internal MCPs (lobu-memory) can enumerate
			// tools — without it the discovery call goes unauthenticated and
			// returns an empty list, which would silently bypass the approval gate
			// (`found=false` means "no approval needed" at call sites).
			const result = await this.fetchToolsForMcp(
				mcpId,
				agentId,
				tokenData,
				workerToken,
			);
			tools = result.tools;
		}

		if (tools.length === 0) {
			return { found: false };
		}

		const tool = tools.find((t) => t.name === toolName);
		return { found: true, annotations: tool?.annotations };
	}
}
