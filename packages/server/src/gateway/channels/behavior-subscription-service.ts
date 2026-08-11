import { createLogger } from "@lobu/core";
import type { BehaviorEventTrigger } from "@lobu/core/contracts/tools/manage-behaviors";
import {
	type DbClient,
	getDb,
	pgBigintArray,
	tsTime,
} from "../../db/client.js";
import { runtimeConnectionIdToSlug } from "../../lobu/stores/connections-projection.js";
import { requireOrgId } from "../../lobu/stores/org-context.js";
import { getNextNumericId } from "../../tools/admin/helpers/db-helpers.js";
import {
	resolveStreamingChannelFeedId,
	softDeleteStreamingChannelFeed,
} from "./channel-feed.js";

const logger = createLogger("behavior-channel-subscriptions");
const CHAT_LINK_TAG = "system:chat-link";
const CHAT_LINK_PROMPT = "Respond helpfully to the incoming message.";

/**
 * Routing projection of an active Behavior event trigger. It carries no state
 * separate from the Behavior itself.
 */
interface ChatBehaviorSubscription {
	platform: string;
	channelId: string;
	agentId: string;
	teamId?: string;
	organizationId?: string;
	connectionId?: string;
	model?: string;
	createdAt: number;
}

function rowToSubscription(
	row: Record<string, unknown>,
): ChatBehaviorSubscription {
	return {
		platform: String(row.platform),
		channelId: String(row.channel_id),
		agentId: String(row.agent_id),
		teamId: typeof row.team_id === "string" ? row.team_id : undefined,
		organizationId:
			typeof row.organization_id === "string" ? row.organization_id : undefined,
		connectionId:
			row.connection_id != null ? String(row.connection_id) : undefined,
		model:
			typeof row.model === "string" && row.model.trim()
				? row.model.trim()
				: undefined,
		createdAt: tsTime(row.created_at),
	};
}

function nativeChannelId(platform: string, channelId: string): string {
	const prefix = `${platform}:`;
	return channelId.startsWith(prefix)
		? channelId.slice(prefix.length)
		: channelId;
}

function nativeChannelIdFromAny(channelId: string): string {
	const separator = channelId.indexOf(":");
	return separator >= 0 ? channelId.slice(separator + 1) : channelId;
}

function eventTrigger(args: {
	platform: string;
	connectionId: number;
	channelId: string;
	teamId?: string;
}): BehaviorEventTrigger {
	return {
		kind: "event",
		source: "connector",
		connector_key: args.platform,
		connection_id: args.connectionId,
		event_types: ["message.created"],
		match: {
			channel_id: nativeChannelId(args.platform, args.channelId),
			...(args.teamId ? { team_id: args.teamId } : {}),
		},
		execution: "turn",
		active_run: "steer",
		output: "reply_to_source",
		skip_if_unchanged: false,
	};
}

async function resolveCreatedBy(
	sql: DbClient,
	organizationId: string,
	agentId: string,
	configuredBy?: string,
): Promise<string> {
	const rows = await sql<{ id: string }>`
		SELECT candidate.id
		FROM (
			SELECT u.id, 0 AS priority
			FROM "user" u
			WHERE u.id = ${configuredBy ?? null}
			  AND EXISTS (
				SELECT 1 FROM member m
				WHERE m."organizationId" = ${organizationId}
				  AND m."userId" = u.id
			  )
			UNION ALL
			SELECT u.id, 1 AS priority
			FROM agents a
			JOIN "user" u ON u.id = a.owner_user_id
			WHERE a.organization_id = ${organizationId}
			  AND a.id = ${agentId}
			  AND a.owner_user_id IS NOT NULL
			UNION ALL
			SELECT u.id, 2 AS priority
			FROM member m
			JOIN "user" u ON u.id = m."userId"
			WHERE m."organizationId" = ${organizationId}
			UNION ALL
			-- Member-less orgs (preview claim, headless deploy): attribute to the
			-- configuring user even when they are not yet a member row, so
			-- /lobu link does not hard-fail.
			SELECT u.id, 3 AS priority
			FROM "user" u
			WHERE u.id = ${configuredBy ?? null}
		) candidate
		ORDER BY candidate.priority, candidate.id
		LIMIT 1
	`;
	const userId = rows[0]?.id;
	if (!userId) {
		throw new Error(
			`Cannot create a chat Behavior for organization ${organizationId}: no user available to attribute created_by.`,
		);
	}
	return userId;
}

async function hasChannelSubscription(
	sql: DbClient,
	connectionId: string,
	channelId: string,
): Promise<boolean> {
	return (
		(
			await loadChatBehaviorSubscriptions(sql, {
				connectionId,
				channelId,
				limit: 1,
			})
		).length > 0
	);
}

async function loadChatBehaviorSubscriptions(
	sql: DbClient,
	filters: {
		behaviorOrganizationId?: string;
		agentId?: string;
		connectionId?: string;
		connectionOrganizationId?: string;
		connectionSlug?: string;
		channelId?: string;
		limit?: number;
		oldestFirst?: boolean;
	},
): Promise<ChatBehaviorSubscription[]> {
	const native = filters.channelId
		? nativeChannelIdFromAny(filters.channelId)
		: null;
	const behaviorOrgFilter = filters.behaviorOrganizationId
		? sql`AND s.organization_id = ${filters.behaviorOrganizationId}`
		: sql``;
	const agentFilter = filters.agentId
		? sql`AND s.agent_id = ${filters.agentId}`
		: sql``;
	const connectionIdFilter = filters.connectionId
		? sql`AND s.connection_id = ${filters.connectionId}::bigint`
		: sql``;
	const connectionOrgFilter = filters.connectionOrganizationId
		? sql`AND s.connection_organization_id = ${filters.connectionOrganizationId}`
		: sql``;
	const connectionSlugFilter = filters.connectionSlug
		? sql`AND s.connection_slug = ${filters.connectionSlug}`
		: sql``;
	const channelFilter = filters.channelId
		? sql`AND (
			s.channel_id = ${filters.channelId}
			OR s.native_channel_id = ${native}
		)`
		: sql``;
	const limit = filters.limit ? sql`LIMIT ${filters.limit}` : sql``;
	// Prefer system:chat-link Behaviors over other message.created Behaviors
	// that share the same channel (digests, recorders). Slash/button routing and
	// resolveForConnection take LIMIT 1 — without the chat-link preference, a
	// background Behavior with a newer updated_at steals the interaction.
	// Tie-break: newest update, then stable behavior_id.
	const order = filters.oldestFirst
		? sql`
			CASE WHEN w.tags @> ARRAY[${CHAT_LINK_TAG}]::text[] THEN 0 ELSE 1 END ASC,
			s.created_at ASC,
			s.behavior_id ASC
		`
		: sql`
			CASE WHEN w.tags @> ARRAY[${CHAT_LINK_TAG}]::text[] THEN 0 ELSE 1 END ASC,
			s.updated_at DESC,
			s.behavior_id DESC
		`;
	const rows = await sql`
		SELECT s.*
		FROM behavior_message_subscriptions s
		JOIN watchers w ON w.id = s.behavior_id
		WHERE true
		  ${behaviorOrgFilter}
		  ${agentFilter}
		  ${connectionIdFilter}
		  ${connectionOrgFilter}
		  ${connectionSlugFilter}
		  ${channelFilter}
		ORDER BY ${order}
		${limit}
	`;
	return rows.map(rowToSubscription);
}

/**
 * Chat/preview adapter over canonical Behaviors. Reads project from the
 * `behavior_message_subscriptions` view and writes create/update/archive a
 * tagged Behavior. Behaviors are the only source of truth — no dual-write
 * to a legacy bindings table.
 */
export class BehaviorSubscriptionService {
	async resolveForConnection(
		connectionId: string,
		channelId: string,
		connectionOrganizationId: string,
		crossOrg = false,
	): Promise<ChatBehaviorSubscription | null> {
		const sql = getDb();
		const rows = await loadChatBehaviorSubscriptions(sql, {
			behaviorOrganizationId: crossOrg ? undefined : connectionOrganizationId,
			connectionOrganizationId,
			connectionSlug: runtimeConnectionIdToSlug(connectionId),
			channelId,
			limit: 1,
		});
		return rows[0] ?? null;
	}

	/**
	 * True when any active message.created Behavior covers this connection+channel
	 * (ignoring trigger match filters like mention_only/team). Used by the chat
	 * bridge to distinguish "filters rejected a linked channel" from "channel is
	 * unlinked" so we do not spam the "link your agent" notice on every
	 * non-mention in a mention_only channel.
	 */
	async channelHasMessageSubscription(
		connectionId: string,
		channelId: string,
		connectionOrganizationId: string,
		crossOrg = false,
	): Promise<boolean> {
		const sql = getDb();
		const rows = await loadChatBehaviorSubscriptions(sql, {
			behaviorOrganizationId: crossOrg ? undefined : connectionOrganizationId,
			connectionOrganizationId,
			connectionSlug: runtimeConnectionIdToSlug(connectionId),
			channelId,
			limit: 1,
		});
		return rows.length > 0;
	}

	async healSubscriptionTeam(
		connectionId: string,
		channelId: string,
		organizationId: string,
		realTeamId: string,
	): Promise<void> {
		if (!realTeamId.trim()) return;
		const sql = getDb();
		const slug = runtimeConnectionIdToSlug(connectionId);
		const native = nativeChannelId("slack", channelId);
		await sql`
			UPDATE watchers w
			SET triggers = (
				SELECT jsonb_agg(
					CASE
						WHEN trigger->>'kind' = 'event'
						 AND trigger->>'connector_key' = c.connector_key
						 AND c.id = CASE
							WHEN jsonb_typeof(trigger->'connection_id') = 'number'
								THEN (trigger->>'connection_id')::bigint
							ELSE NULL
						 END
						 AND trigger->'match'->>'channel_id' = ${native}
						 AND COALESCE(trigger->'match'->>'team_id', '') = ''
							THEN jsonb_set(
								trigger,
								'{match,team_id}',
								to_jsonb(${realTeamId}::text),
								true
							)
						ELSE trigger
					END
					ORDER BY ordinal
				)
				FROM jsonb_array_elements(w.triggers)
					WITH ORDINALITY AS item(trigger, ordinal)
			),
			updated_at = current_timestamp
			FROM connections c
			WHERE w.organization_id = ${organizationId}
			  AND w.status = 'active'
			  AND w.tags @> ARRAY[${CHAT_LINK_TAG}]::text[]
			  AND c.slug = ${slug}
			  AND c.connector_key = 'slack'
			  AND c.deleted_at IS NULL
			  AND EXISTS (
				SELECT 1
				FROM jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) existing
				WHERE existing->>'kind' = 'event'
				  AND existing->>'connector_key' = c.connector_key
				  AND jsonb_typeof(existing->'connection_id') = 'number'
				  AND (existing->>'connection_id')::bigint = c.id
				  AND existing->'event_types' ? 'message.created'
				  AND existing->'match'->>'channel_id' = ${native}
				  AND COALESCE(existing->'match'->>'team_id', '') = ''
			  )
		`;
	}

	/**
	 * Materialize the chat-link Behavior after a group message routes through the
	 * connection-owner fallback. Returns false when the active, org-scoped chat
	 * connection cannot be resolved. createChatBehavior serializes concurrent
	 * attempts for the same connection and channel.
	 */
	async materializeConnectionFallbackLink(
		connectionId: string,
		organizationId: string,
		agentId: string,
		platform: string,
		channelId: string,
		teamId: string | undefined,
	): Promise<boolean> {
		const sql = getDb();
		const slug = runtimeConnectionIdToSlug(connectionId);
		const rows = (await sql`
			SELECT id
			FROM connections
			WHERE slug = ${slug}
			  AND organization_id = ${organizationId}
			  AND connector_key = ${platform}
			  AND credential_mode IS NOT NULL
			  AND status = 'active'
			  AND deleted_at IS NULL
			LIMIT 1
		`) as Array<{ id: number | string }>;
		const numericId = rows[0] ? Number(rows[0].id) : NaN;
		if (!Number.isInteger(numericId) || numericId < 1) return false;
		// create-only: never overwrite an explicit link that a concurrent
		// `/lobu link` may have committed — the check happens under the advisory
		// lock inside createChatBehavior, so it is race-safe across replicas.
		await this.createChatBehavior(agentId, platform, channelId, teamId, {
			organizationId,
			connectionId: numericId,
			createOnly: true,
		});
		return true;
	}

	async createChatBehavior(
		agentId: string,
		platform: string,
		channelId: string,
		teamId: string | undefined,
		options: {
			configuredBy?: string;
			organizationId?: string;
			sql?: DbClient;
			connectionId: number;
			model?: string;
			/**
			 * Create-only: when a chat-link already covers this connection+channel,
			 * preserve it and return instead of relinking it to `agentId`. Used by
			 * the connection-owner fallback so it can never overwrite an explicit
			 * `/lobu link` that committed between the caller's check and this write
			 * — the decision is made under the advisory lock, so it holds across
			 * replicas. Explicit link/relink flows omit it and keep relinking.
			 */
			createOnly?: boolean;
		},
	): Promise<void> {
		if (!Number.isInteger(options.connectionId) || options.connectionId < 1) {
			throw new Error("connectionId must be a positive integer");
		}
		const sql = options.sql ?? getDb();
		const organizationId = requireOrgId(
			options.organizationId,
			"BehaviorSubscriptionService.createChatBehavior",
		);
		const model = options.model?.trim() || null;
		const trigger = eventTrigger({
			platform,
			connectionId: options.connectionId,
			channelId,
			teamId,
		});

		const write = async (tx: DbClient): Promise<void> => {
			// Serialize concurrent create/relink for the same org+connection+channel.
			await tx`
				SELECT pg_advisory_xact_lock(
					hashtext('behavior_chat_link'),
					hashtext(${`${organizationId}:${options.connectionId}:${channelId}`})
				)
			`;
			const connectionRows = await tx`
				SELECT 1
				FROM connections
				WHERE id = ${options.connectionId}
				  AND connector_key = ${platform}
				  AND deleted_at IS NULL
				LIMIT 1
			`;
			if (connectionRows.length === 0) {
				throw new Error(
					`Connection ${options.connectionId} is not an active ${platform} connection.`,
				);
			}

			const existing = await tx<{ behavior_id: number }>`
				SELECT w.id AS behavior_id
				FROM watchers w
				CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
				WHERE w.status = 'active'
				  AND w.organization_id = ${organizationId}
				  AND trigger->>'kind' = 'event'
				  AND trigger->>'connector_key' = ${platform}
				  AND jsonb_typeof(trigger->'connection_id') = 'number'
				  AND (trigger->>'connection_id')::bigint = ${options.connectionId}
				  AND trigger->'event_types' ? 'message.created'
				  AND trigger->'match'->>'channel_id' = ${nativeChannelId(platform, channelId)}
				  AND w.tags @> ARRAY[${CHAT_LINK_TAG}]::text[]
				ORDER BY w.updated_at DESC, w.id DESC
				LIMIT 1
				FOR UPDATE OF w
			`;
			if (existing[0]) {
				// A chat-link already covers this connection+channel. Under
				// create-only (the connection-owner fallback), leave it untouched —
				// this is where a racing explicit `/lobu link` is preserved.
				if (options.createOnly) return;
				// Relink must not wipe user-added triggers (schedule, extra events)
				// on the same Behavior — only replace the chat message.created
				// trigger for this connection+channel.
				const [row] = await tx<{ triggers: unknown }>`
					SELECT triggers FROM watchers WHERE id = ${existing[0].behavior_id}
				`;
				const prev = Array.isArray(row?.triggers) ? row.triggers : [];
				const native = nativeChannelId(platform, channelId);
				const kept = prev.filter((candidate) => {
					if (!candidate || typeof candidate !== "object") return true;
					const t = candidate as Record<string, unknown>;
					if (t.kind !== "event") return true;
					if (t.connector_key !== platform) return true;
					if (Number(t.connection_id) !== options.connectionId) return true;
					const eventTypes = t.event_types;
					if (
						!Array.isArray(eventTypes) ||
						!eventTypes.includes("message.created")
					) {
						return true;
					}
					const match =
						t.match && typeof t.match === "object"
							? (t.match as Record<string, unknown>)
							: null;
					if (match?.channel_id !== native) return true;
					return false;
				});
				await tx`
					UPDATE watchers
					SET agent_id = ${agentId},
						triggers = ${tx.json([...kept, trigger])},
						execution_config = CASE
							WHEN ${model}::text IS NULL
								THEN NULLIF(COALESCE(execution_config, '{}'::jsonb) - 'model', '{}'::jsonb)
							ELSE COALESCE(execution_config, '{}'::jsonb) || jsonb_build_object('model', ${model}::text)
						END,
						updated_at = current_timestamp
					WHERE id = ${existing[0].behavior_id}
				`;
				return;
			}

			const createdBy = await resolveCreatedBy(
				tx,
				organizationId,
				agentId,
				options.configuredBy,
			);
			const watcherId = await getNextNumericId(tx, "watchers");
			const versionId = await getNextNumericId(tx, "watcher_versions");
			await tx`
				INSERT INTO watchers (
					id, name, slug, description, organization_id, entity_ids,
					schedule, next_run_at, triggers, agent_id, model_config,
					execution_config, sources, version, current_version_id, tags,
					status, created_by, created_at, updated_at, watcher_group_id
				) VALUES (
					${watcherId}, ${`Messages in ${channelId}`}, ${`chat-${platform}-${watcherId}`},
					'Chat subscription', ${organizationId}, '{}'::bigint[],
					NULL, NULL, ${tx.json([trigger])}, ${agentId}, '{}'::jsonb,
					${model ? tx.json({ model }) : null}, '[]'::jsonb, 1, NULL,
					ARRAY[${CHAT_LINK_TAG}]::text[], 'active', ${createdBy},
					current_timestamp, current_timestamp, ${watcherId}
				)
			`;
			await tx`
				INSERT INTO watcher_versions (
					id, watcher_id, version, name, description, prompt,
					version_sources, change_notes, created_by, created_at
				) VALUES (
					${versionId}, ${watcherId}, 1, ${`Messages in ${channelId}`},
					'Chat subscription', ${CHAT_LINK_PROMPT}, '[]'::jsonb,
					'Created from chat link', ${createdBy}, current_timestamp
				)
			`;
			await tx`
				UPDATE watchers SET current_version_id = ${versionId}
				WHERE id = ${watcherId}
			`;
		};
		if (options.sql) await write(sql);
		else await sql.begin(write);

		await resolveStreamingChannelFeedId({
			connectionId: String(options.connectionId),
			organizationId,
			channelKey: `${platform}:${nativeChannelId(platform, channelId)}`,
			sql,
		});
		logger.info(`Created chat Behavior: ${platform}/${channelId} → ${agentId}`);
	}

	async archiveChatBehavior(
		agentId: string,
		channelId: string,
		connectionId: number,
		organizationId: string,
		options?: { sql?: DbClient },
	): Promise<boolean> {
		const sql = options?.sql ?? getDb();
		const orgId = requireOrgId(
			organizationId,
			"BehaviorSubscriptionService.archiveChatBehavior",
		);
		const write = async (tx: DbClient): Promise<boolean> => {
			const rows = await tx<{ id: number; platform: string }>`
				SELECT w.id, trigger->>'connector_key' AS platform
				FROM watchers w
				CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
				WHERE w.status = 'active'
				  AND w.organization_id = ${orgId}
				  AND w.agent_id = ${agentId}
				  AND trigger->>'kind' = 'event'
				  AND jsonb_typeof(trigger->'connection_id') = 'number'
				  AND (trigger->>'connection_id')::bigint = ${connectionId}
				  AND trigger->'event_types' ? 'message.created'
				  AND trigger->'match'->>'channel_id' = ${nativeChannelIdFromAny(channelId)}
				  AND w.tags @> ARRAY[${CHAT_LINK_TAG}]::text[]
				FOR UPDATE OF w
			`;
			const archived = rows[0];
			if (!archived) return false;
			await tx`
				UPDATE watchers
				SET status = 'archived', updated_at = current_timestamp
				WHERE id = ANY(${pgBigintArray(rows.map((row) => row.id))}::bigint[])
			`;
			const native = nativeChannelIdFromAny(channelId);
			const canonicalChannelId = `${archived.platform}:${native}`;
			if (
				!(await hasChannelSubscription(
					tx,
					String(connectionId),
					canonicalChannelId,
				))
			) {
				await softDeleteStreamingChannelFeed({
					connectionId: String(connectionId),
					channelKey: canonicalChannelId,
					sql: tx,
				});
			}
			return true;
		};
		return options?.sql ? write(sql) : sql.begin(write);
	}

	async listChatBehaviors(
		agentId: string,
		organizationId: string,
	): Promise<ChatBehaviorSubscription[]> {
		const sql = getDb();
		const orgId = requireOrgId(
			organizationId,
			"BehaviorSubscriptionService.listChatBehaviors",
		);
		return loadChatBehaviorSubscriptions(sql, {
			behaviorOrganizationId: orgId,
			agentId,
			oldestFirst: true,
		});
	}

	async archiveAllChatBehaviors(
		agentId: string,
		organizationId: string,
	): Promise<number> {
		const sql = getDb();
		const orgId = requireOrgId(
			organizationId,
			"BehaviorSubscriptionService.archiveAllChatBehaviors",
		);
		return sql.begin(async (tx) => {
			const rows = await tx<{
				behavior_id: number;
				connection_id: string;
				channel_id: string;
			}>`
				SELECT
					w.id AS behavior_id,
					(trigger->>'connection_id')::text AS connection_id,
					COALESCE(
						NULLIF(trigger->'match'->>'channel_key', ''),
						(trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
					) AS channel_id
				FROM watchers w
				CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
				WHERE w.status = 'active'
				  AND w.organization_id = ${orgId}
				  AND w.agent_id = ${agentId}
				  AND trigger->>'kind' = 'event'
				  AND jsonb_typeof(trigger->'connection_id') = 'number'
				  AND trigger->'event_types' ? 'message.created'
				  AND trigger->'match'->>'channel_id' IS NOT NULL
				  AND w.tags @> ARRAY[${CHAT_LINK_TAG}]::text[]
				FOR UPDATE OF w
			`;
			if (rows.length > 0) {
				await tx`
					UPDATE watchers
					SET status = 'archived', updated_at = current_timestamp
					WHERE id = ANY(${pgBigintArray(rows.map((row) => row.behavior_id))}::bigint[])
				`;
			}
			for (const row of rows) {
				if (
					!(await hasChannelSubscription(tx, row.connection_id, row.channel_id))
				) {
					await softDeleteStreamingChannelFeed({
						connectionId: row.connection_id,
						channelKey: row.channel_id,
						sql: tx,
					});
				}
			}
			return rows.length;
		});
	}
}
