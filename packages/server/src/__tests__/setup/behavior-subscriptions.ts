import { getTestDb } from "./test-db";

export async function createTestBehaviorSubscription(opts: {
	organizationId: string;
	agentId: string;
	connectionId?: number;
	connectionSlug?: string;
	platform?: string;
	channelId: string;
	teamId?: string;
	model?: string;
	configuredBy?: string;
}): Promise<void> {
	const sql = getTestDb();
	const rows = await sql<{ id: number; connector_key: string }>`
		SELECT id, connector_key
		FROM connections
		WHERE ${
			opts.connectionId == null && !opts.connectionSlug
				? sql`organization_id = ${opts.organizationId}`
				: sql`TRUE`
		}
		  ${opts.connectionId != null ? sql`AND id = ${opts.connectionId}` : sql``}
		  ${opts.connectionSlug ? sql`AND slug = ${opts.connectionSlug}` : sql``}
		  AND deleted_at IS NULL
		LIMIT 1
	`;
	const connection = rows[0];
	if (!connection) throw new Error("Test chat connection was not found");
	const creators = await sql<{ id: string }>`
		SELECT COALESCE(
			${opts.configuredBy ?? null}::text,
			(
				SELECT a.owner_user_id
				FROM agents a
				WHERE a.organization_id = ${opts.organizationId}
				  AND a.id = ${opts.agentId}
				  AND a.owner_user_id IS NOT NULL
				LIMIT 1
			),
			(
				SELECT m."userId"
				FROM member m
				WHERE m."organizationId" = ${opts.organizationId}
				ORDER BY m."createdAt", m.id
				LIMIT 1
			),
			'test-behavior-subscription'
		) AS id
	`;
	const createdBy = creators[0]?.id;
	if (!createdBy) throw new Error("Could not resolve a test Behavior creator");
	// createTestAgent intentionally permits an owner id without seeding a full
	// auth user. Behavior rows have a real created_by FK, so materialize only
	// that identity here without adding org membership (authorization tests rely
	// on their membership setup remaining unchanged).
	await sql`
		INSERT INTO "user" (
			id, email, name, username, "emailVerified", "createdAt", "updatedAt"
		) VALUES (
			${createdBy},
			${`behavior-${createdBy}@test.example.com`},
			'Test Behavior Creator',
			${`behavior-${createdBy}`},
			true, NOW(), NOW()
		)
		ON CONFLICT (id) DO NOTHING
	`;
	const ids = await sql<{ behavior_id: number; version_id: number }>`
		SELECT
		  nextval('behaviors_id_seq')::integer AS behavior_id,
		  nextval('behavior_template_versions_id_seq')::integer AS version_id
	`;
	const behaviorId = ids[0]!.behavior_id;
	const versionId = ids[0]!.version_id;
	const platform = opts.platform ?? connection.connector_key;
	const prefix = `${platform}:`;
	const nativeChannelId = opts.channelId.startsWith(prefix)
		? opts.channelId.slice(prefix.length)
		: opts.channelId;
	const triggers = [
		{
			kind: "event",
			connector_key: platform,
			connection_id: Number(connection.id),
			event_types: ["message.created"],
			match: {
				channel_id: nativeChannelId,
				...(opts.teamId ? { team_id: opts.teamId } : {}),
			},
			execution: "turn",
			active_run: "steer",
			output: "reply_to_source",
			skip_if_unchanged: false,
		},
	];
	await sql`
		INSERT INTO behaviors (
			id, name, slug, description, organization_id, entity_ids,
			triggers, agent_id, model_config, execution_config, sources, version,
			current_version_id, tags, status, created_by, behavior_group_id
		) VALUES (
			${behaviorId}, ${`Messages in ${opts.channelId}`}, ${`test-chat-${behaviorId}`},
			'Test chat subscription', ${opts.organizationId}, '{}'::bigint[],
			${sql.json(triggers)}, ${opts.agentId}, '{}'::jsonb,
			${opts.model ? sql.json({ model: opts.model }) : null}, '[]'::jsonb, 1,
			NULL, ARRAY['system:chat-link']::text[], 'active', ${createdBy}, ${behaviorId}
		)
	`;
	await sql`
		INSERT INTO behavior_versions (
			id, behavior_id, version, name, prompt, version_sources,
			change_notes, created_by
		) VALUES (
			${versionId}, ${behaviorId}, 1, ${`Messages in ${opts.channelId}`},
			'Respond helpfully to the incoming message.', '[]'::jsonb,
			'Test subscription', ${createdBy}
		)
	`;
	await sql`
		UPDATE behaviors SET current_version_id = ${versionId}
		WHERE id = ${behaviorId}
	`;
}

export async function archiveTestBehaviorSubscriptions(opts: {
	organizationId: string;
	agentId?: string;
}): Promise<void> {
	const sql = getTestDb();
	await sql`
		UPDATE behaviors
		SET status = 'archived', updated_at = current_timestamp
		WHERE organization_id = ${opts.organizationId}
		  ${opts.agentId ? sql`AND agent_id = ${opts.agentId}` : sql``}
		  AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements(triggers) trigger
			WHERE trigger->>'kind' = 'event'
			  AND trigger->'event_types' ? 'message.created'
		  )
	`;
}

export interface TestBehaviorSubscription {
	behavior_id: number;
	organization_id: string;
	agent_id: string;
	platform: string;
	channel_id: string;
	team_id: string | null;
	connection_id: number;
}

export async function listTestBehaviorSubscriptions(filters?: {
	organizationId?: string;
	platform?: string;
	channelId?: string;
	teamId?: string | null;
}): Promise<TestBehaviorSubscription[]> {
	const sql = getTestDb();
	return await sql<TestBehaviorSubscription>`
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
				c.id AS connection_id
			FROM behaviors w
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
		) subscriptions
		WHERE TRUE
		  ${filters?.organizationId ? sql`AND organization_id = ${filters.organizationId}` : sql``}
		  ${filters?.platform ? sql`AND platform = ${filters.platform}` : sql``}
		  ${filters?.channelId ? sql`AND channel_id = ${filters.channelId}` : sql``}
		  ${
				filters?.teamId !== undefined
					? filters.teamId === null
						? sql`AND team_id IS NULL`
						: sql`AND team_id = ${filters.teamId}`
					: sql``
			}
		ORDER BY behavior_id
	`;
}
