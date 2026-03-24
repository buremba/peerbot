import { createLogger } from "@lobu/core";
import type Redis from "ioredis";
import type {
  InteractionService,
  PostedGrantRequest,
  PostedLinkButton,
  PostedPackageRequest,
  PostedQuestion,
  PostedStatusMessage,
} from "../interactions";
import type { GrantStore } from "../permissions/grant-store";
import type { ChatInstanceManager } from "./chat-instance-manager";
import type { PlatformConnection } from "./types";

const logger = createLogger("chat-interaction-bridge");

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

// Deduplicate events across multiple connections for the same platform
const handledEvents = new Set<string>();
function markHandled(id: string): void {
  handledEvents.add(id);
  setTimeout(() => handledEvents.delete(id), 30_000);
}

const pendingQuestionOptions = new Map<string, string[]>();

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
  grantStore?: GrantStore
): void {
  const { id: connectionId, platform } = connection;

  interactionService.on("question:created", async (event: PostedQuestion) => {
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
        setTimeout(
          () => pendingQuestionOptions.delete(event.id),
          GRANT_REQUEST_TTL
        );
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

    try {
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
      await thread.post({
        card,
        fallbackText: `${event.question}\n${event.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`,
      });
    } catch (error) {
      logger.warn(
        { connectionId, error: String(error) },
        "Failed to post question interaction"
      );
      try {
        const fallback = `${event.question}\n${event.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
        await thread.post(fallback);
      } catch {
        // give up
      }
    }
  });

  const redis = manager.getServices().getQueue().getRedisClient();

  interactionService.on(
    "grant:requested",
    async (event: PostedGrantRequest) => {
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

      try {
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
        await thread.post({
          card,
          fallbackText: text,
        });
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed to post grant interaction with buttons"
        );
        try {
          await thread.post(text);
        } catch {
          // give up
        }
      }
    }
  );

  interactionService.on(
    "package:requested",
    async (event: PostedPackageRequest) => {
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

      try {
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
        await thread.post({
          card,
          fallbackText: text,
        });
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed to post package request interaction with buttons"
        );
        try {
          await thread.post(text);
        } catch {
          // give up
        }
      }
    }
  );

  interactionService.on(
    "link-button:created",
    async (event: PostedLinkButton) => {
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
        const { Card, CardText, Actions, LinkButton } = await import("chat");
        const linkButton: any = LinkButton({
          url: event.url,
          label: event.label,
        });
        if (event.webApp) {
          linkButton.webApp = true;
        }
        const card = Card({
          children: [CardText(event.label), Actions([linkButton])],
        });
        await thread.post({
          card,
          fallbackText: `${event.label}: ${event.url}`,
        });
      } catch (error) {
        logger.warn(
          { connectionId, error: String(error) },
          "Failed to post link button interaction"
        );
        try {
          await thread.post(`${event.label}: ${event.url}`);
        } catch {
          // give up
        }
      }
    }
  );

  interactionService.on(
    "status-message:created",
    async (event: PostedStatusMessage) => {
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
    }
  );

  registerActionHandlers(chat, connection, redis, grantStore);

  logger.info({ connectionId, platform }, "Interaction bridge registered");
}

function registerActionHandlers(
  chat: any,
  connection: PlatformConnection,
  redis: Redis,
  grantStore?: GrantStore
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
