import type { CardElement } from "chat";
import { getDb, pgTextArray } from "../db/client";
import { resolveBoundChannelRows } from "../gateway/channels/bound-channels";
import { getChatInstanceManager, isLobuGatewayRunning } from "../lobu/gateway";
import logger from "../utils/logger";

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
	/** When set, deliver only through this specific bot connection */
	connectionId?: string | null;
	/** When set, deliver only to this channel binding. */
	channelId?: string | null;
	/** Optional workspace/team guard for channel-scoped delivery. */
	teamId?: string | null;
	/**
	 * Lobu user who owns the change under review (field-change approvals).
	 * When set, bot delivery tries the owner's Slack DM FIRST — resolved via
	 * chat_user_identities against a connected workspace — and only falls back
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
}

/**
 * Forward a notification to the org's active chat-bot connections so it lands
 * in the bound channel — e.g. a watcher digest posting to #leads.
 *
 * Resolves connections + their channel bindings straight from Postgres and
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
	/** Workspace/team id from the binding — keys the owner-DM identity lookup. */
	teamId: string | null;
}

/**
 * Resolve where a notification should be posted.
 *
 * Two branches, UNIONed:
 *
 *   (A) The org's OWN active chat connections JOINed to their channel bindings,
 *       scoped to (org, agent) — the multi-tenant default. A connection with no
 *       binding has no target; a connection bound to several channels yields one
 *       target each.
 *
 *   (B) Hosted-preview cross-org delivery. The hosted preview bot is ONE
 *       connection living in its OWN org under a placeholder agent, that fans
 *       out to agents across MANY orgs — a `/lobu link <code>` writes the
 *       binding under the claim's org, never the connection's. So branch (A)'s
 *       `(org, agent)` JOIN misses it on BOTH columns and proactive
 *       notifications silently drop. This branch resolves the org's bindings
 *       through the shared preview connection, mirroring the inbound
 *       concrete-connection routing. It is gated HARD to previewMode
 *       connections with no `metadata.teamId` (the hosted-bot invariant, same as
 *       `getDefaultConnection`) and is NOT joined on `agent_id`, so a normal
 *       tenant bot can never be used to deliver cross-org.
 *
 * Single-workspace assumption: with exactly one hosted preview connection per
 * platform today, (B) matches on platform alone. When a second hosted workspace
 * appears, persist its Slack team id (e.g. `settings.hostedWorkspaceTeamId`) and
 * add `AND ac.settings->>'hostedWorkspaceTeamId' = b.team_id` so a binding only
 * resolves the connection actually installed in its workspace (Slack channel ids
 * are workspace-scoped, not global).
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
 * chat_user_identities (platform='slack', team matching the connection's
 * binding team) per candidate connection, most-recently-bound first via
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
	const sql = getDb();
	const seen = new Set<string>();
	for (const target of targets) {
		if (target.platform !== "slack" || target.teamId == null) continue;
		const key = `${target.connectionId}:${target.teamId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const rows = await sql<{ platform_user_id: string }>`
      SELECT platform_user_id FROM chat_user_identities
      WHERE platform = 'slack'
        AND team_id = ${target.teamId}
        AND lobu_user_id = ${ownerUserId}
      LIMIT 1
    `;
		if (rows[0]?.platform_user_id) {
			return {
				connectionId: target.connectionId,
				slackUserId: rows[0].platform_user_id,
			};
		}
	}
	return null;
}

async function deliverToBotConnections(
	params: Omit<CreateNotificationParams, "userId">,
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
				await manager.postDirectMessage(dm.connectionId, dm.slackUserId, content);
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

		await Promise.allSettled(
			targets.map(async ({ connectionId, channelKey }) => {
				try {
					await manager.postMessageToChannel(connectionId, channelKey, content);
				} catch (err) {
					logger.warn(
						{ err, connectionId, channelKey },
						"[Notifications] Failed to post to bot connection channel",
					);
				}
			}),
		);
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
): Promise<void> {
	if (userIds.length === 0) return;
	const sql = getDb();

	// fetch_types:false safe: entity_ids is a `{n,...}` literal (or NULL) cast to
	// bigint[] — never a raw JS array bind. Same pattern as insert-event.ts.
	const entityIdsValue =
		params.entityIds && params.entityIds.length > 0
			? `{${params.entityIds.join(",")}}`
			: null;

	await sql.begin(async (tx) => {
		const inserted = (await tx`
      INSERT INTO events
        (organization_id, entity_ids, title, payload_text, payload_type, semantic_type,
         occurred_at, metadata)
      VALUES (
        ${params.organizationId},
        ${entityIdsValue}::bigint[],
        ${params.title},
        ${params.body ?? null},
        'text',
        'notification',
        now(),
        ${sql.json({
					notification_type: params.type,
					resource_type: params.resourceType ?? null,
					resource_id: params.resourceId ?? null,
					resource_url: params.resourceUrl ?? null,
				})}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const eventId = inserted[0]?.id;
		if (!eventId) return;

		await tx`
      INSERT INTO notification_targets (event_id, user_id)
      SELECT ${eventId}, uid
      FROM unnest(${pgTextArray(userIds)}::text[]) AS u(uid)
      ON CONFLICT DO NOTHING
    `;
	});

	// Deliver to bot connections (fire-and-forget). The bot delivery targets
	// the org's connection default channels and is identical for every user in
	// this call, so fan it out once — not once per user.
	deliverToBotConnections(params).catch((err) =>
		logger.warn(
			{ err },
			"[Notifications] Failed to deliver to bot connections",
		),
	);
}

export async function listNotifications(opts: {
	organizationId: string;
	userId: string;
	cursor?: number | null;
	limit?: number;
	unreadOnly?: boolean;
}): Promise<{
	notifications: Record<string, unknown>[];
	nextCursor: number | null;
}> {
	const sql = getDb();
	const limit = Math.min(opts.limit ?? 20, 50);
	const cursor = opts.cursor ?? null;
	const unreadOnly = opts.unreadOnly ?? false;

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
      (t.read_at IS NOT NULL) AS is_read,
      t.delivered_at AS created_at
    FROM notification_targets t
    JOIN events e ON e.id = t.event_id
    WHERE e.organization_id = ${opts.organizationId}
      AND t.user_id = ${opts.userId}
      AND (${cursor}::bigint IS NULL OR e.id < ${cursor})
      AND (${!unreadOnly} OR t.read_at IS NULL)
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
