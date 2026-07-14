import { createLogger } from "@lobu/core";
import {
  gatewayFetch,
  jsonResult,
  postLinkButton,
  withErrorHandling,
  type GatewayParams,
  type TextResult,
} from "@lobu/plugin-toolkit";

const logger = createLogger("plugin-mcp");

export async function startMcpLogin(
  gw: GatewayParams,
  args: { mcpId: string }
): Promise<TextResult> {
  return withErrorHandling(`${args.mcpId}_login`, async () => {
    logger.info(`Start MCP login: ${args.mcpId}`);

    const statusPath = `/internal/device-auth/status?mcpId=${encodeURIComponent(
      args.mcpId
    )}`;
    const statusResult = await gatewayFetch<{ authenticated: boolean }>(
      gw,
      statusPath,
      {},
      `Failed to check auth status for ${args.mcpId}`
    );
    if (statusResult.error) return statusResult.error;

    if (statusResult.data?.authenticated) {
      return jsonResult({
        status: "already_authenticated",
        mcp_id: args.mcpId,
        message: `${args.mcpId} is already authenticated.`,
      });
    }

    const startResult = await gatewayFetch<{
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresIn: number;
    }>(
      gw,
      "/internal/device-auth/start",
      {
        method: "POST",
        body: JSON.stringify({ mcpId: args.mcpId }),
      },
      `Failed to start login for ${args.mcpId}`
    );
    if (startResult.error) return startResult.error;

    const verificationUrl =
      startResult.data?.verificationUriComplete ||
      startResult.data?.verificationUri;
    if (verificationUrl) {
      await postLinkButton(gw, {
        url: verificationUrl,
        label: `Connect ${args.mcpId}`,
        linkType: "oauth",
        body: `Sign in to ${args.mcpId} so I can use its tools on your behalf.`,
      });
    }

    return jsonResult({
      status: "login_started",
      mcp_id: args.mcpId,
      verification_url: verificationUrl,
      verification_uri: startResult.data?.verificationUri,
      user_code: startResult.data?.userCode,
      expires_in_seconds: startResult.data?.expiresIn,
      interaction_posted: Boolean(verificationUrl),
      message: verificationUrl
        ? `Authentication required for ${args.mcpId}. The login link has been sent directly to the user. Do not repeat the URL unless they ask.`
        : `Authentication required for ${args.mcpId}. Show the user the verification URL and code, then wait for them to finish login.`,
    });
  });
}

export async function checkMcpLogin(
  gw: GatewayParams,
  args: { mcpId: string },
  onAuthChanged: () => void
): Promise<TextResult> {
  return withErrorHandling(`${args.mcpId}_login_check`, async () => {
    logger.info(`Check MCP login: ${args.mcpId}`);

    const statusPath = `/internal/device-auth/status?mcpId=${encodeURIComponent(
      args.mcpId
    )}`;
    const statusResult = await gatewayFetch<{ authenticated: boolean }>(
      gw,
      statusPath,
      {},
      `Failed to check auth status for ${args.mcpId}`
    );
    if (statusResult.error) return statusResult.error;

    if (statusResult.data?.authenticated) {
      onAuthChanged();
      return jsonResult({
        status: "already_authenticated",
        mcp_id: args.mcpId,
        authenticated: true,
        refreshed_session_context: true,
        message: `${args.mcpId} is already authenticated. Newly available MCP tools will be refreshed for the next message.`,
      });
    }

    const pollResult = await gatewayFetch<{
      status: "pending" | "complete" | "error";
      message?: string;
    }>(
      gw,
      "/internal/device-auth/poll",
      {
        method: "POST",
        body: JSON.stringify({ mcpId: args.mcpId }),
      },
      `Failed to check login progress for ${args.mcpId}`
    );
    if (pollResult.error) return pollResult.error;

    const pollStatus = pollResult.data?.status || "error";
    if (pollStatus === "complete") {
      onAuthChanged();
      return jsonResult({
        status: "complete",
        mcp_id: args.mcpId,
        authenticated: true,
        refreshed_session_context: true,
        message: `${args.mcpId} authentication completed successfully. Newly available MCP tools will be refreshed for the next message.`,
      });
    }

    if (pollStatus === "pending") {
      return jsonResult({
        status: "pending",
        mcp_id: args.mcpId,
        authenticated: false,
        message: `Authentication for ${args.mcpId} is still pending. Wait for the user to complete login in their browser.`,
      });
    }

    return jsonResult({
      status: "error",
      mcp_id: args.mcpId,
      authenticated: false,
      message:
        pollResult.data?.message ||
        `Authentication for ${args.mcpId} failed or expired.`,
    });
  });
}

export async function logoutMcp(
  gw: GatewayParams,
  args: { mcpId: string }
): Promise<TextResult> {
  return withErrorHandling(`${args.mcpId}_logout`, async () => {
    logger.info(`Logout MCP: ${args.mcpId}`);

    const { data, error } = await gatewayFetch<{ success: boolean }>(
      gw,
      `/internal/device-auth/credential?mcpId=${encodeURIComponent(args.mcpId)}`,
      { method: "DELETE" },
      `Failed to log out from ${args.mcpId}`
    );
    if (error) return error;

    return jsonResult({
      status: data?.success ? "logged_out" : "already_logged_out",
      mcp_id: args.mcpId,
      authenticated: false,
      message: data?.success
        ? `${args.mcpId} has been logged out.`
        : `${args.mcpId} was not logged in.`,
    });
  });
}
