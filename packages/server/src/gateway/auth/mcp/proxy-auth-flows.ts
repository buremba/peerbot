import {
	createLogger,
	getErrorMessage,
	type WorkerTokenData,
} from "@lobu/core";
import { startDeviceAuth } from "../../routes/internal/device-auth.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import { startAuthCodeFlow } from "./oauth-flow.js";
import {
	runWithOrganizationContext,
	type AuthRequiredPayload,
	type HttpMcpServerConfig,
	type McpConfigSource,
} from "./proxy-shared.js";

const logger = createLogger("mcp-proxy");

/** Callback invoked when an MCP auth flow is started or already pending. */
export type OnAuthRequiredHandler = (
	agentId: string,
	userId: string,
	mcpId: string,
	payload: {
		status: "login_required" | "pending";
		url?: string;
		userCode?: string;
		message: string;
	},
	channelId: string,
	conversationId: string,
	teamId: string | undefined,
	connectionId: string | undefined,
	platform: string | undefined,
	source: string | undefined,
) => Promise<void>;

/**
 * Auth-flow side of the MCP proxy: reacts to upstream 401s / auth errors by
 * starting the OAuth 2.1 auth-code flow (with optional device-code fallback)
 * and surfacing the login link to the user via `onAuthRequired`.
 */
export class McpAuthFlows {
	/** Callback invoked when an MCP auth flow is started or already pending. */
	public onAuthRequired?: OnAuthRequiredHandler;

	constructor(
		private readonly configService: McpConfigSource,
		private readonly secretStore: WritableSecretStore,
		/** Absolute gateway URL for OAuth redirect_uri construction. */
		private readonly publicGatewayUrl?: string,
	) {}

	/**
	 * Handle an HTTP 401 from an MCP upstream: drain the response body, attempt
	 * the OAuth 2.1 auth-code flow (RFC 9728 → 8414 → 7591 discovery), and —
	 * when `deviceAuthFallback` is set — fall back to device-code auth. Fires
	 * `onAuthRequired` with whichever payload succeeds and returns it (or null
	 * when no flow could be started).
	 */
	async handleUpstream401(params: {
		response?: Response;
		mcpId: string;
		agentId: string;
		userId: string;
		organizationId?: string;
		scopeKey: string;
		httpServer: HttpMcpServerConfig;
		wwwAuthenticate: string | null;
		platform?: string;
		channelId: string;
		conversationId: string;
		teamId?: string;
		connectionId?: string;
		source?: string;
		deviceAuthFallback: boolean;
	}): Promise<AuthRequiredPayload | null> {
		// Drain the body so the connection can be reused.
		await params.response?.body?.cancel().catch(() => {
			/* noop */
		});

		const fire = async (payload: AuthRequiredPayload) => {
			await this.fireAuthRequired(
				params.agentId,
				params.userId,
				params.mcpId,
				payload,
				params.channelId,
				params.conversationId,
				params.teamId,
				params.connectionId,
				params.platform,
				params.source,
			);
			return payload;
		};

		const authCodeResult = await this.tryAutoAuthCodeFlow({
			mcpId: params.mcpId,
			agentId: params.agentId,
			userId: params.userId,
			organizationId: params.organizationId,
			scopeKey: params.scopeKey,
			httpServer: params.httpServer,
			wwwAuthenticate: params.wwwAuthenticate,
			platform: params.platform ?? "",
			channelId: params.channelId,
			conversationId: params.conversationId,
			teamId: params.teamId,
			connectionId: params.connectionId,
		});
		if (authCodeResult) return fire(authCodeResult);

		if (params.deviceAuthFallback) {
			const deviceAuth = await this.tryAutoDeviceAuth(
				params.mcpId,
				params.agentId,
				params.scopeKey,
				params.organizationId,
			);
			if (deviceAuth) return fire(deviceAuth);
		}

		return null;
	}

	/** Invoke `onAuthRequired` (if wired), swallowing/logging callback errors. */
	async fireAuthRequired(
		agentId: string,
		userId: string,
		mcpId: string,
		payload: AuthRequiredPayload,
		channelId: string,
		conversationId: string,
		teamId: string | undefined,
		connectionId: string | undefined,
		platform: string | undefined,
		source: string | undefined,
	): Promise<void> {
		if (!this.onAuthRequired) return;
		await this.onAuthRequired(
			agentId,
			userId,
			mcpId,
			payload,
			channelId,
			conversationId,
			teamId,
			connectionId,
			platform,
			source,
		).catch((err) =>
			logger.error(
				{ mcpId, error: String(err) },
				"onAuthRequired callback failed",
			),
		);
	}

	/**
	 * Shared helper: on 401 during tool discovery, start the OAuth auth-code
	 * flow and surface the "Connect X" link to the user via onAuthRequired.
	 * Silently noops on failure — caller already degrades to `{ tools: [] }`.
	 */
	async fireAuthCodeFlowFromDiscovery(params: {
		mcpId: string;
		agentId: string;
		httpServer: HttpMcpServerConfig;
		wwwAuthenticate: string | null;
		scopeKey: string;
		tokenData: WorkerTokenData;
	}): Promise<void> {
		const { mcpId, agentId, httpServer, wwwAuthenticate, scopeKey, tokenData } =
			params;
		await this.handleUpstream401({
			mcpId,
			agentId,
			userId: tokenData?.userId || scopeKey,
			organizationId: tokenData?.organizationId,
			scopeKey,
			httpServer,
			wwwAuthenticate,
			platform: tokenData?.platform,
			channelId: tokenData?.channelId || "",
			conversationId: tokenData?.conversationId || "",
			teamId: tokenData?.teamId,
			connectionId: tokenData?.connectionId,
			deviceAuthFallback: false,
		});
	}

	/**
	 * Auto-start MCP OAuth 2.1 authorization-code + PKCE flow when an upstream
	 * returns 401. Uses WWW-Authenticate header to walk the RFC 9728 → 8414 →
	 * 7591 discovery chain. Returns a payload for `onAuthRequired`, or null on
	 * failure (caller should fall back to device-auth).
	 */
	private async tryAutoAuthCodeFlow(params: {
		mcpId: string;
		agentId: string;
		userId: string;
		organizationId?: string;
		scopeKey: string;
		httpServer: HttpMcpServerConfig;
		wwwAuthenticate: string | null;
		platform: string;
		channelId: string;
		conversationId: string;
		teamId?: string;
		connectionId?: string;
	}): Promise<{
		status: "login_required";
		url: string;
		message: string;
	} | null> {
		if (!this.publicGatewayUrl) {
			logger.warn("Auth-code flow skipped: publicGatewayUrl not configured", {
				mcpId: params.mcpId,
			});
			return null;
		}
		if (!params.organizationId) {
			logger.warn(
				"Auth-code flow skipped: worker token has no organizationId",
				{
					mcpId: params.mcpId,
					agentId: params.agentId,
				},
			);
			return null;
		}

		try {
			const redirectUri = `${this.publicGatewayUrl.replace(/\/+$/, "")}/mcp/oauth/callback`;
			const { authorizationUrl } = await startAuthCodeFlow({
				secretStore: this.secretStore,
				mcpId: params.mcpId,
				upstreamUrl: params.httpServer.upstreamUrl,
				agentId: params.agentId,
				userId: params.userId,
				organizationId: params.organizationId,
				scopeKey: params.scopeKey,
				wwwAuthenticate: params.wwwAuthenticate,
				redirectUri,
				staticOauth: params.httpServer.oauth,
				platform: params.platform,
				channelId: params.channelId,
				conversationId: params.conversationId,
				teamId: params.teamId,
				connectionId: params.connectionId,
			});
			return {
				status: "login_required",
				url: authorizationUrl,
				message:
					"Authentication is required. STOP calling tools and show the user this login link. Do NOT retry this tool call — wait for the user to complete login in their browser first.",
			};
		} catch (error) {
			logger.warn("Auto auth-code flow failed", {
				mcpId: params.mcpId,
				error: getErrorMessage(error),
			});
			return null;
		}
	}

	/**
	 * Auto-start device-code auth when an MCP upstream returns an auth error.
	 * Returns a user-facing message with the verification URL, or null on failure.
	 */
	async tryAutoDeviceAuth(
		mcpId: string,
		agentId: string,
		scopeKey: string,
		organizationId?: string,
	): Promise<AuthRequiredPayload | null> {
		if (!organizationId) {
			logger.warn("Device-auth flow skipped: worker token has no organizationId", {
				mcpId,
				agentId,
			});
			return null;
		}

		return runWithOrganizationContext(organizationId, () =>
			this.tryAutoDeviceAuthScoped(mcpId, agentId, scopeKey),
		);
	}

	private async tryAutoDeviceAuthScoped(
		mcpId: string,
		agentId: string,
		scopeKey: string,
	): Promise<AuthRequiredPayload | null> {
		try {
			// Existing-flow detection now happens inside startDeviceAuth — it
			// reuses any non-expired pending flow already persisted in the secret
			// store and returns it instead of restarting.
			const result = await startDeviceAuth(
				this.secretStore,
				this.configService,
				mcpId,
				agentId,
				scopeKey,
			);
			if (!result) return null;
			const url = result.verificationUriComplete || result.verificationUri;
			return {
				status: "login_required",
				url,
				userCode: result.userCode,
				message:
					"Authentication is required. STOP calling tools and show the user this login link and code. Do NOT retry this tool call — wait for the user to complete login first.",
				expiresInSeconds: result.expiresIn,
			};
		} catch (error) {
			logger.warn("Auto device-auth failed", {
				mcpId,
				error: getErrorMessage(error),
			});
			return null;
		}
	}
}
