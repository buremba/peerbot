import { createLogger } from "@lobu/core";
import {
  takePendingTool,
  type PendingToolInvocation,
} from "../auth/mcp/pending-tool-store.js";
import type {
  InteractionService,
  PostedLinkButton,
  PostedQuestion,
  PostedStatusMessage,
  PostedToolApproval,
} from "../interactions.js";
import type { GrantStore } from "../permissions/grant-store.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import type { PlatformConnection } from "./types.js";

const logger = createLogger("chat-interaction-bridge");

/** Signature for the direct tool execution function injected from the MCP proxy. */
type ExecuteToolDirectFn = (
  agentId: string,
  userId: string,
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}>;

/**
 * SentMessage returned by thread.post — we care about .edit() for updating cards
 * after a button click to remove the now-stale action buttons. Typed as `any`
 * because the chat SDK's full type surface isn't imported here.
 */
type SentMessage = { edit: (newContent: any) => Promise<unknown> };

async function postWithFallback(
  thread: any,
  primary: { card: any; fallbackText: string },
  connectionId: string,
  context: string
): Promise<SentMessage | null> {
  try {
    return (await thread.post(primary)) as SentMessage;
  } catch (error) {
    logger.warn(
      { connectionId, error: String(error) },
      `Failed to post ${context}`
    );
    try {
      return (await thread.post(primary.fallbackText)) as SentMessage;
    } catch {
      return null;
    }
  }
}

function resolveGrantExpiresAt(duration: string): number | null {
  switch (duration) {
    case "1h":
      return Date.now() + 3_600_000;
    case "24h":
      return Date.now() + 86_400_000;
    case "always":
      return null;
    default:
      return null;
  }
}

/**
 * Atomically fetch and delete the pending invocation. The PG-backed
 * `pending-tool` row uses DELETE ... RETURNING so the first click claims
 * the payload and subsequent webhook retries see null and no-op.
 */
async function takePendingToolInvocation(
  requestId: string
): Promise<PendingToolInvocation | null> {
  return takePendingTool(requestId);
}

function describeDecision(decision: string): string {
  switch (decision) {
    case "1h":
      return "Approved (1h)";
    case "24h":
      return "Approved (24h)";
    case "always":
      return "Approved (always)";
    case "deny":
      return "Denied";
    default:
      return `Decision: ${decision}`;
  }
}

/**
 * Replace the approval card's buttons with a plain-text decision summary.
 * Best-effort: silently swallows edit failures (the card may be unreachable
 * after a long gap, or the platform may not support edits).
 */
async function stripApprovalButtons(
  sent: SentMessage | undefined,
  pending: {
    mcpId: string;
    toolName: string;
    args: Record<string, unknown>;
  },
  decision: string
): Promise<void> {
  if (!sent) return;
  const summary =
    `*Tool Approval*\n${pending.mcpId} → ${pending.toolName}\n` +
    `${formatToolArgs(pending.args)}\n\n_${describeDecision(decision)}_`;
  try {
    await sent.edit(summary);
  } catch {
    // best effort — card may be stale, edit may be unsupported
  }
}

function formatToolArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `  ${k}: ${val}`;
    })
    .join("\n");
}

/** Context tracked per posted question so the click handler can feed the
 *  clicked value back into the worker with the same routing as the original
 *  message (userId/conversationId/channelId/teamId). Also holds the SentMessage
 *  for the card so buttons can be stripped after a click. */
interface PendingQuestionEntry {
  question: PostedQuestion;
  sent?: SentMessage;
}

export function registerInteractionBridge(
  interactionService: InteractionService,
  manager: ChatInstanceManager,
  connection: PlatformConnection,
  chat: any,
  grantStore?: GrantStore,
  executeToolDirect?: ExecuteToolDirectFn
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

  // Tracks posted tool-approval cards so we can edit them on click to strip
  // the buttons. Keyed by requestId (== PostedToolApproval.id == pending-tool
  // store key). Auto-expire window matches the pending-tool TTL (24h) so a
  // late click can still find the card to strip.
  const APPROVAL_CARD_TTL_MS = 24 * 60 * 60 * 1000;
  const pendingApprovalCards = new Map<string, SentMessage>();
  const pendingApprovalTimers = new Map<string, NodeJS.Timeout>();
  function trackApprovalCard(requestId: string, sent: SentMessage): void {
    pendingApprovalCards.set(requestId, sent);
    const timer = setTimeout(() => {
      pendingApprovalCards.delete(requestId);
      pendingApprovalTimers.delete(requestId);
    }, APPROVAL_CARD_TTL_MS);
    pendingApprovalTimers.set(requestId, timer);
  }
  function claimApprovalCard(requestId: string): SentMessage | undefined {
    const sent = pendingApprovalCards.get(requestId);
    pendingApprovalCards.delete(requestId);
    const timer = pendingApprovalTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      pendingApprovalTimers.delete(requestId);
    }
    return sent;
  }

  // Tracks posted question cards + their original routing context so a click
  // can (a) strip the buttons via SentMessage.edit and (b) feed the clicked
  // value back through the inbound-enqueue pipeline.
  const pendingQuestions = new Map<string, PendingQuestionEntry>();
  const pendingQuestionTimers = new Map<string, NodeJS.Timeout>();
  function trackQuestion(entry: PendingQuestionEntry): void {
    pendingQuestions.set(entry.question.id, entry);
    const timer = setTimeout(() => {
      pendingQuestions.delete(entry.question.id);
      pendingQuestionTimers.delete(entry.question.id);
    }, 300_000);
    pendingQuestionTimers.set(entry.question.id, timer);
  }
  function claimQuestion(questionId: string): PendingQuestionEntry | undefined {
    const entry = pendingQuestions.get(questionId);
    pendingQuestions.delete(questionId);
    const timer = pendingQuestionTimers.get(questionId);
    if (timer) {
      clearTimeout(timer);
      pendingQuestionTimers.delete(questionId);
    }
    return entry;
  }
  /**
   * Put a previously-claimed entry back. Used when a click is rejected
   * (e.g. wrong user) so the rightful owner can still answer later.
   */
  function restashQuestion(
    questionId: string,
    entry: PendingQuestionEntry
  ): void {
    if (pendingQuestions.has(questionId)) return;
    trackQuestion(entry);
    if (entry.question.id !== questionId) {
      pendingQuestions.delete(entry.question.id);
      pendingQuestions.set(questionId, entry);
    }
  }
  const onQuestionCreated = async (event: PostedQuestion) => {
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
      const sent = await postWithFallback(
        thread,
        { card, fallbackText },
        connectionId,
        "question interaction"
      );
      trackQuestion({ question: event, sent: sent ?? undefined });
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Unhandled error in question:created handler"
      );
    }
  };

  const onToolApprovalNeeded = async (event: PostedToolApproval) => {
    try {
      if (!shouldHandle(event, platform, connectionId, manager)) return;
      if (handledEvents.has(event.id)) return;
      markHandled(event.id);

      const argsText = formatToolArgs(event.args);
      const text = `Tool Approval\n${event.mcpId} → ${event.toolName}\n${argsText}`;
      const tid = event.id;

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
            `*Tool Approval*\n${event.mcpId} → ${event.toolName}\n${argsText}`
          ),
          Actions([
            Button({
              id: `tool:${tid}:1h`,
              label: "Allow 1h",
              style: "primary",
              value: "1h",
            }),
            Button({
              id: `tool:${tid}:24h`,
              label: "Allow 24h",
              style: "primary",
              value: "24h",
            }),
            Button({
              id: `tool:${tid}:always`,
              label: "Allow always",
              style: "primary",
              value: "always",
            }),
            Button({
              id: `tool:${tid}:deny`,
              label: "Deny always",
              style: "danger",
              value: "deny",
            }),
          ]),
        ],
      });
      const sent = await postWithFallback(
        thread,
        { card, fallbackText: text },
        connectionId,
        "tool approval interaction"
      );
      if (sent) {
        trackApprovalCard(tid, sent);
      }
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Unhandled error in tool:approval-needed handler"
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
      // The button itself carries the label — only render an extra line of
      // card-body text when the caller supplied a distinct `body` explaining
      // *why* (e.g. for OAuth, "Authorize {mcp} to continue."). Falling back
      // to `label` again would produce the "Connect sentry / [Connect sentry]"
      // duplication we saw in Slack.
      const bodyText = event.body?.trim();
      const cardChildren =
        bodyText && bodyText !== event.label
          ? [CardText(bodyText), Actions([linkButton])]
          : [Actions([linkButton])];
      const card = Card({ children: cardChildren });
      const fallbackText = bodyText
        ? `${bodyText} ${event.label}: ${event.url}`
        : `${event.label}: ${event.url}`;
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
  interactionService.on("tool:approval-needed", onToolApprovalNeeded);
  interactionService.on("link-button:created", onLinkButtonCreated);
  interactionService.on("status-message:created", onStatusMessageCreated);

  registerActionHandlers(
    chat,
    connection,
    grantStore,
    executeToolDirect,
    claimApprovalCard,
    async (questionId, value, thread, author) => {
      // Fast path — Slack's block_actions webhook requires a <3s response.
      // Claim synchronously (Map.delete), then fire-and-forget the slow
      // platform API calls (post receipt, edit card, enqueue worker turn).
      const entry = claimQuestion(questionId);
      if (!entry) {
        logger.debug(
          { connectionId, questionId },
          "Question click with no pending entry — ignoring"
        );
        return;
      }

      const instance = manager.getInstance(connectionId);
      if (!instance) {
        logger.warn(
          { connectionId },
          "Question click: no instance for connection"
        );
        return;
      }

      const { question } = entry;

      // Only the user who was originally asked may answer. Without this,
      // anyone in a Slack/Telegram channel could click another user's
      // approval/question buttons and silently impersonate them. Re-stash
      // the entry so the rightful owner can still click later.
      if (
        author?.userId &&
        question.userId &&
        author.userId !== question.userId
      ) {
        logger.warn(
          {
            connectionId,
            questionId,
            clickerUserId: author.userId,
            originalUserId: question.userId,
          },
          "Question click ignored: clicker is not the original requester"
        );
        restashQuestion(questionId, entry);
        return;
      }
      const receiptText = value
        ? `*You submitted:* ${value}`
        : "*You submitted a response.*";

      void (async () => {
        // Visible "user submitted X" receipt so the click is acknowledged
        // in-thread even before the worker responds.
        try {
          const { Card, CardText } = await import("chat");
          const card = Card({ children: [CardText(receiptText)] });
          await thread
            .post({ card, fallbackText: receiptText })
            .catch(async () => {
              await thread.post(receiptText);
            });
        } catch {
          try {
            await thread.post(receiptText);
          } catch {
            // best effort — even the plain-text fallback failed
          }
        }

        // Strip the original card's buttons so it can't be clicked again.
        if (entry.sent) {
          try {
            await entry.sent.edit(
              `${question.question}\n\n_Answered: ${value}_`
            );
          } catch {
            // best effort — card may be stale or un-editable
          }
        }

        // MUST route with question.userId (the original message's user), not
        // author.userId (who physically clicked). The worker session is keyed
        // on the original userId and will reject SSE deliveries that don't match.
        await instance.messageBridge.ingestClick({
          userId: question.userId,
          channelId: question.channelId,
          conversationId: question.conversationId,
          teamId: question.teamId,
          authorName: author?.fullName,
          authorUsername: author?.userName,
          value,
          thread,
          responseThreadId:
            typeof thread?.id === "string" ? thread.id : undefined,
        });
      })().catch((error) => {
        logger.error(
          { connectionId, questionId, error: String(error) },
          "Background question-click processing failed"
        );
      });
    },
    async (channelId, conversationId) =>
      resolveThread(manager, connectionId, channelId, conversationId)
  );

  logger.info({ connectionId, platform }, "Interaction bridge registered");

  return () => {
    interactionService.off("question:created", onQuestionCreated);
    interactionService.off("tool:approval-needed", onToolApprovalNeeded);
    interactionService.off("link-button:created", onLinkButtonCreated);
    interactionService.off("status-message:created", onStatusMessageCreated);
    for (const timer of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.clear();
    handledEvents.clear();
    for (const timer of pendingApprovalTimers.values()) {
      clearTimeout(timer);
    }
    pendingApprovalTimers.clear();
    pendingApprovalCards.clear();
    for (const timer of pendingQuestionTimers.values()) {
      clearTimeout(timer);
    }
    pendingQuestionTimers.clear();
    pendingQuestions.clear();
    logger.info({ connectionId, platform }, "Interaction bridge unregistered");
  };
}

/**
 * Callback invoked when a user clicks a `question:*` button. The interaction
 * bridge owns pending-question tracking, receipt-card rendering, and the
 * enqueue-into-worker pipeline; `registerActionHandlers` just dispatches
 * the raw click through.
 */
type OnQuestionClickFn = (
  questionId: string,
  value: string,
  thread: any,
  author: { userId?: string; userName?: string; fullName?: string } | undefined
) => Promise<void>;

/**
 * Exported for testing. Wires chat.onAction to tool-approval and question flows.
 *
 * `claimApprovalCard` (optional) returns the SentMessage for a given
 * requestId if one was tracked by this bridge, and atomically removes it
 * from tracking. Used to edit the card after a click so the buttons go
 * away. Absent in tests.
 *
 * `onQuestionClick` (optional) handles the `question:*` click path. Absent
 * in tests that only exercise tool-approval flows.
 */
export function registerActionHandlers(
  chat: any,
  connection: PlatformConnection,
  grantStore: GrantStore | undefined,
  executeToolDirect?: ExecuteToolDirectFn,
  claimApprovalCard?: (requestId: string) => SentMessage | undefined,
  onQuestionClick?: OnQuestionClickFn,
  resolveApprovalTarget?: (
    channelId: string,
    conversationId: string
  ) => Promise<any | null>
): void {
  chat.onAction(async (event: any) => {
    const actionId: string = event.actionId ?? "";
    const value: string = event.value ?? "";
    const thread = event.thread;

    if (!thread || !actionId) return;

    // Handle tool approval — store grant, execute tool, post result
    if (actionId.startsWith("tool:")) {
      const parts = actionId.split(":");
      const requestId = parts[1];
      const decision = parts[2] ?? "deny";

      if (!requestId) return;

      // GETDEL atomically claims the pending invocation. On Slack retries of
      // the same block_actions webhook the second GETDEL returns null and we
      // silently no-op (the first click already won). But if the card was
      // never claimed before — i.e. the in-memory approval card is still
      // tracked — this is a real first click landing on an expired/missing
      // pending key, and we MUST surface that to the user. Otherwise the
      // click looks like it did nothing.
      const pending = await takePendingToolInvocation(requestId).catch(
        () => null
      );
      if (!pending) {
        const sent = claimApprovalCard?.(requestId);
        if (sent) {
          logger.info(
            { requestId, decision },
            "Tool approval click with no pending invocation — likely expired"
          );
          try {
            await sent.edit(
              "*Tool Approval*\n\n_This approval request expired before it could be acted on. Re-send your last message to retry._"
            );
          } catch {
            // best effort
          }
          try {
            await thread.post(
              "This tool approval request expired before it could be acted on. Re-send your last message to retry."
            );
          } catch {
            // best effort
          }
        } else {
          logger.debug(
            { requestId, decision },
            "Tool approval click with no pending invocation and no tracked card — ignoring (already handled)"
          );
        }
        return;
      }

      const pattern = `/mcp/${pending.mcpId}/tools/${pending.toolName}`;

      // Edit the posted card to strip buttons so it can't be clicked again.
      await stripApprovalButtons(
        claimApprovalCard?.(requestId),
        pending,
        decision
      );

      // Resolve the post target. Prefer the original conversation captured at
      // the time the tool call was blocked (saved alongside the pending
      // record) so the result lands in the same Slack/Telegram thread the
      // user originally pinged the bot in. Fall back to the click event's
      // thread (the card the user just clicked) only if we don't have the
      // original context — that fallback can be wrong on Slack when the card
      // ended up posted at channel level.
      let postTarget: any = thread;
      if (
        resolveApprovalTarget &&
        (pending.conversationId || pending.channelId)
      ) {
        const resolved = await resolveApprovalTarget(
          pending.channelId ?? "",
          pending.conversationId ?? ""
        ).catch(() => null);
        if (resolved) postTarget = resolved;
      }

      if (decision === "deny") {
        if (grantStore) {
          await grantStore
            .grant(pending.agentId, pattern, null, true)
            .catch(() => undefined);
        }
        try {
          await postTarget.post(
            "Tool call denied. Let me know if you'd like me to try a different approach."
          );
        } catch {
          // best effort
        }
        return;
      }

      // Approved — store grant, execute, post result
      const expiresAt = resolveGrantExpiresAt(decision);

      if (grantStore) {
        try {
          await grantStore.grant(pending.agentId, pattern, expiresAt);
          logger.info(
            {
              requestId,
              agentId: pending.agentId,
              pattern,
              decision,
              expiresAt,
            },
            "Grant stored via tool approval"
          );
        } catch (error) {
          logger.error(
            { requestId, error: String(error) },
            "Failed to store grant"
          );
        }
      }

      // Execute the pending tool call
      if (executeToolDirect) {
        try {
          const result = await executeToolDirect(
            pending.agentId,
            pending.userId,
            pending.mcpId,
            pending.toolName,
            pending.args
          );

          const resultText = result.content.map((c) => c.text).join("\n");
          await postTarget.post(
            result.isError ? `Tool error: ${resultText}` : resultText
          );
          logger.info(
            {
              requestId,
              mcpId: pending.mcpId,
              toolName: pending.toolName,
              isError: result.isError,
            },
            "Tool executed after approval"
          );
        } catch (error) {
          logger.error(
            { requestId, error: String(error) },
            "Failed to execute tool after approval"
          );
          try {
            await postTarget.post(`Failed to execute tool: ${String(error)}`);
          } catch {
            // best effort
          }
        }
      } else {
        try {
          await postTarget.post("approve");
        } catch {
          // best effort
        }
      }
      return;
    }

    // Handle question responses — Button value carries the option text on all platforms
    if (actionId.startsWith("question:")) {
      const parts = actionId.split(":");
      const questionId = parts[1] ?? "";
      const responseText = value || parts[2] || "";
      if (!questionId) return;
      if (!onQuestionClick) {
        // Tests / minimal registrations without a click pipeline — best-effort
        // post the value so the click is at least visible.
        try {
          await thread.post(responseText);
        } catch {
          // best effort
        }
        return;
      }
      try {
        await onQuestionClick(questionId, responseText, thread, event.user);
      } catch (error) {
        logger.error(
          { connectionId: connection.id, error: String(error) },
          "Failed to handle question click"
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
    const platform = instance.connection.platform;

    // `channelId` is the bare platform channel id (e.g. `"C09EH3ASNQ1"`). The
    // Chat SDK's `chat.channel()` parses the first `:`-segment as the adapter
    // name, so we must prefix with `${platform}:`.
    const channelKey = `${platform}:${channelId}`;

    // DM shortcut: buildMessagePayload stores `conversationId === channelId`
    // for DMs (channel-level, not thread-level).
    if (!conversationId || conversationId === channelId) {
      const channel = chat.channel?.(channelKey);
      if (channel) return channel;
      logger.debug(
        { connectionId, platform, channelId, channelKey },
        "resolveThread: chat.channel() returned null for DM"
      );
      return null;
    }

    // Group threads: conversationId is the Chat SDK's canonical `thread.id`
    // (e.g. `"slack:{channel}:{parent_thread_ts}"`). Pass it directly to
    // `createThread` — the adapter decodes it back into the correct
    // thread-scoped post (e.g. `conversations.replies` for Slack).
    const adapter = chat.getAdapter?.(platform);
    const createThread = (chat as any).createThread;
    if (adapter && typeof createThread === "function") {
      try {
        const thread = await createThread.call(
          chat,
          adapter,
          conversationId,
          undefined,
          false
        );
        if (thread) return thread;
      } catch (error) {
        logger.debug(
          { connectionId, platform, conversationId, error: String(error) },
          "resolveThread: createThread failed"
        );
      }
    }

    // Last-resort fallback: post at channel level so we still surface the
    // interaction instead of silently dropping it.
    const channel = chat.channel?.(channelKey);
    if (!channel) {
      logger.warn(
        { connectionId, platform, channelId, channelKey, conversationId },
        "resolveThread: unable to resolve thread or channel — dropping interaction"
      );
    }
    return channel ?? null;
  } catch (error) {
    logger.debug(
      { connectionId, channelId, conversationId, error: String(error) },
      "Failed to resolve thread for interaction"
    );
    return null;
  }
}
