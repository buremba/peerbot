import type {
	AgentConfigStore,
	AgentConnectionStore,
	AgentMetadata,
	AgentSettings,
	ChannelBinding,
	StoredConnection,
} from "@lobu/core";
import { createLogger } from "@lobu/core";
import { getDb, tsTime, tsTimeOrNull } from "../../db/client";
import { recordLifecycleEvent } from "../../utils/insert-event";
import {
	connectionsRowToStored,
	legacyIdToSlug,
	softDeleteChatConnectionProjection,
	upsertChatConnectionProjection,
} from "./connections-projection";
import { getOrgId, tryGetOrgId } from "./org-context";

const connLogger = createLogger("postgres-agent-connection-store");

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,59}$/;

export function isValidAgentId(agentId: string): boolean {
	return AGENT_ID_PATTERN.test(agentId);
}

export async function agentExistsInOrganization(
	organizationId: string,
	agentId: string,
): Promise<boolean> {
	const sql = getDb();
	const rows = await sql`
    SELECT 1
    FROM agents
    WHERE id = ${agentId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
	return rows.length > 0;
}

export async function touchAgentLastUsed(
	organizationId: string,
	agentId: string,
): Promise<void> {
	const sql = getDb();
	await sql`
    UPDATE agents
    SET last_used_at = NOW()
    WHERE id = ${agentId}
      AND organization_id = ${organizationId}
  `;
}

function rowToSettings(row: Record<string, any>): AgentSettings {
	return {
		model: row.model ?? undefined,
		modelSelection: row.model_selection ?? undefined,
		providerModelPreferences: row.provider_model_preferences ?? undefined,
		networkConfig: row.network_config ?? undefined,
		nixConfig: row.nix_config ?? undefined,
		soulMd: row.soul_md ?? undefined,
		userMd: row.user_md ?? undefined,
		identityMd: row.identity_md ?? undefined,
		skillsConfig: row.skills_config ?? undefined,
		toolsConfig: row.tools_config ?? undefined,
		pluginsConfig: row.plugins_config ?? undefined,
		installedProviders: row.installed_providers ?? undefined,
		verboseLogging: row.verbose_logging ?? undefined,
		showToolCalls: row.show_tool_calls ?? undefined,
		preApprovedTools: row.pre_approved_tools ?? undefined,
		guardrails: row.guardrails ?? undefined,
		guardrailsInline: row.guardrails_inline ?? undefined,
		updatedAt:
			tsTime(row.updated_at),
	};
}

function rowToMetadata(row: Record<string, any>): AgentMetadata {
	return {
		agentId: row.id,
		name: row.name,
		description: row.description ?? undefined,
		owner: {
			platform: row.owner_platform ?? "lobu",
			userId: row.owner_user_id ?? "",
		},
		organizationId: row.organization_id ?? undefined,
		createdAt:
			tsTime(row.created_at),
		lastUsedAt:
			tsTimeOrNull(row.last_used_at),
	};
}

const SECRET_PATTERN =
	/(?:credential|secret|token|password|api(?:_|-)?key|authorization)/i;

function isSecretField(key: string): boolean {
	return SECRET_PATTERN.test(key);
}

function isRedactedSecretValue(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("***");
}

function rowToConnection(row: Record<string, any>): StoredConnection {
	return {
		id: row.id,
		platform: row.platform,
		agentId: row.agent_id ?? undefined,
		organizationId: row.organization_id ?? undefined,
		config: row.config ?? {},
		settings: row.settings ?? {},
		metadata: row.metadata ?? {},
		status: row.status,
		errorMessage: row.error_message ?? undefined,
		createdAt:
			tsTime(row.created_at),
		updatedAt:
			tsTime(row.updated_at),
	};
}

function rowToChannelBinding(row: Record<string, any>): ChannelBinding {
	return {
		agentId: row.agent_id,
		platform: row.platform,
		channelId: row.channel_id,
		teamId: row.team_id ?? undefined,
		createdAt:
			tsTime(row.created_at),
	};
}

export function createPostgresAgentConfigStore(): AgentConfigStore {
	const store: AgentConfigStore = {
		async getSettings(agentId) {
			const sql = getDb();
			// Workers/gateway-internal callers run without org context — agent IDs
			// are globally unique and the worker token already proves authenticity,
			// so falling back to id-only lookup is safe. HTTP request paths always
			// have an org context (set by middleware) and get the row scoped to it.
			const orgId = tryGetOrgId();
			const rows = orgId
				? await sql`
            SELECT model, model_selection, provider_model_preferences,
                   network_config, nix_config,
                   soul_md, user_md, identity_md,
                   skills_config, tools_config, plugins_config,
                   installed_providers, verbose_logging, show_tool_calls,
                   pre_approved_tools, guardrails, guardrails_inline, updated_at
            FROM agents
            WHERE id = ${agentId} AND organization_id = ${orgId}
          `
				: await sql`
            SELECT model, model_selection, provider_model_preferences,
                   network_config, nix_config,
                   soul_md, user_md, identity_md,
                   skills_config, tools_config, plugins_config,
                   installed_providers, verbose_logging, show_tool_calls,
                   pre_approved_tools, guardrails, guardrails_inline, updated_at
            FROM agents
            WHERE id = ${agentId}
          `;
			if (rows.length === 0) return null;
			return rowToSettings(rows[0]);
		},
		async saveSettings(agentId, settings) {
			const sql = getDb();
			const orgId = getOrgId();
			const now = new Date();
			await sql`
        UPDATE agents SET
          model = ${settings.model ?? null},
          model_selection = ${sql.json(settings.modelSelection ?? {})},
          provider_model_preferences = ${sql.json(settings.providerModelPreferences ?? {})},
          network_config = ${sql.json(settings.networkConfig ?? {})},
          nix_config = ${sql.json(settings.nixConfig ?? {})},
          soul_md = ${settings.soulMd ?? ""},
          user_md = ${settings.userMd ?? ""},
          identity_md = ${settings.identityMd ?? ""},
          skills_config = ${sql.json(settings.skillsConfig ?? { skills: [] })},
          tools_config = ${sql.json(settings.toolsConfig ?? {})},
          plugins_config = ${sql.json(settings.pluginsConfig ?? {})},
          installed_providers = ${sql.json(settings.installedProviders ?? [])},
          verbose_logging = ${settings.verboseLogging ?? false},
          show_tool_calls = ${settings.showToolCalls ?? false},
          pre_approved_tools = ${sql.json(settings.preApprovedTools ?? [])},
          guardrails = ${sql.json(settings.guardrails ?? [])},
          guardrails_inline = ${sql.json(settings.guardrailsInline ?? [])},
          updated_at = ${now}
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
		},
		async updateSettings(agentId, updates) {
			const existing = await store.getSettings(agentId);
			if (!existing) return;
			await store.saveSettings(agentId, {
				...existing,
				...updates,
				updatedAt: Date.now(),
			});
		},
		async deleteSettings(agentId) {
			const sql = getDb();
			const orgId = getOrgId();
			await sql`
        UPDATE agents SET
          model = NULL, model_selection = '{}', provider_model_preferences = '{}',
          network_config = '{}', nix_config = '{}',
          soul_md = '', user_md = '', identity_md = '',
          skills_config = '{"skills": []}', tools_config = '{}', plugins_config = '{}',
          installed_providers = '[]', verbose_logging = false,
          show_tool_calls = false,
          pre_approved_tools = '[]', guardrails = '[]', guardrails_inline = '[]',
          updated_at = now()
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
		},
		async hasSettings(agentId) {
			return store.hasAgent(agentId);
		},
		async getMetadata(agentId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			const rows = orgId
				? await sql`
            SELECT id, organization_id, name, description, owner_platform, owner_user_id,
                   created_at, last_used_at
            FROM agents
            WHERE id = ${agentId} AND organization_id = ${orgId}
          `
				: await sql`
            SELECT id, organization_id, name, description, owner_platform, owner_user_id,
                   created_at, last_used_at
            FROM agents
            WHERE id = ${agentId}
          `;
			if (rows.length === 0) return null;
			return rowToMetadata(rows[0]);
		},
		async saveMetadata(agentId, metadata) {
			const sql = getDb();
			const orgId = getOrgId();
			const now = new Date();
			// The PK is (organization_id, id) — UPSERT on the composite key. Two
			// orgs can independently own an agent with the same id; the conflict
			// path here only triggers for re-saves within the *same* org.
			// `xmax = 0` on the returning row distinguishes a fresh INSERT from
			// a CONFLICT UPDATE so we can emit the right lifecycle event.
			const rows = await sql`
        INSERT INTO agents (id, organization_id, name, description, owner_platform, owner_user_id,
                            created_at)
        VALUES (
          ${agentId}, ${orgId}, ${metadata.name}, ${metadata.description ?? null},
          ${metadata.owner.platform}, ${metadata.owner.userId},
          ${metadata.createdAt ? new Date(metadata.createdAt) : now}
        )
        ON CONFLICT (organization_id, id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          owner_platform = EXCLUDED.owner_platform,
          owner_user_id = EXCLUDED.owner_user_id,
          last_used_at = ${metadata.lastUsedAt ? new Date(metadata.lastUsedAt) : null},
          updated_at = ${now}
        RETURNING (xmax = 0) AS inserted
      `;
			const inserted = rows[0]?.inserted === true;
			recordLifecycleEvent({
				organizationId: orgId,
				entityType: "agent",
				op: inserted ? "created" : "updated",
				entityId: agentId,
				summary: inserted
					? `Agent "${metadata.name}" created`
					: `Agent "${metadata.name}" updated`,
			});
		},
		async updateMetadata(agentId, updates) {
			const existing = await store.getMetadata(agentId);
			if (!existing) return;
			await store.saveMetadata(agentId, { ...existing, ...updates });
		},
		async deleteMetadata(agentId) {
			const sql = getDb();
			const orgId = getOrgId();
			const rows = await sql`
        DELETE FROM agents
        WHERE id = ${agentId} AND organization_id = ${orgId}
        RETURNING name
      `;
			if (rows.length > 0) {
				recordLifecycleEvent({
					organizationId: orgId,
					entityType: "agent",
					op: "deleted",
					entityId: agentId,
					summary: `Agent "${rows[0].name ?? agentId}" deleted`,
				});
			}
		},
		async hasAgent(agentId) {
			const sql = getDb();
			const orgId = getOrgId();
			const rows = await sql`
        SELECT 1 FROM agents WHERE id = ${agentId} AND organization_id = ${orgId} LIMIT 1
      `;
			return rows.length > 0;
		},
		async listAgents() {
			const sql = getDb();
			const orgId = getOrgId();
			const rows = await sql`
        SELECT id, organization_id, name, description, owner_platform, owner_user_id,
               created_at, last_used_at
        FROM agents
        WHERE organization_id = ${orgId}
        ORDER BY created_at DESC
      `;
			return rows.map(rowToMetadata);
		},
	};
	return store;
}

export function createPostgresAgentConnectionStore(): AgentConnectionStore {
	return {
		async getConnection(connectionId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			// Read cutover (Stage 2a): prefer the `connections` projection (by slug),
			// fall back to legacy `agent_connections` on a miss. Write-through keeps
			// the projection current, so the fallback should rarely fire (only for a
			// row created before this deploy / not yet projected).
			const slug = legacyIdToSlug(connectionId);
			const projRows = orgId
				? await sql`
            SELECT * FROM connections
            WHERE organization_id = ${orgId} AND slug = ${slug}
              AND credential_mode IS NOT NULL AND deleted_at IS NULL
            LIMIT 1
          `
				: await sql`
            SELECT * FROM connections
            WHERE slug = ${slug}
              AND credential_mode IS NOT NULL AND deleted_at IS NULL
            LIMIT 1
          `;
			if (projRows.length > 0) return connectionsRowToStored(projRows[0]);

			const rows = orgId
				? await sql`
            SELECT * FROM agent_connections
            WHERE id = ${connectionId} AND organization_id = ${orgId}
          `
				: await sql`
            SELECT * FROM agent_connections
            WHERE id = ${connectionId}
          `;
			if (rows.length === 0) return null;
			connLogger.info(
				{ connectionId },
				"connections projection miss; resolved from legacy agent_connections",
			);
			return rowToConnection(rows[0]);
		},
		async listConnections(filter) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			const agentId = filter?.agentId ?? null;
			const platform = filter?.platform ?? null;

			// Read cutover (Stage 2a): the `connections` chat projection is the
			// preferred source; `credential_mode IS NOT NULL` selects chat rows only
			// (data connectors leave it NULL). filter.agentId → agent_id,
			// filter.platform → connector_key.
			const projRows = await sql`
        SELECT * FROM connections
        WHERE credential_mode IS NOT NULL AND deleted_at IS NULL
          ${orgId ? sql`AND organization_id = ${orgId}` : sql``}
          ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
          ${platform ? sql`AND connector_key = ${platform}` : sql``}
        ORDER BY created_at DESC
      `;
			const result = projRows.map(connectionsRowToStored);
			const seenSlugs = new Set(projRows.map((r: { slug: string }) => r.slug));

			// Union-with-deference: append any legacy `agent_connections` row whose
			// derived slug is NOT already covered by the projection (created/edited
			// before write-through, or projection missing). Dedupe by slug so a
			// backfilled row isn't double-counted.
			const legacyRows = await sql`
        SELECT * FROM agent_connections
        WHERE TRUE
          ${orgId ? sql`AND organization_id = ${orgId}` : sql``}
          ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
          ${platform ? sql`AND platform = ${platform}` : sql``}
        ORDER BY created_at DESC
      `;
			for (const lr of legacyRows) {
				if (seenSlugs.has(legacyIdToSlug(lr.id))) continue;
				connLogger.info(
					{ connectionId: lr.id },
					"connections projection miss in list; including legacy agent_connections row",
				);
				result.push(rowToConnection(lr));
			}
			return result;
		},
		async saveConnection(connection) {
			const sql = getDb();
			const orgId = getOrgId();
			const configToPersist = { ...connection.config };
			const existingRows = await sql`
        SELECT config
        FROM agent_connections
        WHERE id = ${connection.id} AND organization_id = ${orgId}
        LIMIT 1
      `;
			const existingConfig =
				existingRows[0] &&
				typeof existingRows[0].config === "object" &&
				existingRows[0].config
					? (existingRows[0].config as Record<string, any>)
					: null;

			// ChatInstanceManager normalizes secret fields into `secret://` refs
			// before reaching here. The remaining special case is the API surface
			// that hands back `***last4`-redacted values when a sanitized
			// connection is round-tripped to an UPDATE — preserve the existing
			// ref/value so a non-edited secret doesn't overwrite the real one.
			if (existingConfig) {
				for (const [key, value] of Object.entries(configToPersist)) {
					if (!isSecretField(key) || !isRedactedSecretValue(value)) continue;

					const existingValue = existingConfig[key];
					if (typeof existingValue === "string" && existingValue.length > 0) {
						configToPersist[key] = existingValue;
					}
				}
			}

			const now = new Date();
			// Dual-write-through (connections-unify Stage 2a): the legacy
			// `agent_connections` write AND the `connections` projection (by slug)
			// land in ONE transaction, so a crash between them can never diverge the
			// two sources. Legacy stays the durable, reversible source; the
			// projection is what the chat runtime reads (memo keys on
			// connections.updated_at, status-health reads it).
			await sql.begin(async (tx: typeof sql) => {
				await tx`
          INSERT INTO agent_connections (id, organization_id, agent_id, platform, config, settings, metadata, status, error_message, created_at, updated_at)
          VALUES (
            ${connection.id}, ${orgId}, ${connection.agentId ?? null}, ${connection.platform},
            ${sql.json(configToPersist)}, ${sql.json(connection.settings)}, ${sql.json(connection.metadata)},
            ${connection.status}, ${connection.errorMessage ?? null}, ${now}, ${now}
          )
          ON CONFLICT (id) DO UPDATE SET
            platform = EXCLUDED.platform,
            config = EXCLUDED.config,
            settings = EXCLUDED.settings,
            metadata = EXCLUDED.metadata,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            updated_at = ${now}
        `;
				await upsertChatConnectionProjection(
					tx,
					(v) => sql.json(v),
					{ ...connection, config: configToPersist },
					orgId,
					"byo",
				);
			});
		},
		async updateConnection(connectionId, updates) {
			const existing = await this.getConnection(connectionId);
			if (!existing) return;
			const merged = { ...existing, ...updates, updatedAt: Date.now() };
			await this.saveConnection(merged);
		},
		async deleteConnection(connectionId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			// Dual-write-through: hard-delete the legacy row (existing behaviour) and
			// soft-delete (`deleted_at`) the connections projection, in one tx so the
			// two sources never diverge. Soft-delete keeps the unified row for audit /
			// reversibility, matching the Stage-1 backfill's down path.
			await sql.begin(async (tx: typeof sql) => {
				if (orgId) {
					await tx`
            DELETE FROM agent_connections
            WHERE id = ${connectionId} AND organization_id = ${orgId}
          `;
				} else {
					await tx`DELETE FROM agent_connections WHERE id = ${connectionId}`;
				}
				await softDeleteChatConnectionProjection(tx, orgId, connectionId);
			});
		},
		async getChannelBinding(platform, channelId, teamId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			const rows = teamId
				? orgId
					? await sql`
              SELECT * FROM agent_channel_bindings
              WHERE organization_id = ${orgId}
                AND platform = ${platform} AND channel_id = ${channelId} AND team_id = ${teamId}
            `
					: await sql`
              SELECT * FROM agent_channel_bindings
              WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id = ${teamId}
            `
				: orgId
					? await sql`
              SELECT * FROM agent_channel_bindings
              WHERE organization_id = ${orgId}
                AND platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
            `
					: await sql`
              SELECT * FROM agent_channel_bindings
              WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
            `;
			if (rows.length === 0) return null;
			return rowToChannelBinding(rows[0]);
		},
		async createChannelBinding(binding) {
			const sql = getDb();
			const orgId = getOrgId();
			if (binding.teamId) {
				// Org-scoped UNIQUE — a sibling tenant binding the same platform+channel
				// can never collide with this org's row. `organization_id` is
				// deliberately absent from the SET list so a binding cannot change owners.
				await sql`
          INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, created_at)
          VALUES (${orgId}, ${binding.agentId}, ${binding.platform}, ${binding.channelId}, ${binding.teamId}, now())
          ON CONFLICT (organization_id, platform, channel_id, team_id) DO UPDATE SET
            agent_id = EXCLUDED.agent_id
        `;
			} else {
				// PG treats NULL as distinct under the org-scoped UNIQUE; the
				// team_id IS NULL branch upserts via the org-scoped partial unique
				// index agent_channel_bindings_org_no_team_unique.
				await sql`
          INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, created_at)
          VALUES (${orgId}, ${binding.agentId}, ${binding.platform}, ${binding.channelId}, NULL, now())
          ON CONFLICT (organization_id, platform, channel_id)
            WHERE team_id IS NULL
            DO UPDATE SET agent_id = EXCLUDED.agent_id
        `;
			}
		},
		async deleteChannelBinding(platform, channelId, teamId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			if (teamId) {
				if (orgId) {
					await sql`
            DELETE FROM agent_channel_bindings
            WHERE organization_id = ${orgId}
              AND platform = ${platform} AND channel_id = ${channelId} AND team_id = ${teamId}
          `;
				} else {
					await sql`
            DELETE FROM agent_channel_bindings
            WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id = ${teamId}
          `;
				}
				return;
			}

			if (orgId) {
				await sql`
          DELETE FROM agent_channel_bindings
          WHERE organization_id = ${orgId}
            AND platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
        `;
			} else {
				await sql`
          DELETE FROM agent_channel_bindings
          WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
        `;
			}
		},
		async listChannelBindings(agentId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			const rows = orgId
				? await sql`
            SELECT * FROM agent_channel_bindings
            WHERE agent_id = ${agentId} AND organization_id = ${orgId}
          `
				: await sql`
            SELECT * FROM agent_channel_bindings WHERE agent_id = ${agentId}
          `;
			return rows.map(rowToChannelBinding);
		},
		async deleteAllChannelBindings(agentId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			const rows = orgId
				? await sql`
            DELETE FROM agent_channel_bindings
            WHERE agent_id = ${agentId} AND organization_id = ${orgId}
            RETURNING 1
          `
				: await sql`
            DELETE FROM agent_channel_bindings WHERE agent_id = ${agentId} RETURNING 1
          `;
			return rows.length;
		},
	};
}
