import { createLogger } from "@lobu/core";
import { Actions, Button, Card, CardText, LinkButton } from "chat";
import { SCOPE_CHECK_NOT_APPLICABLE } from "../../auth/tool-access.js";
import { getDb, pgTextArray } from "../../db/client.js";
import type { Env } from "../../index.js";
import { ENTITY_CHANGE_ACTION_KEYS } from "../../tools/admin/entity-field-approval.js";
import { manageOperations } from "../../tools/admin/manage_operations.js";
import type { ToolContext } from "../../tools/registry.js";
import {
  type PendingToolInvocation,
	takePendingTool,
} from "../auth/mcp/pending-tool-store.js";
import type {
  InteractionService,
  PostedLinkButton,
  PostedQuestion,
  PostedToolApproval,
} from "../interactions.js";
import type { GrantStore } from "../permissions/grant-store.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import {
  claimPendingQuestion,
  deletePendingQuestion,
  storePendingQuestion,
} from "./pending-interaction-store.js";
import { resolveChatTarget } from "./platforms/shared.js";
import type { PlatformConnection } from "./types.js";

const logger = createLogger("chat-interaction-bridge");

/** Signature for the direct tool execution function injected from the MCP proxy. */
type ExecuteToolDirectFn = (
  agentId: string,
  userId: string,
  mcpId: string,
  toolName: string,
	args: Record<string, unknown>,
	options: { organizationId: string },
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
	context: string,
): Promise<SentMessage | null> {
  try {
    return (await thread.post(primary)) as SentMessage;
  } catch (error) {
    logger.warn(
      { connectionId, error: String(error) },
			`Failed to post ${context}`,
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
	requestId: string,
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

function actionEventTeamId(
	event: any,
	connection: PlatformConnection,
): string | null {
	const raw = event?.raw as Record<string, any> | undefined;
	const teamId =
		event?.teamId ??
		raw?.team_id ??
		raw?.team?.id ??
		event?.user?.teamId ??
		event?.user?.team_id ??
		connection.metadata?.teamId ??
		(connection.settings?.previewMode === true ? "" : undefined);
	return typeof teamId === "string" ? teamId : null;
}

/**
 * Map the clicking Slack user to a Lobu member allowed to decide this run:
 * exactly ONE chat_user_identities row for (team, platform user) that joins to
 * an org member, AND that member is an admin/owner OR the run's recorded field
 * owner (`ownerUserId`). A non-admin member who is not the owner resolves null,
 * same as an unverified account.
 */
async function resolveSlackActionReviewer(params: {
	connection: PlatformConnection;
	platformUserId: string | undefined;
	teamId: string | null;
	ownerUserId?: string | null;
}): Promise<{ userId: string; role: string } | null> {
	const { connection, platformUserId, teamId, ownerUserId } = params;
	if (connection.platform !== "slack") return null;
	if (!connection.organizationId || !platformUserId || teamId == null)
		return null;
	const sql = getDb();
	const rows = await sql<{ user_id: string; role: string }>`
    SELECT c.lobu_user_id AS user_id, m.role
    FROM chat_user_identities c
    JOIN "member" m
      ON m."userId" = c.lobu_user_id
     AND m."organizationId" = ${connection.organizationId}
    WHERE c.platform = 'slack'
      AND c.team_id = ${teamId}
      AND c.platform_user_id = ${platformUserId}
    LIMIT 2
  `;
	if (rows.length !== 1) return null;
	const { user_id: userId, role } = rows[0];
	const isAdmin = role === "admin" || role === "owner";
	const isOwner = ownerUserId != null && userId === ownerUserId;
	if (!isAdmin && !isOwner) return null;
	return { userId, role };
}

async function resolveEntityApprovalRun(
	runId: number,
	organizationId: string,
): Promise<{
	state: "pending" | "approved" | "rejected" | "not_found";
	/** action_input.owner_user_id — the field owner allowed to decide this run. */
	ownerUserId: string | null;
}> {
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const rows = await getDb()<{
		id: number;
		approval_status: string | null;
		owner_user_id: string | null;
	}>`
    SELECT id, approval_status, action_input->>'owner_user_id' AS owner_user_id
    FROM runs
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND run_type = 'internal'
      AND action_key = ANY(${actionKeys}::text[])
    LIMIT 1
  `;
	if (rows.length !== 1) return { state: "not_found", ownerUserId: null };
	const status = rows[0].approval_status;
	const state =
		status === "pending" || status === "approved" || status === "rejected"
			? status
			: "not_found";
	return { state, ownerUserId: rows[0].owner_user_id ?? null };
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
	decision: string,
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
	executeToolDirect?: ExecuteToolDirectFn,
): () => void {
  const { id: connectionId, platform } = connection;

  // Per-connection state (avoids cross-contamination between connections)
  const handledEvents = new Set<string>();
  const activeTimers = new Set<NodeJS.Timeout>();
  // Slack retries event_callback webhooks at ~1s/2s/5s/30s/60s/3min on
  // missed acks; a 30s dedup window let late retries through and
  // double-processed the event. 5min covers the full retry envelope.
  const HANDLED_EVENT_TTL_MS = 5 * 60_000;
  function markHandled(id: string): void {
    handledEvents.add(id);
    const timer = setTimeout(() => {
      handledEvents.delete(id);
      activeTimers.delete(timer);
    }, HANDLED_EVENT_TTL_MS);
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

  // Pending questions are persisted in `public.pending_interactions` so a
  // click landing on a different pod can still claim the entry. The local
  // `pendingSentMessages` map holds the non-serializable platform
  // `SentMessage` (used to strip card buttons on click) — losing it
  // cross-pod is best-effort UX, not correctness.
  //
  // DB-row sweeping is owned globally by `coreServices.sweepEphemeralTables`
  // (scheduled every 5 minutes in `packages/server/src/scheduled/jobs.ts`).
  // We do NOT call `sweepStalePendingInteractions` per-bridge — N bridges
  // hitting the same table N times is wasted work. The local sweep below
  // is in-memory only: it evicts cache entries past their TTL so the Map
  // doesn't grow unbounded for questions that are never clicked.
  const PENDING_SENT_TTL_MS = 24 * 60 * 60 * 1000;
  const PENDING_SENT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  interface CachedSent {
    sent: SentMessage;
    registeredAt: number;
  }
  const pendingSentMessages = new Map<string, CachedSent>();
  const pendingSentSweepTimer = setInterval(() => {
    const ttlCutoff = Date.now() - PENDING_SENT_TTL_MS;
    for (const [id, entry] of pendingSentMessages) {
      if (entry.registeredAt <= ttlCutoff) {
        pendingSentMessages.delete(id);
      }
    }
  }, PENDING_SENT_SWEEP_INTERVAL_MS);
  pendingSentSweepTimer.unref?.();
  /**
   * Persist a pending question row, then cache its SentMessage handle so a
   * click on this pod can edit the card. The persist happens first — see
   * `onQuestionCreated` for the post-then-persist policy that wraps the
   * card-post; this function is invoked only after the row is durable.
   */
  function rememberSentMessage(
    questionId: string,
		sent: SentMessage | undefined,
  ): void {
    if (!sent) return;
    pendingSentMessages.set(questionId, {
      sent,
      registeredAt: Date.now(),
    });
  }
  async function claimQuestion(
    questionId: string,
    organizationId: string,
		expectedUserId: string,
  ): Promise<PendingQuestionEntry | undefined> {
    const stored = await claimPendingQuestion(
      questionId,
      organizationId,
      connectionId,
			expectedUserId,
    ).catch((error) => {
      logger.error(
        { connectionId, questionId, error: String(error) },
				"Failed to claim pending question",
      );
      return null;
    });
    if (!stored) return undefined;
    const cached = pendingSentMessages.get(questionId);
    pendingSentMessages.delete(questionId);
    return { question: stored.question, sent: cached?.sent };
  }

  /**
   * Shared preamble for every InteractionService handler: platform/tenant
   * guard, per-connection dedup (Slack retries the same webhook for up to
   * 5min), thread resolution, and a catch-all so one handler's failure never
   * escapes into the event emitter. `handler` runs only once per event id with
   * a resolved thread; org/user sub-checks stay inline in each body.
   */
  function withResolvedThread<
    E extends {
      id: string;
      channelId: string;
      conversationId: string;
      platform?: string;
    },
  >(
    eventName: string,
    handler: (event: E, thread: any) => Promise<void>,
  ): (event: E) => Promise<void> {
    return async (event: E) => {
      try {
        if (!shouldHandle(event, platform, connectionId, manager)) return;
        if (handledEvents.has(event.id)) return;
        markHandled(event.id);

        const thread = await resolveThread(
          manager,
          connectionId,
          event.channelId,
          event.conversationId,
        );
        if (!thread) return;

        await handler(event, thread);
      } catch (error) {
        logger.error(
          { connectionId, error: String(error) },
          `Unhandled error in ${eventName} handler`,
        );
      }
    };
  }

  const onQuestionCreated = withResolvedThread<PostedQuestion>(
    "question:created",
    async (event, thread) => {
      // Cross-tenant scoping: every pending row must carry the bridge's
      // org. Without a known org we can't safely persist or claim, so
      // drop the event rather than write an un-scoped row.
      const organizationId = connection.organizationId;
      if (!organizationId) {
        logger.warn(
          { connectionId, questionId: event.id },
					"Skipping question:created — connection has no organizationId",
        );
        return;
      }
      if (!event.userId) {
        logger.warn(
          { connectionId, questionId: event.id },
					"Skipping question:created — event has no userId",
        );
        return;
      }

      // Persist the pending row BEFORE posting the card. If the persist
      // fails we never show buttons that would no-op on click. If the row
      // is written but the post fails, we delete it on the way out so a
      // stale row doesn't sit waiting for a click that will never arrive.
      try {
        await storePendingQuestion(
          event.id,
          organizationId,
          connectionId,
          event.userId,
					{ question: event },
        );
      } catch (error) {
        logger.error(
          { connectionId, questionId: event.id, error: String(error) },
					"Failed to persist pending question — not posting card",
        );
        return;
      }

      const buttons = event.options.map((option, i) =>
        Button({
          id: `question:${event.id}:${i}`,
          label: option,
          value: option,
				}),
      );
      const card = Card({
        children: [CardText(event.question), Actions(buttons)],
      });
      const fallbackText = `${event.question}\n${event.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
      const sent = await postWithFallback(
        thread,
        { card, fallbackText },
        connectionId,
				"question interaction",
      );
      if (!sent) {
        // Post failed entirely. The row exists but no card was rendered,
        // so a click can never come — DELETE the row to keep the table
        // clean. Pre-fix used `claimPendingQuestion` (UPDATE setting
        // claimed_at), which leaves a phantom row sitting around with
        // claimed_at set until the 24h sweep. Hard-delete is the
        // semantically correct end state, and the four-field scoping
        // matches the claim path's safety invariant: a leaked id alone
        // cannot delete another tenant's row.
        try {
          await deletePendingQuestion(
            event.id,
            organizationId,
            connectionId,
						event.userId,
          );
        } catch (error) {
          logger.debug(
            { connectionId, questionId: event.id, error: String(error) },
						"Failed to drop pending row after post failure",
          );
        }
        return;
      }
      rememberSentMessage(event.id, sent);
    },
  );

  const onToolApprovalNeeded = withResolvedThread<PostedToolApproval>(
    "tool:approval-needed",
    async (event, thread) => {
      const argsText = formatToolArgs(event.args);
      const text = `Tool Approval\n${event.mcpId} → ${event.toolName}\n${argsText}`;
      const tid = event.id;

      const card = Card({
        children: [
          CardText(
						`*Tool Approval*\n${event.mcpId} → ${event.toolName}\n${argsText}`,
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
				"tool approval interaction",
      );
      if (sent) {
        trackApprovalCard(tid, sent);
      }
    },
  );

  const onLinkButtonCreated = withResolvedThread<PostedLinkButton>(
    "link-button:created",
    async (event, thread) => {
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
				"link button interaction",
      );
    },
  );

  interactionService.on("question:created", onQuestionCreated);
  interactionService.on("tool:approval-needed", onToolApprovalNeeded);
  interactionService.on("link-button:created", onLinkButtonCreated);

  registerActionHandlers(
    chat,
    connection,
    grantStore,
    executeToolDirect,
    claimApprovalCard,
    async (questionId, value, thread, author) => {
      // Fast path — Slack's block_actions webhook requires a <3s response.
      // The claim is a single `UPDATE … RETURNING` on a PK and stays well
      // under the budget; the slow platform API calls (post receipt, edit
      // card, enqueue worker turn) still fire-and-forget below.
      //
      // Authorisation lives INSIDE the SQL claim: the row only matches when
      // `(organization_id, connection_id, expected_user_id)` line up with
      // the clicker's context. Wrong-user / cross-connection / cross-tenant
      // clicks return null without consuming the row — no claim-then-auth
      // race, no restash needed.
      const organizationId = connection.organizationId;
      if (!organizationId) {
        logger.warn(
          { connectionId, questionId },
					"Question click on connection with no organizationId — ignoring",
        );
        return;
      }
      if (!author?.userId) {
        logger.debug(
          { connectionId, questionId },
					"Question click without author.userId — ignoring",
        );
        return;
      }

      const entry = await claimQuestion(
        questionId,
        organizationId,
				author.userId,
      );
      if (!entry) {
        logger.debug(
          { connectionId, questionId, clickerUserId: author.userId },
					"Question click did not match any pending row — ignoring",
        );
        return;
      }

      const instance = manager.getInstance(connectionId);
      if (!instance) {
        logger.warn(
          { connectionId },
					"Question click: no instance for connection",
        );
        return;
      }

      const { question } = entry;
      const receiptText = value
        ? `*You submitted:* ${value}`
        : "*You submitted a response.*";

      void (async () => {
        // Visible "user submitted X" receipt so the click is acknowledged
        // in-thread even before the worker responds.
        try {
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
							`${question.question}\n\n_Answered: ${value}_`,
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
					"Background question-click processing failed",
        );
      });
    },
    async (channelId, conversationId) =>
			resolveThread(manager, connectionId, channelId, conversationId),
  );

  logger.info({ connectionId, platform }, "Interaction bridge registered");

  return () => {
    interactionService.off("question:created", onQuestionCreated);
    interactionService.off("tool:approval-needed", onToolApprovalNeeded);
    interactionService.off("link-button:created", onLinkButtonCreated);
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
    clearInterval(pendingSentSweepTimer);
    pendingSentMessages.clear();
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
	author: { userId?: string; userName?: string; fullName?: string } | undefined,
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
		conversationId: string,
	) => Promise<any | null>,
): void {
	chat.onAction(async (event: any) => {
		const actionId: string = event.actionId ?? "";
		const value: string = event.value ?? "";
		const thread = event.thread;

		if (!thread || !actionId) return;

		// Handle durable run approvals from notification cards. This path is
		// intentionally scoped to entity_field_change: approving connector actions
		// from chat needs a separate env-safe execution path.
		if (actionId.startsWith("run-approval:")) {
			const [, runIdPart, decisionPart] = actionId.split(":");
			const runId = Number(runIdPart);
			const decision =
				decisionPart === "approve" || decisionPart === "reject"
					? decisionPart
					: null;
			const organizationId = connection.organizationId;
			if (!Number.isFinite(runId) || !decision || !organizationId) return;

			const { state: runState, ownerUserId } = await resolveEntityApprovalRun(
				runId,
				organizationId,
			).catch(() => ({ state: "not_found" as const, ownerUserId: null }));
			if (runState !== "pending") {
				// Distinguish "already decided" (double-click, stale card, webhook
				// retry) from "not an entity approval in this org" — the old single
				// message blamed Slack support for both.
				const message =
					runState === "approved"
						? "This change was already approved."
						: runState === "rejected"
							? "This change was already rejected."
							: "This approval can’t be completed from Slack yet. Use the Review in Lobu link.";
				try {
					await thread.post(message);
				} catch {
					// best effort
				}
				return;
			}

			const reviewer = await resolveSlackActionReviewer({
				connection,
				platformUserId: event.user?.userId,
				teamId: actionEventTeamId(event, connection),
				ownerUserId,
			}).catch(() => null);
			if (!reviewer) {
				try {
					await thread.post(
						"I couldn’t verify that your Slack account maps to a Lobu admin for this workspace. Use the Review in Lobu link.",
					);
				} catch {
					// best effort
				}
				return;
			}

			const ctx: ToolContext = {
				organizationId,
				userId: reviewer.userId,
				memberRole: reviewer.role,
				isAuthenticated: true,
				clientId: null,
				// Session-caller sentinel: the reviewer is authorized by verified
				// Slack identity + role/ownership above, not by MCP token scopes —
				// a null scope set would fail closed at the action tier.
				scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
				tokenType: "session",
				scopedToOrg: true,
				allowCrossOrg: false,
				sourceContext: {
					platform: connection.platform,
					connectionId: connection.id,
					channelId: event.channelId,
					conversationId: event.conversationId,
					teamId: actionEventTeamId(event, connection) ?? undefined,
					userId: event.user?.userId,
				},
			};
			// Real process env, not {}: approving a create runs entity hooks that
			// are env-gated (e.g. $member invite email needs RESEND_API_KEY) — an
			// empty env silently skips them, diverging from web approvals.
			const result = await manageOperations(
				decision === "approve"
					? { action: "approve", run_id: runId }
					: { action: "reject", run_id: runId, reason: "Rejected from Slack" },
				process.env as unknown as Env,
				ctx,
			).catch((error) => ({ error: String(error) }));
			const resultRecord = result as Record<string, unknown>;
			const message =
				typeof resultRecord.message === "string"
					? resultRecord.message
					: typeof resultRecord.error === "string"
						? resultRecord.error
						: decision === "approve"
							? "Approved."
							: "Rejected.";
			try {
				await thread.post(message);
			} catch {
				// best effort
			}
			return;
		}

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
				() => null,
      );
      if (!pending) {
        const sent = claimApprovalCard?.(requestId);
        if (sent) {
          logger.info(
            { requestId, decision },
						"Tool approval click with no pending invocation — likely expired",
          );
          try {
            await sent.edit(
							"*Tool Approval*\n\n_This approval request expired before it could be acted on. Re-send your last message to retry._",
            );
          } catch {
            // best effort
          }
          try {
            await thread.post(
							"This tool approval request expired before it could be acted on. Re-send your last message to retry.",
            );
          } catch {
            // best effort
          }
        } else {
          logger.debug(
            { requestId, decision },
						"Tool approval click with no pending invocation and no tracked card — ignoring (already handled)",
          );
        }
        return;
      }

      const pattern = `/mcp/${pending.mcpId}/tools/${pending.toolName}`;

      // Edit the posted card to strip buttons so it can't be clicked again.
      await stripApprovalButtons(
        claimApprovalCard?.(requestId),
        pending,
				decision,
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
					pending.conversationId ?? "",
        ).catch(() => null);
        if (resolved) postTarget = resolved;
      }

      if (decision === "deny") {
        if (grantStore) {
          await grantStore
            .grant(
              pending.agentId,
              pattern,
              null,
              true,
							pending.organizationId ?? connection.organizationId,
            )
            .catch(() => undefined);
        }
        try {
          await postTarget.post(
						"Tool call denied. Let me know if you'd like me to try a different approach.",
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
          await grantStore.grant(
            pending.agentId,
            pattern,
            expiresAt,
            undefined,
						pending.organizationId ?? connection.organizationId,
          );
          logger.info(
            {
              requestId,
              agentId: pending.agentId,
              pattern,
              decision,
              expiresAt,
            },
						"Grant stored via tool approval",
          );
        } catch (error) {
          logger.error(
            { requestId, error: String(error) },
						"Failed to store grant",
          );
        }
      }

      // Execute the pending tool call
      if (executeToolDirect) {
        try {
					const organizationId = pending.organizationId;
					if (!organizationId) {
						logger.error(
							{ requestId, mcpId: pending.mcpId, toolName: pending.toolName },
							"Refusing to execute approved MCP tool without organizationId",
						);
						await postTarget.post(
							"This tool approval is missing organization context. Re-send your request to retry.",
						);
						return;
					}
          const result = await executeToolDirect(
            pending.agentId,
            pending.userId,
            pending.mcpId,
            pending.toolName,
						pending.args,
						{ organizationId },
          );

          const resultText = result.content.map((c) => c.text).join("\n");
          await postTarget.post(
						result.isError ? `Tool error: ${resultText}` : resultText,
          );
          logger.info(
            {
              requestId,
              mcpId: pending.mcpId,
              toolName: pending.toolName,
              isError: result.isError,
            },
						"Tool executed after approval",
          );
        } catch (error) {
          logger.error(
            { requestId, error: String(error) },
						"Failed to execute tool after approval",
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
					"Failed to handle question click",
        );
      }
    }
  });
}

export function shouldHandle(
  event: {
    teamId?: string;
    channelId: string;
    connectionId?: string;
    platform?: string;
  },
  platform: string,
  connectionId: string,
	manager: ChatInstanceManager,
): boolean {
  // Platform isolation: a bridge only handles events posted for its own
  // platform. This is what makes connectionless `platform: "api"` events
  // (API sessions have no Chat SDK connection) safe — without it, the
  // connectionId fall-through below would let any chat bridge pick them up.
  if (event.platform && event.platform !== platform) {
    return false;
  }
  if (!manager.has(connectionId)) {
    logger.debug(
      { connectionId, eventConnectionId: event.connectionId },
			"shouldHandle: manager does not have connection",
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
			"shouldHandle: platform mismatch",
    );
  }
  return matches;
}

async function resolveThread(
  manager: ChatInstanceManager,
  connectionId: string,
  channelId: string,
	conversationId: string,
): Promise<any | null> {
  const instance = manager.getInstance(connectionId);
  if (!instance) {
    logger.debug({ connectionId }, "resolveThread: no instance for connection");
    return null;
  }

  try {
    // No `currentMessage` / `responseThreadId` for interactions — the bridge
    // resolves the post target purely from channelId + the canonical
    // conversation thread id.
    return await resolveChatTarget(
      instance.chat,
      instance.connection.platform,
      { channelId, conversationId },
    );
  } catch (error) {
    logger.debug(
      { connectionId, channelId, conversationId, error: String(error) },
			"Failed to resolve thread for interaction",
    );
    return null;
  }
}
