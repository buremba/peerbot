import type {
	AgentConfigStore,
	AgentConnectionStore,
	AgentMetadata,
	AgentSettings,
} from "@lobu/core";
import { getDb, tsTime, tsTimeOrNull } from "../../db/client";
import { recordLifecycleEvent } from "../../utils/insert-event";
import {
	connectionsRowToStored,
	runtimeConnectionIdToSlug,
	softDeleteChatConnectionProjection,
	upsertChatConnectionProjection,
} from "./connections-projection";
import { getOrgId, tryGetOrgId } from "./org-context";

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
		// The `model` column is the agent's single defaultModel ref (a
		// `provider/model` string or "auto"). The legacy `model_selection` /
		// `provider_model_preferences` columns are no longer read (dropped in a
		// follow-up migration after backfill).
		defaultModel: row.model ?? undefined,
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
		environmentId: row.environment_id ?? undefined,
		updatedAt: tsTime(row.updated_at),
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
		createdAt: tsTime(row.created_at),
		lastUsedAt: tsTimeOrNull(row.last_used_at),
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
            SELECT model,
                   network_config, nix_config,
                   soul_md, user_md, identity_md,
                   skills_config, tools_config, plugins_config,
                   installed_providers, verbose_logging, show_tool_calls,
                   pre_approved_tools, guardrails, guardrails_inline,
                   environment_id, updated_at
            FROM agents
            WHERE id = ${agentId} AND organization_id = ${orgId}
          `
				: await sql`
            SELECT model,
                   network_config, nix_config,
                   soul_md, user_md, identity_md,
                   skills_config, tools_config, plugins_config,
                   installed_providers, verbose_logging, show_tool_calls,
                   pre_approved_tools, guardrails, guardrails_inline,
                   environment_id, updated_at
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
          model = ${settings.defaultModel ?? null},
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
          environment_id = ${settings.environmentId ?? null},
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
          model = NULL,
          network_config = '{}', nix_config = '{}',
          soul_md = '', user_md = '', identity_md = '',
          skills_config = '{"skills": []}', tools_config = '{}', plugins_config = '{}',
          installed_providers = '[]', verbose_logging = false,
          show_tool_calls = false,
          pre_approved_tools = '[]', guardrails = '[]', guardrails_inline = '[]',
          environment_id = NULL,
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
			// `connections` is the sole source of truth (chat rows carry a non-null
			// credential_mode; data connectors leave it NULL). Keyed by slug.
			const slug = runtimeConnectionIdToSlug(connectionId);
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
			return projRows.length > 0 ? connectionsRowToStored(projRows[0]) : null;
		},
		async listConnections(filter) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			const agentId = filter?.agentId ?? null;
			const platform = filter?.platform ?? null;

			// `connections` is the sole source of truth; `credential_mode IS NOT NULL`
			// selects chat rows only (data connectors leave it NULL). filter.agentId →
			// agent_id, filter.platform → connector_key.
			const projRows = await sql`
        SELECT * FROM connections
        WHERE credential_mode IS NOT NULL AND deleted_at IS NULL
          ${orgId ? sql`AND organization_id = ${orgId}` : sql``}
          ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
          ${platform ? sql`AND connector_key = ${platform}` : sql``}
        ORDER BY created_at DESC
      `;
			return projRows.map(connectionsRowToStored);
		},
		async saveConnection(connection) {
			const sql = getDb();
			const orgId = getOrgId();
			const slug = runtimeConnectionIdToSlug(connection.id);

			// One transaction so the secret-preserving read, the
			// `pg_advisory_xact_lock` taken inside upsertChatConnectionProjection,
			// the one-active-per-tenant demotion, and the upsert are all serialized
			// together. The advisory lock is TRANSACTION-scoped — calling the writer
			// on the pool handle would release it after the first statement and
			// defeat the cross-replica serialization.
			await sql.begin(async (tx: typeof sql) => {
				const configToPersist = { ...connection.config };
				const existingRows = await tx`
          SELECT config
          FROM connections
          WHERE slug = ${slug} AND organization_id = ${orgId}
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

				// `connections` is the sole source of truth — persist the chat projection.
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
			// `connections` is the sole source of truth — soft-delete (`deleted_at`)
			// the chat projection (kept for audit; getConnection filters it out).
			await softDeleteChatConnectionProjection(sql, orgId, connectionId);
		},
	};
}
