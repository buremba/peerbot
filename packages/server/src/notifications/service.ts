import { randomUUID } from "node:crypto";
import type { CardElement } from "chat";
import { getDb, pgTextArray } from "../db/client";
import { resolveBoundChannelRows } from "../gateway/channels/bound-channels";
import { getChatInstanceManager, isLobuGatewayRunning } from "../lobu/gateway";
import type { McpActivityAttribution } from "../lobu/stores/mcp-client-conversations";
import { resolveSlackUserIdForUser } from "../lobu/stores/chat-identity.js";
import { insertEvent } from "../utils/insert-event";
import logger from "../utils/logger";
import { isUniqueViolation } from "../utils/pg-errors";

interface CreateNotificationParams {
	organizationId: string;
	type:
		| "action_approval_needed"
		| "connection_permission_request"
		| "invitation_received"
		| "browser_auth_expired"
		| "generic"
		| "agent_message";
	title: string;
	body?: string | null;
	resourceType?: string | null;
	resourceId?: string | null;
	resourceUrl?: string | null;
	/** Stable producer key used to collapse retried notification sends. */
	idempotencyKey?: string | null;
	/** When set, deliver only through this specific bot connection */
	connectionId?: string | null;
	/** When set, deliver only to this Behavior-subscribed channel. */
	channelId?: string | null;
	/** Optional workspace/team guard for channel-scoped delivery. */
	teamId?: string | null;
	/**
	 * Lobu user who owns the change under review (field-change approvals).
	 * When set, bot delivery tries the owner's Slack DM FIRST — resolved via
	 * the owner's workspace-scoped Slack identity — and only falls back
	 * to the configured-target/org-wide channel chain when the owner has no
	 * Slack identity or the DM fails. In-app inbox targeting is unaffected.
	 */
	ownerUserId?: string | null;
	/**
	 * Optional rich card (`chat` `CardElement`) for bot-connection delivery. When
	 * set, the bound channel gets this card instead of the markdown body; the
	 * in-app inbox entry still uses title/body.
	 */
	card?: CardElement | null;
	/**
	 * Optional entity ids to anchor the notification event to (e.g. a watcher's
	 * canvas entity, so the notification threads under the canvas). Stamped onto
	 * the notification event's `entity_ids`.
	 */
	entityIds?: number[];
	/** Exact MCP conversation or transport session that caused this notification. */
	mcpActivity?: McpActivityAttribution | null;
	/**
	 * The Behavior run that emitted this notification, when one did.
	 *
	 * These MUST come from server-set context (`ctx.actingWatcherId` /
	 * `actingRunId`, stamped by the reaction executor), never from a caller-
	 * supplied `behavior_source`. `behavior_id` drives window self-exclusion, so
	 * an id a caller could choose would let one Behavior hide rows from another
	 * Behavior's input.
	 *
	 * Before this existed, a notification was written with no run and no
	 * Behavior at all — prod notification 4858497 had `run_id` NULL while every
	 * sibling output of the same run carried 880183 — so the thing a user
	 * actually clicks could not be traced back to the run that sent it.
	 */
	behaviorId?: number | null;
	behaviorVersionId?: number | null;
	runId?: number | null;
}

/**
 * Forward a notification to the org's active chat-bot connections so it lands
 * in the bound channel — e.g. a watcher digest posting to #leads.
 *
 * Resolves connections + their Behavior subscriptions straight from Postgres and
 * posts in-process via the chat manager. Every app pod loads every active
 * connection at boot, so the locally-held instance can post regardless of
 * which pod fired the notification — correct under N>1 replicas, no cross-pod
 * routing needed.
 *
 * Best-effort: a connection with no live instance or no binding is skipped
 * without failing the others. A connection bound to several channels posts to
 * each.
 */
interface BotDeliveryTarget {
	connectionId: string;
	platform: string;
	/** Platform-prefixed channel id ready for `chat.channel()`, e.g. "slack:C0123ABCD". */
	channelKey: string;
	/** Workspace/team id from the subscription — keys the owner-DM identity lookup. */
	teamId: string | null;
}

/**
 * Resolve where a notification should be posted.
 *
 * Two branches, UNIONed:
 *
 *   (A) The org's OWN active chat connections JOINed to their subscriptions,
 *       scoped to (org, agent) — the multi-tenant default. A connection with no
 *       subscription has no target; several subscribed channels yield one
 *       target each.
 *
 *   (B) Hosted-preview cross-org delivery. The hosted preview bot is ONE
 *       connection living in its OWN org under a placeholder agent, that fans
 *       out to agents across MANY orgs — a `/lobu link <code>` writes the
 *       subscription under the claim's org, never the connection's. So branch (A)'s
 *       `(org, agent)` JOIN misses it on BOTH columns and proactive
 *       notifications silently drop. This branch resolves the org's bindings
 *       through the shared preview connection, mirroring the inbound
 *       concrete-connection routing. It is gated HARD to the single previewMode
 *       connection per platform and, when that connection is workspace-scoped,
 *       to bindings from the same workspace. It is NOT joined on `agent_id`, so
 *       the hosted connection's placeholder agent does not hide tenant bindings.
 *
 * A legacy tenantless hosted connection can serve all of its bindings. A
 * workspace-scoped hosted connection serves only bindings carrying that same
 * team id, so channel ids cannot collide across workspaces.
 *
 * Exported for testing the delivery path against a real DB.
 */
export async function resolveBotDeliveryTargets(
	organizationId: string,
	opts?:
		| string
		| null
		| {
				connectionId?: string | null;
				channelId?: string | null;
				teamId?: string | null;
		  },
): Promise<BotDeliveryTarget[]> {
	const connectionId =
		typeof opts === "string" || opts === null ? opts : opts?.connectionId;
	const channelId =
		typeof opts === "object" && opts !== null ? opts.channelId : null;
	const teamId = typeof opts === "object" && opts !== null ? opts.teamId : null;
	// Org-wide (no agentId): every channel any of the org's agents is bound to,
	// resolved through the right connection. Shared resolver = one home for the
	// cross-org preview invariant (see bound-channels.ts).
	const rows = await resolveBoundChannelRows(getDb(), {
		organizationId,
		connectionId,
	});

	const normalizedChannelId = channelId
		? channelId.includes(":")
			? channelId
			: null
		: null;

	return rows
		.filter((row) => {
			if (teamId && row.team_id !== teamId) return false;
			if (!channelId) return true;
			const rowChannelKey = row.channel_id.includes(":")
				? row.channel_id
				: `${row.platform}:${row.channel_id}`;
			const requestedChannelKey =
				normalizedChannelId ?? `${row.platform}:${channelId}`;
			return (
				row.channel_id === channelId || rowChannelKey === requestedChannelKey
			);
		})
		.map((row) => ({
			connectionId: row.id,
			platform: row.platform,
			// Bindings store the platform-prefixed id ("slack:C0123ABCD"); older rows
			// may hold the bare id, so prefix defensively.
			channelKey: row.channel_id.includes(":")
				? row.channel_id
				: `${row.platform}:${row.channel_id}`,
			teamId: row.team_id,
		}));
}

/**
 * Owner-routed delivery target: the Slack identity of `ownerUserId` in a
 * workspace one of the org's bot connections lives in. Reverse-looks-up
 * the workspace-scoped Slack identity on the owner's `$member` (team matching
 * the connection's binding team) per candidate connection, most-recently-bound first via
 * resolveBotDeliveryTargets order. Null when the owner has no Slack identity in
 * any connected workspace — the caller falls back to channel delivery.
 * Exported for testing the tier-selection logic against a real DB.
 */
export async function resolveOwnerDmTarget(
	organizationId: string,
	ownerUserId: string,
	connectionId?: string | null,
): Promise<{ connectionId: string; slackUserId: string } | null> {
	const targets = await resolveBotDeliveryTargets(
		organizationId,
		connectionId ?? null,
	);
	const seen = new Set<string>();
	for (const target of targets) {
		if (target.platform !== "slack" || target.teamId == null) continue;
		const key = `${target.connectionId}:${target.teamId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const slackUserId = await resolveSlackUserIdForUser(
			ownerUserId,
			target.teamId,
		);
		if (slackUserId) {
			return { connectionId: target.connectionId, slackUserId };
		}
	}
	return null;
}

/**
 * The org's URL slug, for building a permalink to a notification.
 *
 * Shared by the trigger fan-out and the `notify` tool so both link into the
 * same place; `buildResourcePermalink` returns undefined without it.
 */
export async function getOrgSlug(
	organizationId: string,
): Promise<string | null> {
	const sql = getDb();
	const rows = await sql<{ slug: string }>`
    SELECT slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
  `;
	return rows[0]?.slug ?? null;
}

/**
 * Resolve the notification event a producer key already claimed, if any.
 *
 * Reads the partial unique index `idx_events_org_idempotency_key` directly, so
 * it is the same key the insert races on — no second notion of "already sent".
 * Exported for the `notify` tool, which must resolve a repeat BEFORE queueing
 * an ask's pending run — after the fact, the orphan run is already durable.
 */
export async function findNotificationByIdempotencyKey(
	organizationId: string,
	idempotencyKey: string,
): Promise<number | null> {
	const sql = getDb();
	const rows = (await sql`
    SELECT id
    FROM events
    WHERE organization_id = ${organizationId}
      AND metadata ? '_lobu_idempotency_key'
      AND metadata->>'_lobu_idempotency_key' = ${idempotencyKey}
    LIMIT 1
  `) as unknown as Array<{ id: number }>;
	const id = rows[0]?.id;
	return id === undefined ? null : Number(id);
}

/**
 * Where one copy of a notification physically landed on a chat platform.
 *
 * Recorded so a later state change can EDIT that message in place
 * (`ChatInstanceManager.editMessage` addresses a message by
 * `(threadId, messageId)`) and so an agent's follow-up can reply into the same
 * thread. Both need the ids the post returned, and nothing else persists them —
 * `channel_messages` is keyed on the platform message id with no link back to
 * the notification, so it cannot answer "where did notification N go?".
 *
 * Durable rather than in-memory on purpose: the pod that edits or replies is
 * frequently not the pod that posted.
 */
interface NotificationDeliveryRecord {
	connectionId: string;
	/** Platform-prefixed channel id, or `dm` for the owner-routed tier. */
	channelKey: string;
	messageId: string;
	threadId: string;
}

/**
 * Stamp where the notification was delivered onto the event that represents it.
 *
 * Post-hoc metadata UPDATE, matching the routing stamp in
 * `gateway/routes/internal/interactions.ts`: `events` is append-only for
 * DELETE, and this touches delivery metadata only — never payload. It has to
 * run after the fan-out because the platform ids do not exist until the post
 * returns, and the durable notification write must not block on a best-effort
 * chat post.
 *
 * Best-effort: losing the record costs a later in-place edit, not the
 * notification itself.
 */
async function recordDelivery(
	eventId: number,
	deliveries: NotificationDeliveryRecord[],
): Promise<void> {
	// A record exists to be addressed later, and `editMessage(threadId, messageId)`
	// cannot address an empty id — an adapter that returned no message id has
	// given us nothing to point at. Dropping it here rather than at each caller
	// keeps the one rule in the one place that writes the record.
	const addressable = deliveries.filter((entry) => entry.messageId !== "");
	if (addressable.length === 0) return;
	try {
		const sql = getDb();
		await sql`
      UPDATE events
      SET metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object('delivery', ${sql.json(addressable)}::jsonb)
      WHERE id = ${eventId}
    `;
	} catch (err) {
		logger.warn(
			{ err, eventId },
			"[Notifications] Failed to record delivery targets",
		);
	}
}

async function deliverToBotConnections(
	params: Omit<CreateNotificationParams, "userId">,
	eventId: number,
): Promise<void> {
	if (!isLobuGatewayRunning()) return;
	const manager = getChatInstanceManager();
	if (!manager) return;

	const text = params.body ? `${params.title}\n\n${params.body}` : params.title;
	// A rich card takes precedence over the markdown body for the channel post.
	const content = params.card ? { card: params.card } : { markdown: text };

	// Owner-routed tier: an approval whose gated fields have ONE human owner
	// goes to that owner's Slack DM first (same card, same approve/reject
	// buttons — the interaction bridge is connection-scoped, so clicks route
	// identically). Any miss — no identity row, DM open/post failure — logs and
	// falls through to the configured-target/org-wide chain unchanged.
	if (params.ownerUserId) {
		try {
			const dm = await resolveOwnerDmTarget(
				params.organizationId,
				params.ownerUserId,
				params.connectionId,
			);
			if (dm) {
				const sent = await manager.postDirectMessage(
					dm.connectionId,
					dm.slackUserId,
					content,
				);
				await recordDelivery(eventId, [
					{
						connectionId: dm.connectionId,
						channelKey: "dm",
						messageId: sent.messageId,
						threadId: sent.threadId,
					},
				]);
				return;
			}
			logger.warn(
				{ organizationId: params.organizationId, ownerUserId: params.ownerUserId },
				"[Notifications] Approval owner has no Slack identity in a connected workspace — falling back to channel delivery",
			);
		} catch (err) {
			logger.warn(
				{
					err,
					organizationId: params.organizationId,
					ownerUserId: params.ownerUserId,
				},
				"[Notifications] Owner DM delivery failed — falling back to channel delivery",
			);
		}
	}

	try {
		let targets = await resolveBotDeliveryTargets(params.organizationId, {
			connectionId: params.connectionId,
			channelId: params.channelId,
			teamId: params.teamId,
		});
		// A configured target that no longer resolves (channel unbound, connection
		// removed, team drifted) must not silently swallow the notification — the
		// admin explicitly asked for Slack review. Fall back to org-wide delivery
		// and say so, instead of nothing arriving anywhere.
		if (
			targets.length === 0 &&
			(params.connectionId || params.channelId || params.teamId)
		) {
			logger.warn(
				{
					organizationId: params.organizationId,
					connectionId: params.connectionId,
					channelId: params.channelId,
					teamId: params.teamId,
				},
				"[Notifications] Configured delivery target resolved to no bound channels — falling back to org-wide delivery",
			);
			targets = await resolveBotDeliveryTargets(params.organizationId, null);
		}
		if (targets.length === 0) return;

		const posted = await Promise.allSettled(
			targets.map(
				async ({
					connectionId,
					channelKey,
				}): Promise<NotificationDeliveryRecord> => {
					const sent = await manager.postMessageToChannel(
						connectionId,
						channelKey,
						content,
					);
					return {
						connectionId,
						channelKey,
						messageId: sent.messageId,
						threadId: sent.threadId,
					};
				},
			),
		);
		const delivered: NotificationDeliveryRecord[] = [];
		posted.forEach((result, index) => {
			if (result.status === "fulfilled") {
				delivered.push(result.value);
				return;
			}
			logger.warn(
				{
					err: result.reason,
					connectionId: targets[index]?.connectionId,
					channelKey: targets[index]?.channelKey,
				},
				"[Notifications] Failed to post to bot connection channel",
			);
		});
		await recordDelivery(eventId, delivered);
	} catch (err) {
		logger.warn(
			{ err },
			"[Notifications] Failed to deliver to bot connections",
		);
	}
}

/**
 * Notifications are events + per-user targets.
 *
 * The `events` table stores the notification's content (org-wide visibility,
 * searchable, addressable from the knowledge view); `notification_targets`
 * scopes inbox / read-state to the addressed users. "Send to admins" inserts
 * ONE event + N targets; "mark read" updates a target row; "unread count"
 * counts target rows without `read_at`.
 *
 * The legacy public.notifications table was migrated by
 * 20260513200000_notifications_as_events.sql and dropped.
 */
export async function createNotificationForUsers(
	userIds: string[],
	params: Omit<CreateNotificationParams, "userId">,
): Promise<{ created: boolean; eventId: number | null }> {
	if (userIds.length === 0) return { created: false, eventId: null };
	const sql = getDb();

	const metadata: Record<string, unknown> = {
		notification_type: params.type,
		resource_type: params.resourceType ?? null,
		resource_id: params.resourceId ?? null,
		resource_url: params.resourceUrl ?? null,
		// Persisted, not just handed to the fan-out: the card IS the notification's
		// rendered form, and a connection that was offline at send time (or a
		// surface that renders it later) has no other way to recover it.
		...(params.card ? { card: params.card } : {}),
		...(params.idempotencyKey
			? { _lobu_idempotency_key: params.idempotencyKey }
			: {}),
		...(params.mcpActivity?.transportSessionId
			? { mcp_session_id: params.mcpActivity.transportSessionId }
			: {}),
		...(params.mcpActivity?.hostConversationId
			? { mcp_conversation_id: params.mcpActivity.hostConversationId }
			: {}),
	};

	// Idempotent repeat: hand back the durable event the first send landed, so a
	// retry still resolves to a usable id/url instead of an empty success.
	// Preflight read + unique-index catch below, exactly as save_content does —
	// `insertEvent` has no ON CONFLICT of its own.
	if (params.idempotencyKey) {
		const prior = await findNotificationByIdempotencyKey(
			params.organizationId,
			params.idempotencyKey,
		);
		if (prior !== null) return { created: false, eventId: prior };
	}

	let eventId: number;
	try {
		eventId = (await sql.begin(async (tx) => {
			const event = await insertEvent(
				{
					entityIds: params.entityIds ?? [],
					organizationId: params.organizationId,
					// Notifications are minted here, not synced from a source, so there
					// is no upstream identity to carry. A fresh uuid gives every
					// notification the stable identity the events contract expects
					// without pretending the producer key is a source id.
					originId: randomUUID(),
					title: params.title,
					content: params.body ?? null,
					payloadType: "text",
					semanticType: "notification",
					metadata,
					clientId: params.mcpActivity?.clientId ?? null,
					runId: params.runId ?? null,
					behaviorId: params.behaviorId ?? null,
					behaviorVersionId: params.behaviorVersionId ?? null,
				},
				{ sql: tx },
			);

			await tx`
      INSERT INTO notification_targets (event_id, user_id)
      SELECT ${event.id}, uid
      FROM unnest(${pgTextArray(userIds)}::text[]) AS u(uid)
      ON CONFLICT DO NOTHING
    `;
			return event.id;
		})) as number;
	} catch (error) {
		// Two replicas may race past the preflight read. The unique index is the
		// lock; the loser resolves and returns the winner's durable event.
		if (
			params.idempotencyKey &&
			isUniqueViolation(error, "idx_events_org_idempotency_key")
		) {
			const winner = await findNotificationByIdempotencyKey(
				params.organizationId,
				params.idempotencyKey,
			);
			if (winner === null) throw error;
			return { created: false, eventId: winner };
		}
		throw error;
	}

	// Deliver to bot connections (fire-and-forget). The bot delivery targets
	// the org's connection default channels and is identical for every user in
	// this call, so fan it out once — not once per user.
	deliverToBotConnections(params, eventId).catch((err) =>
		logger.warn(
			{ err },
			"[Notifications] Failed to deliver to bot connections",
		),
	);
	return { created: true, eventId };
}

export async function listNotifications(opts: {
	organizationId: string;
	userId: string;
	cursor?: number | null;
	limit?: number;
	unreadOnly?: boolean;
	clientIds?: string[];
	mcpActivityId?: string | null;
}): Promise<{
	notifications: Record<string, unknown>[];
	nextCursor: number | null;
}> {
	const sql = getDb();
	const limit = Math.min(opts.limit ?? 20, 50);
	const cursor = opts.cursor ?? null;
	const unreadOnly = opts.unreadOnly ?? false;
	const clientIds = opts.clientIds?.length ? opts.clientIds : null;
	const mcpActivityId = opts.mcpActivityId?.trim() || null;

	const rows = (await sql`
    SELECT
      e.id,
      e.organization_id,
      t.user_id,
      COALESCE(e.metadata->>'notification_type', 'generic') AS type,
      e.title,
      e.payload_text AS body,
      e.metadata->>'resource_type' AS resource_type,
      e.metadata->>'resource_id' AS resource_id,
      e.metadata->>'resource_url' AS resource_url,
      e.connector_key AS platform,
      e.connection_id,
      e.feed_id,
      e.feed_key,
      fd.display_name AS feed_name,
      e.behavior_id,
      COALESCE(wv.name, 'watcher-' || e.behavior_id) AS behavior_name,
      pe.interaction_type AS interaction_type,
      -- Whether the decision needs FIELDS or is a bare yes/no. Consumers pick
      -- the affordance from this, not from a list of known action keys.
      pe.interaction_input_schema AS interaction_input_schema,
      ar.id AS approval_run_id,
      -- A pending approval whose review card is unreachable — the proposal
      -- event's connection is soft-deleted (or gone), so the card is invisible
      -- to every content read (connection-visibility predicate) and
      -- approve/reject would be blind — resolves terminal ('expired'), never
      -- as an actionable pending approval.
      CASE
        WHEN ar.approval_status = 'pending'
         AND pe.connection_id IS NOT NULL
         AND pc.id IS NULL
        THEN 'expired'
        ELSE ar.approval_status
      END AS approval_status,
      ar.action_key AS approval_action_key,
      (t.read_at IS NOT NULL) AS is_read,
      t.delivered_at AS created_at
    FROM notification_targets t
    JOIN events e ON e.id = t.event_id
    LEFT JOIN feeds fd ON fd.id = e.feed_id
    LEFT JOIN watchers w ON w.id = e.behavior_id
    LEFT JOIN watcher_versions wv ON w.current_version_id = wv.id
    -- Approval notifications point at proposal events; resolve the run here so
    -- consumers see its current approval state rather than an emitted snapshot.
    LEFT JOIN events pe
      ON COALESCE(e.metadata->>'notification_type', 'generic') = 'action_approval_needed'
     AND e.metadata->>'resource_type' = 'event'
     AND e.metadata->>'resource_id' ~ '^[0-9]+$'
     AND pe.id = (e.metadata->>'resource_id')::bigint
     AND pe.organization_id = e.organization_id
     AND pe.interaction_type = 'approval'
    LEFT JOIN runs ar
      ON ar.organization_id = e.organization_id
     AND ar.id = pe.run_id
    -- Mirrors the connection-visibility predicate every content read applies
    -- (compileConnectionFkVisibility): the card counts as reviewable only when
    -- its connection is live, org-visible, and (for private) owned by the
    -- reader. A deleted or invisible connection means the card can never be
    -- opened, so the approval is undecidable.
    LEFT JOIN connections pc
      ON pc.id = pe.connection_id
     AND pc.organization_id = e.organization_id
     AND pc.deleted_at IS NULL
     AND (
       pc.visibility = 'org'
       OR (${opts.userId}::text IS NOT NULL AND pc.created_by = ${opts.userId}::text)
     )
    WHERE e.organization_id = ${opts.organizationId}
      AND t.user_id = ${opts.userId}
      AND (${cursor}::bigint IS NULL OR e.id < ${cursor})
      AND (${!unreadOnly} OR t.read_at IS NULL)
			${clientIds
				? sql`AND e.client_id = ANY(${pgTextArray(clientIds)}::text[])`
				: sql``}
			${mcpActivityId
				? sql`AND COALESCE(
					e.metadata->>'mcp_conversation_id',
					e.metadata->>'mcp_session_id'
				) = ${mcpActivityId}`
				: sql``}
    -- Order strictly by e.id so the (e.id < cursor) keyset pagination is
    -- consistent. delivered_at would tie-break for concurrent inserts but
    -- doesn't match the cursor — using it as the primary key risked
    -- skipping notifications when delivered_at and e.id disagreed.
    ORDER BY e.id DESC
    LIMIT ${limit + 1}
  `) as unknown as Array<{ id: number } & Record<string, unknown>>;

	const hasMore = rows.length > limit;
	const notifications = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore
		? (notifications[notifications.length - 1]?.id ?? null)
		: null;

	return { notifications, nextCursor };
}

export async function getUnreadCount(
	organizationId: string,
	userId: string,
): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
    SELECT COUNT(*)::int AS count
    FROM notification_targets t
    JOIN events e ON e.id = t.event_id
    WHERE e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
  `) as unknown as Array<{ count: number }>;
	return rows[0].count;
}

export async function markAsRead(
	organizationId: string,
	userId: string,
	notificationId: number,
): Promise<boolean> {
	const sql = getDb();
	const rows = (await sql`
    UPDATE notification_targets t
    SET read_at = now()
    FROM events e
    WHERE t.event_id = e.id
      AND e.id = ${notificationId}
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
	return rows.length > 0;
}

export async function markAllAsRead(
	organizationId: string,
	userId: string,
): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
    UPDATE notification_targets t
    SET read_at = now()
    FROM events e
    WHERE t.event_id = e.id
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
	return rows.length;
}

/**
 * "Deleting" a notification is a per-user concern — the event stays in the
 * org-wide knowledge stream. We just drop the target row so it disappears
 * from this user's inbox.
 */
export async function deleteNotification(
	organizationId: string,
	userId: string,
	notificationId: number,
): Promise<boolean> {
	const sql = getDb();
	const rows = (await sql`
    DELETE FROM notification_targets t
    USING events e
    WHERE t.event_id = e.id
      AND e.id = ${notificationId}
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
	return rows.length > 0;
}
