import {
  decrypt,
  inferGrantKind,
  type AgentAccessStore,
  type AgentConfigStore,
  type AgentConnectionStore,
  type AgentMetadata,
  type AgentSettings,
  type ChannelBinding,
  type Grant,
  type StoredConnection,
} from '@lobu/core';
import { getDb } from '../../db/client';
import { getOrgId, tryGetOrgId } from './org-context';

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,59}$/;

export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_PATTERN.test(agentId);
}

export async function agentExistsInOrganization(
  organizationId: string,
  agentId: string
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

export async function touchAgentLastUsed(organizationId: string, agentId: string): Promise<void> {
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
    egressConfig: row.egress_config ?? undefined,
    nixConfig: row.nix_config ?? undefined,
    mcpServers: row.mcp_servers ?? undefined,
    soulMd: row.soul_md ?? undefined,
    userMd: row.user_md ?? undefined,
    identityMd: row.identity_md ?? undefined,
    skillsConfig: row.skills_config ?? undefined,
    toolsConfig: row.tools_config ?? undefined,
    pluginsConfig: row.plugins_config ?? undefined,
    installedProviders: row.installed_providers ?? undefined,
    verboseLogging: row.verbose_logging ?? undefined,
    preApprovedTools: row.pre_approved_tools ?? undefined,
    guardrails: row.guardrails ?? undefined,
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.getTime() : (row.updated_at ?? Date.now()),
  };
}

function rowToMetadata(row: Record<string, any>): AgentMetadata {
  return {
    agentId: row.id,
    name: row.name,
    description: row.description ?? undefined,
    owner: {
      platform: row.owner_platform ?? 'lobu',
      userId: row.owner_user_id ?? '',
    },
    isWorkspaceAgent: row.is_workspace_agent ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    createdAt:
      row.created_at instanceof Date ? row.created_at.getTime() : (row.created_at ?? Date.now()),
    lastUsedAt:
      row.last_used_at instanceof Date
        ? row.last_used_at.getTime()
        : (row.last_used_at ?? undefined),
  };
}

const SECRET_PATTERN = /(?:credential|secret|token|password|api(?:_|-)?key|authorization)/i;

function isSecretField(key: string): boolean {
  return SECRET_PATTERN.test(key);
}

const ENC_PREFIX = 'enc:v1:';

function isRedactedSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('***');
}

/**
 * Read-side legacy fallback: any `enc:v1:`-prefixed value is decrypted
 * back to plaintext so connections persisted before the move to
 * `secret://` ref indirection still load. New writes never produce
 * these — ChatInstanceManager normalizes secret fields into refs via
 * SecretStoreRegistry before saveConnection runs. Non-prefixed strings
 * (including `secret://` refs) pass through untouched.
 */
function decryptLegacyEncryptedConfig(
  config: Record<string, any>
): Record<string, any> {
  // Fast path (the common case): new writes never produce `enc:v1:` values,
  // so don't clone the object unless there's actually something to decrypt.
  let hasEncrypted = false;
  for (const value of Object.values(config)) {
    if (typeof value === 'string' && value.startsWith(ENC_PREFIX)) {
      hasEncrypted = true;
      break;
    }
  }
  if (!hasEncrypted) return config;

  const result = { ...config };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && value.startsWith(ENC_PREFIX)) {
      try {
        result[key] = decrypt(value.slice(ENC_PREFIX.length));
      } catch {
        // Leave encrypted if decryption fails — surfaces as a
        // resolveConfigForRuntime error at boot time.
      }
    }
  }
  return result;
}

function rowToConnection(row: Record<string, any>): StoredConnection {
  return {
    id: row.id,
    platform: row.platform,
    agentId: row.agent_id ?? undefined,
    organizationId: row.organization_id ?? undefined,
    config: decryptLegacyEncryptedConfig(row.config ?? {}),
    settings: row.settings ?? {},
    metadata: row.metadata ?? {},
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    createdAt:
      row.created_at instanceof Date ? row.created_at.getTime() : (row.created_at ?? Date.now()),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.getTime() : (row.updated_at ?? Date.now()),
  };
}

function rowToChannelBinding(row: Record<string, any>): ChannelBinding {
  return {
    agentId: row.agent_id,
    platform: row.platform,
    channelId: row.channel_id,
    teamId: row.team_id ?? undefined,
    createdAt:
      row.created_at instanceof Date ? row.created_at.getTime() : (row.created_at ?? Date.now()),
  };
}

function rowToGrant(row: Record<string, any>): Grant {
  return {
    pattern: row.pattern,
    kind: inferGrantKind(row.pattern),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.getTime() : (row.expires_at ?? null),
    grantedAt:
      row.granted_at instanceof Date ? row.granted_at.getTime() : (row.granted_at ?? Date.now()),
    denied: row.denied ?? undefined,
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
                   network_config, egress_config, nix_config, mcp_servers,
                   soul_md, user_md, identity_md,
                   skills_config, tools_config, plugins_config,
                   installed_providers, verbose_logging,
                   pre_approved_tools, guardrails, updated_at
            FROM agents
            WHERE id = ${agentId} AND organization_id = ${orgId}
          `
        : await sql`
            SELECT model, model_selection, provider_model_preferences,
                   network_config, egress_config, nix_config, mcp_servers,
                   soul_md, user_md, identity_md,
                   skills_config, tools_config, plugins_config,
                   installed_providers, verbose_logging,
                   pre_approved_tools, guardrails, updated_at
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
          egress_config = ${sql.json(settings.egressConfig ?? {})},
          nix_config = ${sql.json(settings.nixConfig ?? {})},
          mcp_servers = ${sql.json(settings.mcpServers ?? {})},
          soul_md = ${settings.soulMd ?? ''},
          user_md = ${settings.userMd ?? ''},
          identity_md = ${settings.identityMd ?? ''},
          skills_config = ${sql.json(settings.skillsConfig ?? { skills: [] })},
          tools_config = ${sql.json(settings.toolsConfig ?? {})},
          plugins_config = ${sql.json(settings.pluginsConfig ?? {})},
          installed_providers = ${sql.json(settings.installedProviders ?? [])},
          verbose_logging = ${settings.verboseLogging ?? false},
          pre_approved_tools = ${sql.json(settings.preApprovedTools ?? [])},
          guardrails = ${sql.json(settings.guardrails ?? [])},
          updated_at = ${now}
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
    },
    async updateSettings(agentId, updates) {
      const existing = await store.getSettings(agentId);
      if (!existing) return;
      await store.saveSettings(agentId, { ...existing, ...updates, updatedAt: Date.now() });
    },
    async deleteSettings(agentId) {
      const sql = getDb();
      const orgId = getOrgId();
      await sql`
        UPDATE agents SET
          model = NULL, model_selection = '{}', provider_model_preferences = '{}',
          network_config = '{}', egress_config = '{}', nix_config = '{}',
          mcp_servers = '{}',
          soul_md = '', user_md = '', identity_md = '',
          skills_config = '{"skills": []}', tools_config = '{}', plugins_config = '{}',
          installed_providers = '[]', verbose_logging = false,
          pre_approved_tools = '[]', guardrails = '[]',
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
            SELECT id, name, description, owner_platform, owner_user_id,
                   is_workspace_agent, workspace_id,
                   created_at, last_used_at
            FROM agents
            WHERE id = ${agentId} AND organization_id = ${orgId}
          `
        : await sql`
            SELECT id, name, description, owner_platform, owner_user_id,
                   is_workspace_agent, workspace_id,
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
      await sql`
        INSERT INTO agents (id, organization_id, name, description, owner_platform, owner_user_id,
                            is_workspace_agent, workspace_id, created_at)
        VALUES (
          ${agentId}, ${orgId}, ${metadata.name}, ${metadata.description ?? null},
          ${metadata.owner.platform}, ${metadata.owner.userId},
          ${metadata.isWorkspaceAgent ?? false}, ${metadata.workspaceId ?? null},
          ${metadata.createdAt ? new Date(metadata.createdAt) : now}
        )
        ON CONFLICT (organization_id, id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          owner_platform = EXCLUDED.owner_platform,
          owner_user_id = EXCLUDED.owner_user_id,
          is_workspace_agent = EXCLUDED.is_workspace_agent,
          workspace_id = EXCLUDED.workspace_id,
          last_used_at = ${metadata.lastUsedAt ? new Date(metadata.lastUsedAt) : null},
          updated_at = ${now}
      `;
    },
    async updateMetadata(agentId, updates) {
      const existing = await store.getMetadata(agentId);
      if (!existing) return;
      await store.saveMetadata(agentId, { ...existing, ...updates });
    },
    async deleteMetadata(agentId) {
      const sql = getDb();
      const orgId = getOrgId();
      await sql`DELETE FROM agents WHERE id = ${agentId} AND organization_id = ${orgId}`;
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
        SELECT id, name, description, owner_platform, owner_user_id,
               is_workspace_agent, workspace_id,
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
      return rowToConnection(rows[0]);
    },
    async listConnections(filter) {
      const sql = getDb();
      const orgId = tryGetOrgId();

      if (filter?.agentId && filter?.platform) {
        const rows = orgId
          ? await sql`
              SELECT * FROM agent_connections
              WHERE organization_id = ${orgId}
                AND agent_id = ${filter.agentId}
                AND platform = ${filter.platform}
              ORDER BY created_at DESC
            `
          : await sql`
              SELECT * FROM agent_connections
              WHERE agent_id = ${filter.agentId}
                AND platform = ${filter.platform}
              ORDER BY created_at DESC
            `;
        return rows.map(rowToConnection);
      }
      if (filter?.agentId) {
        const rows = orgId
          ? await sql`
              SELECT * FROM agent_connections
              WHERE organization_id = ${orgId} AND agent_id = ${filter.agentId}
              ORDER BY created_at DESC
            `
          : await sql`
              SELECT * FROM agent_connections
              WHERE agent_id = ${filter.agentId}
              ORDER BY created_at DESC
            `;
        return rows.map(rowToConnection);
      }
      if (filter?.platform) {
        const rows = orgId
          ? await sql`
              SELECT * FROM agent_connections
              WHERE organization_id = ${orgId} AND platform = ${filter.platform}
              ORDER BY created_at DESC
            `
          : await sql`
              SELECT * FROM agent_connections
              WHERE platform = ${filter.platform}
              ORDER BY created_at DESC
            `;
        return rows.map(rowToConnection);
      }

      const rows = orgId
        ? await sql`
            SELECT * FROM agent_connections
            WHERE organization_id = ${orgId}
            ORDER BY created_at DESC
          `
        : await sql`
            SELECT * FROM agent_connections
            ORDER BY created_at DESC
          `;
      return rows.map(rowToConnection);
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
        existingRows[0] && typeof existingRows[0].config === 'object' && existingRows[0].config
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
          if (typeof existingValue === 'string' && existingValue.length > 0) {
            configToPersist[key] = existingValue;
          }
        }
      }

      const now = new Date();
      await sql`
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
      if (orgId) {
        await sql`
          DELETE FROM agent_connections
          WHERE id = ${connectionId} AND organization_id = ${orgId}
        `;
      } else {
        await sql`DELETE FROM agent_connections WHERE id = ${connectionId}`;
      }
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
        await sql`
          INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, created_at)
          VALUES (${orgId}, ${binding.agentId}, ${binding.platform}, ${binding.channelId}, ${binding.teamId}, now())
          ON CONFLICT (platform, channel_id, team_id) DO UPDATE SET
            agent_id = EXCLUDED.agent_id,
            organization_id = EXCLUDED.organization_id
        `;
      } else {
        // PG treats NULL as distinct under the (platform, channel_id, team_id)
        // UNIQUE; the team_id IS NULL branch upserts via the partial unique
        // index agent_channel_bindings_no_team_unique.
        await sql`
          INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, created_at)
          VALUES (${orgId}, ${binding.agentId}, ${binding.platform}, ${binding.channelId}, NULL, now())
          ON CONFLICT (platform, channel_id)
            WHERE team_id IS NULL
            DO UPDATE SET agent_id = EXCLUDED.agent_id,
              organization_id = EXCLUDED.organization_id
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

export function createPostgresAgentAccessStore(): AgentAccessStore {
  return {
    async grant(agentId, pattern, expiresAt, denied) {
      const sql = getDb();
      const orgId = getOrgId();
      const exp = expiresAt ? new Date(expiresAt) : null;
      await sql`
        INSERT INTO agent_grants (organization_id, agent_id, pattern, expires_at, granted_at, denied)
        VALUES (${orgId}, ${agentId}, ${pattern}, ${exp}, now(), ${denied ?? false})
        ON CONFLICT (organization_id, agent_id, pattern) DO UPDATE SET
          expires_at = EXCLUDED.expires_at,
          granted_at = EXCLUDED.granted_at,
          denied = EXCLUDED.denied
      `;
    },
    async hasGrant(agentId, pattern) {
      const sql = getDb();
      const orgId = tryGetOrgId();
      const exact = orgId
        ? await sql`
            SELECT 1 FROM agent_grants
            WHERE organization_id = ${orgId}
              AND agent_id = ${agentId} AND pattern = ${pattern}
              AND denied IS NOT TRUE
              AND (expires_at IS NULL OR expires_at > now())
            LIMIT 1
          `
        : await sql`
            SELECT 1 FROM agent_grants
            WHERE agent_id = ${agentId} AND pattern = ${pattern}
              AND denied IS NOT TRUE
              AND (expires_at IS NULL OR expires_at > now())
            LIMIT 1
          `;
      if (exact.length > 0) return true;

      const grants = orgId
        ? await sql`
            SELECT pattern FROM agent_grants
            WHERE organization_id = ${orgId}
              AND agent_id = ${agentId}
              AND denied IS NOT TRUE
              AND (expires_at IS NULL OR expires_at > now())
          `
        : await sql`
            SELECT pattern FROM agent_grants
            WHERE agent_id = ${agentId}
              AND denied IS NOT TRUE
              AND (expires_at IS NULL OR expires_at > now())
          `;
      return grants.some((g: any) => wildcardMatch(g.pattern, pattern));
    },
    async isDenied(agentId, pattern) {
      const sql = getDb();
      const orgId = tryGetOrgId();
      const rows = orgId
        ? await sql`
            SELECT 1 FROM agent_grants
            WHERE organization_id = ${orgId}
              AND agent_id = ${agentId} AND pattern = ${pattern}
              AND denied = TRUE
              AND (expires_at IS NULL OR expires_at > now())
            LIMIT 1
          `
        : await sql`
            SELECT 1 FROM agent_grants
            WHERE agent_id = ${agentId} AND pattern = ${pattern}
              AND denied = TRUE
              AND (expires_at IS NULL OR expires_at > now())
            LIMIT 1
          `;
      return rows.length > 0;
    },
    async listGrants(agentId) {
      const sql = getDb();
      const orgId = tryGetOrgId();
      const rows = orgId
        ? await sql`
            SELECT pattern, expires_at, granted_at, denied
            FROM agent_grants
            WHERE organization_id = ${orgId} AND agent_id = ${agentId}
            ORDER BY granted_at DESC
          `
        : await sql`
            SELECT pattern, expires_at, granted_at, denied
            FROM agent_grants
            WHERE agent_id = ${agentId}
            ORDER BY granted_at DESC
          `;
      return rows.map(rowToGrant);
    },
    async revokeGrant(agentId, pattern) {
      const sql = getDb();
      const orgId = tryGetOrgId();
      if (orgId) {
        await sql`
          DELETE FROM agent_grants
          WHERE organization_id = ${orgId}
            AND agent_id = ${agentId} AND pattern = ${pattern}
        `;
      } else {
        await sql`
          DELETE FROM agent_grants WHERE agent_id = ${agentId} AND pattern = ${pattern}
        `;
      }
    },
    async addUserAgent(platform, userId, agentId) {
      const sql = getDb();
      const orgId = getOrgId();
      await sql`
        INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
        VALUES (${orgId}, ${agentId}, ${platform}, ${userId}, now())
        ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
      `;
    },
    async removeUserAgent(platform, userId, agentId) {
      const sql = getDb();
      const orgId = tryGetOrgId();
      if (orgId) {
        await sql`
          DELETE FROM agent_users
          WHERE organization_id = ${orgId}
            AND agent_id = ${agentId} AND platform = ${platform} AND user_id = ${userId}
        `;
      } else {
        await sql`
          DELETE FROM agent_users WHERE agent_id = ${agentId} AND platform = ${platform} AND user_id = ${userId}
        `;
      }
    },
    async listUserAgents(platform, userId) {
      const sql = getDb();
      const orgId = tryGetOrgId();
      const rows = orgId
        ? await sql`
            SELECT agent_id FROM agent_users
            WHERE organization_id = ${orgId}
              AND platform = ${platform} AND user_id = ${userId}
          `
        : await sql`
            SELECT agent_id FROM agent_users WHERE platform = ${platform} AND user_id = ${userId}
          `;
      return rows.map((r: any) => r.agent_id);
    },
    async ownsAgent(platform, userId, agentId) {
      const sql = getDb();
      const orgId = tryGetOrgId();
      const rows = orgId
        ? await sql`
            SELECT 1 FROM agent_users
            WHERE organization_id = ${orgId}
              AND agent_id = ${agentId} AND platform = ${platform} AND user_id = ${userId}
            LIMIT 1
          `
        : await sql`
            SELECT 1 FROM agent_users
            WHERE agent_id = ${agentId} AND platform = ${platform} AND user_id = ${userId}
            LIMIT 1
          `;
      return rows.length > 0;
    },
  };
}

function wildcardMatch(grantPattern: string, target: string): boolean {
  if (grantPattern === target || grantPattern === '*') return true;

  if (grantPattern.startsWith('*.')) {
    const suffix = grantPattern.slice(1);
    return target.endsWith(suffix) || target === grantPattern.slice(2);
  }

  if (grantPattern.endsWith('/*')) {
    const prefix = grantPattern.slice(0, -1);
    return target.startsWith(prefix) || target === grantPattern.slice(0, -2);
  }

  return false;
}
