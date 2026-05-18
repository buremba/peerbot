/**
 * Post-OAuth resume prompt — re-engages the agent after the user completes
 * an MCP login (auth-code callback today, device-code completion in future).
 *
 * The 401 that kicked off the OAuth flow was returned to the worker as a tool
 * result with `status: "login_required"`; the agent then told the user to
 * click the link and the worker session went idle. When the provider callback
 * (or poll completion) lands, we inject a synthetic follow-up message into
 * the same thread so the agent proactively retries the original request
 * instead of waiting for the user to type again.
 */

import { randomUUID } from "node:crypto";
import { createLogger, generateTraceId } from "@lobu/core";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";
import type { CoreServices } from "../../platform.js";
import {
  buildMessagePayload,
  resolveAgentOptions,
} from "../../services/platform-helpers.js";

const logger = createLogger("mcp-oauth-resume");

interface PostOAuthCompletionParams {
  coreServices: CoreServices;
  /** Optional — used to pull conversation history for the worker payload. */
  chatInstanceManager?: ChatInstanceManager;
  agentId: string;
  platform: string;
  userId: string;
  channelId: string;
  conversationId: string;
  teamId?: string;
  connectionId?: string;
  mcpId: string;
  /** Space-separated scopes granted (or requested) by the provider. */
  scope?: string;
}

/**
 * Enqueue a follow-up message as if the user had typed it, so the worker
 * resumes from where the original tool call bailed out on 401.
 */
export async function postOAuthCompletionPrompt(
  params: PostOAuthCompletionParams
): Promise<void> {
  const {
    coreServices,
    chatInstanceManager,
    agentId,
    platform,
    userId,
    channelId,
    conversationId,
    teamId,
    connectionId,
    mcpId,
    scope,
  } = params;

  const agentSettingsStore = coreServices.getAgentSettingsStore();
  const agentOptions = await resolveAgentOptions(
    agentId,
    {},
    agentSettingsStore
  );

  // Re-fetch conversation history so the worker session can warm-start with
  // full context even if it got evicted since the 401 was returned.
  const instance = connectionId
    ? chatInstanceManager?.getInstance(connectionId)
    : undefined;
  const conversationState = instance?.conversationState;
  const conversationHistory =
    connectionId && conversationState
      ? await conversationState
          .getHistory(connectionId, channelId)
          .catch(() => [])
      : [];
  // Derive the connection's owning org so the enqueued resume run carries
  // organization_id — verifier in transcript-routes.ts denies snapshots on
  // NULL org. Falls through to undefined if the connection isn't currently
  // tracked (legacy / cross-pod), in which case the resume run lands NULL
  // and its snapshot is denied; the user can re-send manually.
  const organizationId = instance?.connection.organizationId ?? undefined;

  const scopeSuffix = scope ? ` (granted scopes: ${scope})` : "";
  const messageText =
    `[System] Authentication for "${mcpId}" completed successfully${scopeSuffix}. ` +
    `Retry the user's previous request that required ${mcpId} and report the result — do not ask for confirmation first.`;

  const messageId = randomUUID();
  const traceId = generateTraceId(messageId);

  const payload = buildMessagePayload({
    platform,
    userId,
    botId: platform,
    conversationId: conversationId || channelId,
    teamId: teamId ?? platform,
    agentId,
    organizationId,
    messageId,
    messageText,
    channelId,
    platformMetadata: {
      traceId,
      agentId,
      chatId: channelId,
      senderId: userId,
      isGroup: !!teamId,
      connectionId,
      responseChannel: channelId,
      responseId: messageId,
      responseThreadId: conversationId
        ? `${platform}:${channelId}:${conversationId}`
        : undefined,
      conversationHistory:
        conversationHistory.length > 0 ? conversationHistory : undefined,
      teamId,
      source: "mcp-oauth-resume",
    },
    agentOptions,
  });

  await coreServices.getQueueProducer().enqueueMessage(payload);

  logger.info("Enqueued MCP OAuth resume prompt", {
    agentId,
    mcpId,
    platform,
    channelId,
    conversationId,
    hasHistory: conversationHistory.length > 0,
  });
}
