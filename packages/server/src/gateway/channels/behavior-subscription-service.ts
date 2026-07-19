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
		) candidate
		ORDER BY candidate.priority, candidate.id
		LIMIT 1
	`;
	const userId = rows[0]?.id;
	if (!userId) {
		throw new Error(
			`Cannot create a chat Behavior for organization ${organizationId}: no member user exists.`,
		);
	}
	return userId;
}

async function hasChannelSubscription(
	sql: DbClient,
	connectionId: string,
	channelId: string,
): Promise<boolean> {
	const rows = await sql`
		SELECT 1
		FROM watchers w
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
		JOIN connections c
		  ON c.id = CASE
			WHEN jsonb_typeof(trigger->'connection_id') = 'number'
				THEN (trigger->>'connection_id')::bigint
			ELSE NULL
		  END
		 AND c.connector_key = trigger->>'connector_key'
		 AND c.deleted_at IS NULL
		WHERE w.status = 'active'
		  AND trigger->>'kind' = 'event'
		  AND jsonb_typeof(trigger->'connection_id') = 'number'
		  AND trigger->'event_types' ? 'message.created'
		  AND jsonb_typeof(trigger->'match') = 'object'
		  AND c.id = ${connectionId}::bigint
		  AND COALESCE(
			NULLIF(trigger->'match'->>'channel_key', ''),
			(trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
		  ) = ${channelId}
		LIMIT 1
	`;
	return rows.length > 0;
}

/**
 * Chat/preview adapter over canonical Behaviors. Every read projects active
 * triggers and every write creates, updates, or archives a tagged Behavior.
 */
export class BehaviorSubscriptionService {
	async resolveForConnection(
		connectionId: string,
		channelId: string,
		connectionOrganizationId: string,
		crossOrg = false,
	): Promise<ChatBehaviorSubscription | null> {
		const sql = getDb();
		const slug = runtimeConnectionIdToSlug(connectionId);
		const native = nativeChannelIdFromAny(channelId);
		const rows = crossOrg
			? await sql`
				SELECT s.*
				FROM (
					SELECT
						w.id AS behavior_id,
						w.organization_id,
						w.agent_id,
						trigger->>'connector_key' AS platform,
						COALESCE(
							NULLIF(trigger->'match'->>'channel_key', ''),
							(trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
						) AS channel_id,
						COALESCE(
							NULLIF(trigger->'match'->>'team_id', ''),
							c.external_tenant_id,
							c.config->'chatMetadata'->>'teamId'
						) AS team_id,
						c.id AS connection_id,
						NULLIF(w.execution_config->>'model', '') AS model,
						w.created_at,
						w.updated_at
					FROM watchers w
					CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
					JOIN connections c
					  ON c.id = CASE
						WHEN jsonb_typeof(trigger->'connection_id') = 'number'
							THEN (trigger->>'connection_id')::bigint
						ELSE NULL
					  END
					 AND c.connector_key = trigger->>'connector_key'
					 AND c.deleted_at IS NULL
					WHERE w.status = 'active'
					  AND trigger->>'kind' = 'event'
					  AND jsonb_typeof(trigger->'connection_id') = 'number'
					  AND trigger->'event_types' ? 'message.created'
					  AND jsonb_typeof(trigger->'match') = 'object'
					  AND NULLIF(trigger->'match'->>'channel_id', '') IS NOT NULL
				) s
				JOIN connections c ON c.id = s.connection_id
				WHERE c.organization_id = ${connectionOrganizationId}
				  AND c.slug = ${slug}
				  AND c.deleted_at IS NULL
				  AND (
					s.channel_id = ${channelId}
					OR split_part(s.channel_id, ':', 2) = ${native}
				  )
				ORDER BY s.updated_at DESC, s.behavior_id DESC
				LIMIT 1
			`
			: await sql`
				SELECT s.*
				FROM (
					SELECT
						w.id AS behavior_id,
						w.organization_id,
						w.agent_id,
						trigger->>'connector_key' AS platform,
						COALESCE(
							NULLIF(trigger->'match'->>'channel_key', ''),
							(trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
						) AS channel_id,
						COALESCE(
							NULLIF(trigger->'match'->>'team_id', ''),
							c.external_tenant_id,
							c.config->'chatMetadata'->>'teamId'
						) AS team_id,
						c.id AS connection_id,
						NULLIF(w.execution_config->>'model', '') AS model,
						w.created_at,
						w.updated_at
					FROM watchers w
					CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
					JOIN connections c
					  ON c.id = CASE
						WHEN jsonb_typeof(trigger->'connection_id') = 'number'
							THEN (trigger->>'connection_id')::bigint
						ELSE NULL
					  END
					 AND c.connector_key = trigger->>'connector_key'
					 AND c.deleted_at IS NULL
					WHERE w.status = 'active'
					  AND trigger->>'kind' = 'event'
					  AND jsonb_typeof(trigger->'connection_id') = 'number'
					  AND trigger->'event_types' ? 'message.created'
					  AND jsonb_typeof(trigger->'match') = 'object'
					  AND NULLIF(trigger->'match'->>'channel_id', '') IS NOT NULL
				) s
				JOIN connections c ON c.id = s.connection_id
				WHERE c.organization_id = ${connectionOrganizationId}
				  AND c.slug = ${slug}
				  AND c.deleted_at IS NULL
				  AND s.organization_id = ${connectionOrganizationId}
				  AND (
					s.channel_id = ${channelId}
					OR split_part(s.channel_id, ':', 2) = ${native}
				  )
				ORDER BY s.updated_at DESC, s.behavior_id DESC
				LIMIT 1
			`;
		return rows[0] ? rowToSubscription(rows[0]) : null;
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
				await tx`
					UPDATE watchers
					SET agent_id = ${agentId},
						triggers = ${tx.json([trigger])},
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

			const canonicalChannelId = `${archived.platform}:${nativeChannelIdFromAny(channelId)}`;
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
		const rows = await sql`
			SELECT *
			FROM (
				SELECT
					w.id AS behavior_id,
					w.organization_id,
					w.agent_id,
					trigger->>'connector_key' AS platform,
					COALESCE(
						NULLIF(trigger->'match'->>'channel_key', ''),
						(trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
					) AS channel_id,
					COALESCE(
						NULLIF(trigger->'match'->>'team_id', ''),
						c.external_tenant_id,
						c.config->'chatMetadata'->>'teamId'
					) AS team_id,
					c.id AS connection_id,
					NULLIF(w.execution_config->>'model', '') AS model,
					w.created_at,
					w.updated_at
				FROM watchers w
				CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
				JOIN connections c
				  ON c.id = CASE
					WHEN jsonb_typeof(trigger->'connection_id') = 'number'
						THEN (trigger->>'connection_id')::bigint
					ELSE NULL
				  END
				 AND c.connector_key = trigger->>'connector_key'
				 AND c.deleted_at IS NULL
				WHERE w.status = 'active'
				  AND trigger->>'kind' = 'event'
				  AND jsonb_typeof(trigger->'connection_id') = 'number'
				  AND trigger->'event_types' ? 'message.created'
				  AND jsonb_typeof(trigger->'match') = 'object'
				  AND NULLIF(trigger->'match'->>'channel_id', '') IS NOT NULL
			) s
			WHERE s.agent_id = ${agentId}
			  AND s.organization_id = ${orgId}
			ORDER BY created_at, behavior_id
		`;
		return rows.map(rowToSubscription);
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
					!(await hasChannelSubscription(
						tx,
						row.connection_id,
						row.channel_id,
					))
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
