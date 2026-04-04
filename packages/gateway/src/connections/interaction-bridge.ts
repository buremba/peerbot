import { createLogger } from "@lobu/core";
import type Redis from "ioredis";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store";
import type {
  InteractionService,
  PostedConfigRequest,
  PostedGrantRequest,
  PostedLinkButton,
  PostedPackageRequest,
  PostedQuestion,
  PostedStatusMessage,
} from "../interactions";
import {
  applyPendingConfigRequest,
  deletePendingConfigRequest,
  getPendingConfigRequest,
} from "../interactions/config-request-store";
import type { GrantStore } from "../permissions/grant-store";
import type { ChatInstanceManager } from "./chat-instance-manager";
import type { PlatformConnection } from "./types";

const logger = createLogger("chat-interaction-bridge");

async function postWithFallback(
  thread: any,
  primary: { card: any; fallbackText: string },
  connectionId: string,
  context: string
): Promise<void> {
  try {
    await thread.post(primary);
  } catch (error) {
    logger.warn(
      { connectionId, error: String(error) },
      `Failed to post ${context}`
    );
    try {
      await thread.post(primary.fallbackText);
    } catch {
      // give up
    }
  }
}

/**
 * Send a message with inline keyboard buttons via the Telegram Bot API.
 * Used for interactive elements (grant/package requests, questions) since
 * the Chat SDK does not support Telegram's inline keyboard natively.
 */
async function sendTelegramInlineKeyboard(
  botToken: string,
  chatId: string,
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>>
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_markup: { inline_keyboard: buttons },
        }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

const GRANT_REQUEST_TTL = 5 * 60_000; // 5 minutes
const GRANT_REQUEST_REDIS_TTL = 300; // 5 minutes in seconds
const GRANT_REQUEST_KEY_PREFIX = "pending-grant:";

async function storePendingGrant(
  redis: Redis,
  grantRequestId: string,
  agentId: string,
  domains: string[]
): Promise<void> {
  const key = `${GRANT_REQUEST_KEY_PREFIX}${grantRequestId}`;
  await redis.set(
    key,
    JSON.stringify({ agentId, domains }),
    "EX",
    GRANT_REQUEST_REDIS_TTL
  );
}

async function getPendingGrant(
  redis: Redis,
  grantRequestId: string
): Promise<{ agentId: string; domains: string[] } | null> {
  const key = `${GRANT_REQUEST_KEY_PREFIX}${grantRequestId}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function deletePendingGrant(
  redis: Redis,
  grantRequestId: string
): Promise<void> {
  await redis.del(`${GRANT_REQUEST_KEY_PREFIX}${grantRequestId}`);
}

export function registerInteractionBridge(
  interactionService: InteractionService,
  manager: ChatInstanceManager,
  connection: PlatformConnection,
  chat: any,
  grantStore?: GrantStore,
  agentSettingsStore?: AgentSettingsStore
): () => void {
  const { id: connectionId, platform } = connection;

  // Per-connection state (avoids cross-contamination between connections)
  const handledEvents = new Set<string>();
  const activeTimers = new Set<NodeJS.Timeout>();
  function markHandled(id: string): void {
    handledEvents.add(id);
    const timer = setTimeout(() => {
      handledEvents.delete(id);
      activeTimers.delete(timer);
    }, 30_000);
    activeTimers.add(timer);
  }
  const pendingQuestionOptions = new Map<string, string[]>();

  const onQuestionCreated = async (event: PostedQuestion) => {
    try {
      if (!shouldHandle(event, platform, connectionId, manager)) return;
      if (handledEvents.has(event.id)) return;
      markHandled(event.id);

      if (platform === "telegram") {
        const botToken = manager.getConnectionConfigSecret(
          connectionId,
          "botToken"
        );
        if (botToken) {
          pendingQuestionOptions.set(event.id, [...event.options]);
          const optionTimer = setTimeout(() => {
            pendingQuestionOptions.delete(event.id);
            activeTimers.delete(optionTimer);
          }, GRANT_REQUEST_TTL);
          activeTimers.add(optionTimer);
          const buttons = event.options.map((option, i) => [
            {
              text: option,
              callback_data: `question:${event.id}:${i}`,
            },
          ]);
          const sent = await sendTelegramInlineKeyboard(
            botToken,
            event.channelId,
            event.question,
            buttons
          );
          if (sent) return;
          logger.warn(
            { connectionId },
            "Telegram inline keyboard failed for question, falling back"
          );
        }
      }

      const thread = await resolveThread(
        manager,
        connectionId,
        event.channelId,
        event.conversationId
      );
      if (!thread) return;

      const { Card, CardText, Actions, Button } = await import("chat");
      const buttons = event.options.map((option, i) =>
        Button({
          id: `question:${event.id}:${i}`,
          label: option,
          value: option,
        })
      );
      const card = Card({
        children: [CardText(event.question), Actions(buttons)],
      });
      const fallbackText = `${event.question}\n${event.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
      await postWithFallback(
        thread,
        { card, fallbackText },
        connectionId,
        "question interaction"
      );
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Unhandled error in question:created handler"
      );
    }
  };

  const redis = manager.getServices().getQueue().getRedisClient();

  const onGrantRequested = async (event: PostedGrantRequest) => {
    try {
      if (!shouldHandle(event, platform, connectionId, manager)) return;
      if (handledEvents.has(event.id)) return;
      markHandled(event.id);

      // Store pending grant in Redis so it survives pod restarts / multi-replica
      try {
        await storePendingGrant(redis, event.id, event.agentId, event.domains);
      } catch (error) {
        logger.error(
          { grantRequestId: event.id, error: String(error) },
          "Failed to store pending grant in Redis"
        );
      }

      const domainList = event.domains.join(", ");
      const text = `Access Request\nDomains: ${domainList}\nReason: ${event.reason}`;

      if (platform === "telegram") {
        const botToken = manager.getConnectionConfigSecret(
          connectionId,
          "botToken"
        );
        if (botToken) {
          const sent = await sendTelegramInlineKeyboard(
            botToken,
            event.channelId,
            text,
            [
              [
                { text: "Approve", callback_data: `grant:${event.id}:approve` },
                { text: "Deny", callback_data: `grant:${event.id}:deny` },
              ],
            ]
          );
          if (sent) return;
          logger.warn(
            { connectionId },
            "Telegram inline keyboard failed for grant, falling back"
          );
        }
      }

      const thread = await resolveThread(
        manager,
        connectionId,
        event.channelId,
        event.conversationId
      );
      if (!thread) return;

      const { Card, CardText, Actions, Button } = await import("chat");
      const card = Card({
        children: [
          CardText(
            `*Access Request*\nDomains: ${domainList}\nReason: ${event.reason}`
          ),
          Actions([
            Button({
              id: `grant:${event.id}:approve`,
              label: "Approve",
              style: "primary",
              value: "approve",
            }),
            Button({
              id: `grant:${event.id}:deny`,
              label: "Deny",
              style: "danger",
              value: "deny",
            }),
          ]),
        ],
      });
      await postWithFallback(
        thread,
        { card, fallbackText: text },
        connectionId,
        "grant interaction with buttons"
      );
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Unhandled error in grant:requested handler"
      );
    }
  };

  const onPackageRequested = async (event: PostedPackageRequest) => {
    try {
      if (!shouldHandle(event, platform, connectionId, manager)) return;
      if (handledEvents.has(event.id)) return;
      markHandled(event.id);

      const pkgList = event.packages.join(", ");
      const text = `Package Install Request\nPackages: ${pkgList}\nReason: ${event.reason}`;

      if (platform === "telegram") {
        const botToken = manager.getConnectionConfigSecret(
          connectionId,
          "botToken"
        );
        if (botToken) {
          const sent = await sendTelegramInlineKeyboard(
            botToken,
            event.channelId,
            text,
            [
              [
                {
                  text: "Approve",
                  callback_data: `package:${event.id}:approve`,
                },
                {
                  text: "Deny",
                  callback_data: `package:${event.id}:deny`,
                },
              ],
            ]
          );
          if (sent) return;
          logger.warn(
            { connectionId },
            "Telegram inline keyboard failed for package request, falling back"
          );
        }
      }

      const thread = await resolveThread(
        manager,
        connectionId,
        event.channelId,
        event.conversationId
      );
      if (!thread) return;

      const { Card, CardText, Actions, Button } = await import("chat");
      const card = Card({
        children: [
          CardText(
            `*Package Install Request*\nPackages: ${pkgList}\nReason: ${event.reason}`
          ),
          Actions([
            Button({
              id: `package:${event.id}:approve`,
              label: "Approve",
              style: "primary",
              value: "approve",
            }),
            Button({
              id: `package:${event.id}:deny`,
              label: "Deny",
              style: "danger",
              value: "deny",
            }),
          ]),
        ],
      });
      await postWithFallback(
        thread,
        { card, fallbackText: text },
        connectionId,
        "package request interaction with buttons"
      );
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Unhandled error in package:requested handler"
      );
    }
  };

  const onConfigRequested = async (event: PostedConfigRequest) => {
    try {
      if (!shouldHandle(event, platform, connectionId, manager)) return;
      if (handledEvents.has(event.id)) return;
      markHandled(event.id);

      if (platform === "telegram") {
        const botToken = manager.getConnectionConfigSecret(
          connectionId,
          "botToken"
        );
        if (botToken) {
          const sent = await sendTelegramInlineKeyboard(
            botToken,
            event.channelId,
            event.text,
            [
              [
                {
                  text: "Approve",
                  callback_data: `config:${event.id}:approve`,
                },
                {
                  text: "Deny",
                  callback_data: `config:${event.id}:deny`,
                },
              ],
            ]
          );
          if (sent) return;
          logger.warn(
            { connectionId },
            "Telegram inline keyboard failed for config request, falling back"
          );
        }
      }

      const thread = await resolveThread(
        manager,
        connectionId,
        event.channelId,
        event.conversationId
      );
      if (!thread) return;

      const { Card, CardText, Actions, Button } = await import("chat");
      const card = Card({
        children: [
          CardText(event.text),
          Actions([
            Button({
              id: `config:${event.id}:approve`,
              label: "Approve",
              style: "primary",
              value: "approve",
            }),
            Button({
              id: `config:${event.id}:deny`,
              label: "Deny",
              style: "danger",
              value: "deny",
            }),
          ]),
        ],
      });
      await postWithFallback(
        thread,
        { card, fallbackText: event.text },
        connectionId,
        "config request interaction with buttons"
      );
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Unhandled error in config:requested handler"
      );
    }
  };

  const onLinkButtonCreated = async (event: PostedLinkButton) => {
    try {
      if (!shouldHandle(event, platform, connectionId, manager)) return;
      if (handledEvents.has(event.id)) return;
      markHandled(event.id);

      const thread = await resolveThread(
        manager,
        connectionId,
        event.channelId,
        event.conversationId
      );
      if (!thread) return;

      const { Card, CardText, Actions, LinkButton } = await import("chat");
      const linkButton = LinkButton({
        url: event.url,
        label: event.label,
      });
      const card = Card({
        children: [CardText(event.label), Actions([linkButton])],
      });
      const fallbackText = `${event.label}: ${event.url}`;
      await postWithFallback(
        thread,
        { card, fallbackText },
        connectionId,
        "link button interaction"
      );
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Unhandled error in link-button:created handler"
      );
    }
  };

  const onStatusMessageCreated = async (event: PostedStatusMessage) => {
    try {
      if (!shouldHandle(event, platform, connectionId, manager)) return;
      if (handledEvents.has(event.id)) return;
      markHandled(event.id);

      const thread = await resolveThread(
        manager,
        connectionId,
        event.channelId,
        event.conversationId
      );
      if (!thread) return;

      try {
        await thread.post(event.text);
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed to post status message interaction"
        );
      }
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Unhandled error in status-message:created handler"
      );
    }
  };

  interactionService.on("question:created", onQuestionCreated);
  interactionService.on("grant:requested", onGrantRequested);
  interactionService.on("package:requested", onPackageRequested);
  interactionService.on("config:requested", onConfigRequested);
  interactionService.on("link-button:created", onLinkButtonCreated);
  interactionService.on("status-message:created", onStatusMessageCreated);

  registerActionHandlers(
    chat,
    connection,
    redis,
    grantStore,
    agentSettingsStore,
    pendingQuestionOptions
  );

  logger.info({ connectionId, platform }, "Interaction bridge registered");

  return () => {
    interactionService.off("question:created", onQuestionCreated);
    interactionService.off("grant:requested", onGrantRequested);
    interactionService.off("package:requested", onPackageRequested);
    interactionService.off("config:requested", onConfigRequested);
    interactionService.off("link-button:created", onLinkButtonCreated);
    interactionService.off("status-message:created", onStatusMessageCreated);
    for (const timer of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.clear();
    handledEvents.clear();
    pendingQuestionOptions.clear();
    logger.info({ connectionId, platform }, "Interaction bridge unregistered");
  };
}

function registerActionHandlers(
  chat: any,
  connection: PlatformConnection,
  redis: Redis,
  grantStore: GrantStore | undefined,
  agentSettingsStore: AgentSettingsStore | undefined,
  pendingQuestionOptions: Map<string, string[]>
): void {
  chat.onAction(async (event: any) => {
    const actionId: string = event.actionId ?? "";
    const value: string = event.value ?? "";
    const thread = event.thread;

    if (!thread || !actionId) return;

    // Handle grant approval/denial — persist to GrantStore before echoing
    if (actionId.startsWith("grant:")) {
      const parts = actionId.split(":");
      const grantRequestId = parts[1];
      const decision = parts[2]; // "approve" or "deny"

      if (grantRequestId && grantStore) {
        try {
          const pending = await getPendingGrant(redis, grantRequestId);
          if (pending) {
            const approved = decision === "approve";
            try {
              for (const domain of pending.domains) {
                await grantStore.grant(
                  pending.agentId,
                  domain,
                  null,
                  !approved
                );
              }
              logger.info(
                {
                  grantRequestId,
                  agentId: pending.agentId,
                  domains: pending.domains,
                  approved,
                },
                "Grant request resolved via button"
              );
            } catch (error) {
              logger.error(
                { grantRequestId, error: String(error) },
                "Failed to persist grant decision"
              );
            }
            await deletePendingGrant(redis, grantRequestId).catch(
              /* best effort */ () => undefined
            );
          } else {
            logger.warn(
              { grantRequestId },
              "No pending grant found in Redis — may have expired"
            );
          }
        } catch (error) {
          logger.error(
            { grantRequestId, error: String(error) },
            "Redis error looking up pending grant"
          );
        }
      }

      // Echo human-readable decision back to thread so the worker receives it
      const responseText = decision === "approve" ? "approve" : "deny";
      try {
        await thread.post(responseText);
      } catch (error) {
        logger.debug(
          { connectionId: connection.id, error: String(error) },
          "Failed to post grant action response"
        );
      }
      return;
    }

    if (actionId.startsWith("config:")) {
      const parts = actionId.split(":");
      const configRequestId = parts[1];
      const decision = parts[2];

      if (configRequestId && decision === "approve" && !agentSettingsStore) {
        try {
          await thread.post("failed to apply requested configuration change");
        } catch {
          // best effort
        }
        return;
      }

      if (configRequestId && decision === "approve" && agentSettingsStore) {
        try {
          const pending = await getPendingConfigRequest(redis, configRequestId);
          if (pending) {
            await applyPendingConfigRequest(
              agentSettingsStore,
              grantStore,
              pending
            );
            await deletePendingConfigRequest(redis, configRequestId).catch(
              () => undefined
            );
            logger.info(
              {
                configRequestId,
                agentId: pending.agentId,
              },
              "Config request resolved via button"
            );
          }
        } catch (error) {
          logger.error(
            { configRequestId, error: String(error) },
            "Failed to apply config request"
          );
          try {
            await thread.post("failed to apply requested configuration change");
          } catch {
            // best effort
          }
          return;
        }
      } else if (configRequestId) {
        await deletePendingConfigRequest(redis, configRequestId).catch(
          () => undefined
        );
      }

      try {
        await thread.post(decision === "approve" ? "approve" : "deny");
      } catch (error) {
        logger.debug(
          { connectionId: connection.id, error: String(error) },
          "Failed to post config action response"
        );
      }
      return;
    }

    // Handle package install approval/denial
    if (actionId.startsWith("package:")) {
      const decision = actionId.split(":")[2] || value || "";
      const responseText = decision || "";
      try {
        await thread.post(responseText);
      } catch (error) {
        logger.debug(
          { connectionId: connection.id, error: String(error) },
          "Failed to post package action response"
        );
      }
      return;
    }

    // Handle question responses
    if (actionId.startsWith("question:")) {
      const [, questionId, optionIndex] = actionId.split(":");
      const optionIdx = Number.parseInt(optionIndex || "", 10);
      const responseText =
        value ||
        (questionId &&
        Number.isFinite(optionIdx) &&
        pendingQuestionOptions.get(questionId)?.[optionIdx]
          ? pendingQuestionOptions.get(questionId)![optionIdx]!
          : optionIndex || "");
      if (questionId) {
        pendingQuestionOptions.delete(questionId);
      }
      try {
        await thread.post(responseText);
      } catch (error) {
        logger.debug(
          { connectionId: connection.id, error: String(error) },
          "Failed to post action response"
        );
      }
    }
  });
}

function shouldHandle(
  event: { teamId?: string; channelId: string; connectionId?: string },
  platform: string,
  connectionId: string,
  manager: ChatInstanceManager
): boolean {
  if (!manager.has(connectionId)) {
    logger.debug(
      { connectionId, eventConnectionId: event.connectionId },
      "shouldHandle: manager does not have connection"
    );
    return false;
  }
  if (event.connectionId && event.connectionId !== connectionId) {
    return false;
  }
  if (event.teamId === "api") {
    logger.debug({ connectionId }, "shouldHandle: skipping api teamId");
    return false;
  }
  const instance = manager.getInstance(connectionId);
  if (!instance) {
    logger.debug({ connectionId }, "shouldHandle: no instance found");
    return false;
  }
  const matches = instance.connection.platform === platform;
  logger.debug({ connectionId, platform, matches }, "shouldHandle: result");
  if (!matches) {
    logger.debug(
      {
        connectionId,
        instancePlatform: instance.connection.platform,
        eventPlatform: platform,
      },
      "shouldHandle: platform mismatch"
    );
  }
  return matches;
}

async function resolveThread(
  manager: ChatInstanceManager,
  connectionId: string,
  channelId: string,
  conversationId: string
): Promise<any | null> {
  const instance = manager.getInstance(connectionId);
  if (!instance) {
    logger.debug({ connectionId }, "resolveThread: no instance for connection");
    return null;
  }

  try {
    const chat = instance.chat;
    const adapterKey = instance.connection.platform;

    // For DMs where conversationId === channelId, use channel directly
    // (matches resolveTarget fallback in chat-response-bridge)
    if (!conversationId || conversationId === channelId) {
      const channel = chat.channel?.(`${adapterKey}:${channelId}`);
      if (channel) return channel;
    }

    const thread = await chat.getThread?.(
      adapterKey,
      channelId,
      conversationId
    );
    if (!thread) {
      logger.debug(
        { connectionId, adapterKey, channelId, conversationId },
        "resolveThread: getThread returned null"
      );
    }
    return thread ?? null;
  } catch (error) {
    logger.debug(
      { connectionId, channelId, conversationId, error: String(error) },
      "Failed to resolve thread for interaction"
    );
    return null;
  }
}
