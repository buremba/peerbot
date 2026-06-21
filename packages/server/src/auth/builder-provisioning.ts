/**
 * Builder-agent auto-provisioning.
 *
 * Every org gets a dedicated "builder" agent — the org's setup/console agent
 * that manages agents, connections, watchers, and workflows on the user's
 * behalf. `organization.system_agent_id` points at it.
 *
 *   - installs system-key model providers + pins a default model up front (so
 *     the agent can chat the moment it's created, instead of "No model
 *     configured"),
 *   - attributes ownership to the personal-org owner via the
 *     `personal_org_for_user_id` org-metadata marker,
 *   - writes a sentinel into `organization.metadata` so a deleted builder agent
 *     is NOT auto-recreated,
 *   - is best-effort / non-throwing: a failure here must never break the boot
 *     or signup path that called us.
 *
 * Reliability: provider/model resolution reads `config/providers.json`
 * directly (via `ProviderRegistryService`) rather than depending on the live
 * `moduleRegistry` being populated. The registry is only fully wired during
 * gateway boot, so a provisioning call that ran against an empty registry used
 * to silently create a builder with `installed_providers = []` and no model —
 * and the sentinel then made that broken state permanent. Reading the config
 * file is deterministic regardless of where/when provisioning runs, and the
 * repair path below heals any builder that was created in the broken state.
 *
 * The agents PK is composite `(organization_id, id)`, so the same
 * `BUILDER_AGENT_ID` string per org is fine. The `system_agent_id` pointer is
 * only set when currently NULL — we never clobber an admin's explicit choice
 * (set via `manage_agents.set_system_agent`).
 */

import type { ProviderConfigEntry } from '@lobu/core';
import { getDb } from '../db/client';
import type { DbClient } from '../db/client';
import { resolveEnv } from '../gateway/auth/mcp/string-substitution';
import { getModelProviderModules } from '../gateway/modules/module-system';
import {
  ProviderRegistryService,
  resolveProviderRegistryPath,
} from '../gateway/services/provider-registry-service';
import logger from '../utils/logger';
import { hasOrgSentinel } from './default-provisioning';

export const BUILDER_AGENT_ID = 'lobu-builder';
export const BUILDER_AGENT_SENTINEL = 'builder_agent_provisioned';

const BUILDER_AGENT_NAME = 'Builder';
const BUILDER_AGENT_IDENTITY =
  "You are the organization's Builder — its setup and management assistant. " +
  'You help the owner configure their workspace: creating and editing agents, ' +
  'wiring up connections and integrations, setting up watchers and scheduled ' +
  'workflows, and keeping the org healthy. ' +
  'Be concrete and action-oriented; prefer making the change over describing it. ' +
  "If you don't yet have access to something the user wants to manage, say so " +
  'clearly and suggest what they could connect or grant next.';

/**
 * Capability/reliability preference for the builder's *pinned* model. We pin
 * the first provider here that (a) has a system key in this environment and
 * (b) declares a `defaultModel` in providers.json. Providers not listed are
 * still installed; they just aren't preferred for the initial pin.
 */
const BUILDER_MODEL_PROVIDER_PREFERENCE = [
  'anthropic',
  'openai',
  'gemini',
  'z-ai',
  'groq',
  'mistral',
  'deepseek',
];

interface InstalledProvider {
  providerId: string;
  installedAt: number;
}

interface ResolvedBuilderProviders {
  providers: InstalledProvider[];
  model: string | null;
}

/**
 * Resolve the system-key providers + a default model to install on the builder.
 *
 * Primary source is `config/providers.json` (read directly — independent of the
 * runtime module registry), so this returns the same result regardless of
 * whether the gateway's `moduleRegistry` has been initialized in this process.
 * We additionally union in any system-key providers the live registry knows
 * about (e.g. anthropic / OAuth backends that aren't in providers.json) when it
 * happens to be available — purely additive, never required.
 */
async function resolveBuilderProviders(): Promise<ResolvedBuilderProviders> {
  const now = Date.now();
  const installed = new Map<string, InstalledProvider>();

  // (1) Deterministic floor: providers declared in config/providers.json whose
  // env var is present in this process.
  let configs: Record<string, ProviderConfigEntry> = {};
  try {
    const registry = new ProviderRegistryService(resolveProviderRegistryPath());
    configs = await registry.getProviderConfigs();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[builder-provisioning] providers.json read failed; relying on module registry'
    );
  }
  for (const [providerId, cfg] of Object.entries(configs)) {
    if (cfg.envVarName && resolveEnv(cfg.envVarName)) {
      installed.set(providerId, { providerId, installedAt: now });
    }
  }

  // (2) Best-effort union with the live module registry (additive).
  try {
    for (const m of getModelProviderModules()) {
      if (m.hasSystemKey() && !installed.has(m.providerId)) {
        installed.set(m.providerId, { providerId: m.providerId, installedAt: now });
      }
    }
  } catch {
    // Registry not available — the providers.json floor already applies.
  }

  // Pin a model deterministically from providers.json `defaultModel`, preferring
  // the capability order above, then any other env-matched provider that
  // declares a default.
  const pickModel = (providerId: string): string | null => {
    const cfg = configs[providerId];
    const dm = cfg?.defaultModel?.trim();
    if (cfg?.envVarName && resolveEnv(cfg.envVarName) && dm) {
      return dm.includes('/') ? dm : `${providerId}/${dm}`;
    }
    return null;
  };
  let model: string | null = null;
  for (const providerId of BUILDER_MODEL_PROVIDER_PREFERENCE) {
    model = pickModel(providerId);
    if (model) break;
  }
  if (!model) {
    for (const providerId of Object.keys(configs)) {
      model = pickModel(providerId);
      if (model) break;
    }
  }

  return { providers: [...installed.values()], model };
}

/**
 * Read the JSON-decoded `organization.metadata` for the given org. Returns an
 * empty object if the row is missing or the JSON is invalid. Replicated from
 * default-provisioning (its copy is module-private) so we read the same
 * `personal_org_for_user_id` marker tenant-safely.
 */
async function readOrgMetadata(
  sql: DbClient,
  organizationId: string
): Promise<Record<string, unknown>> {
  const rows = (await sql`
    SELECT metadata FROM "organization" WHERE id = ${organizationId} LIMIT 1
  `) as unknown as Array<{ metadata: string | null }>;
  const raw = rows[0]?.metadata;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Merge a sentinel key into `organization.metadata` and write it back as
 * JSON-text. Read-modify-write of the whole metadata blob, matching
 * default-provisioning's `writeOrgSentinel`.
 */
async function writeOrgSentinel(
  sql: DbClient,
  organizationId: string,
  key: string,
  value: string
): Promise<void> {
  const current = await readOrgMetadata(sql, organizationId);
  current[key] = value;
  const serialized = JSON.stringify(current);
  await sql`
    UPDATE "organization" SET metadata = ${serialized} WHERE id = ${organizationId}
  `;
}

/** Resolve the org's canonical owner from the personal-org metadata marker. */
async function resolveOwnerUserId(
  sql: DbClient,
  organizationId: string
): Promise<string | null> {
  const md = await readOrgMetadata(sql, organizationId);
  const raw = md['personal_org_for_user_id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Idempotently mirror ownership into agent_users and point the org at the
 * builder. The pointer is only written when currently NULL so an admin's
 * explicit `set_system_agent` choice is never clobbered.
 */
async function linkOwnerAndPointer(
  sql: DbClient,
  organizationId: string,
  ownerUserId: string | null
): Promise<void> {
  if (ownerUserId) {
    await sql`
      INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
      VALUES (${organizationId}, ${BUILDER_AGENT_ID}, 'external', ${ownerUserId}, now())
      ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
    `;
  }
  await sql`
    UPDATE "organization"
    SET system_agent_id = ${BUILDER_AGENT_ID}
    WHERE id = ${organizationId}
      AND system_agent_id IS NULL
  `;
}

/**
 * Provision the org's builder agent and point `organization.system_agent_id`
 * at it — creating it if missing, or healing it if a prior run left it with no
 * providers / no model.
 *
 * Behaviour:
 *   - Builder row present + has providers and a model → no-op (fast path).
 *   - Builder row present but missing providers/model → repair (fill the empty
 *     fields; never removes a working config).
 *   - Builder row absent + sentinel set → respect deletion (do NOT recreate).
 *   - Builder row absent + no sentinel → create.
 *
 * Idempotent and safe under concurrent replicas (ON CONFLICT / NULL-guarded
 * pointer / conditional repair). Best-effort: a thrown error is logged and
 * swallowed.
 */
export async function ensureBuilderAgent(
  organizationId: string,
  sql?: DbClient
): Promise<{ created: boolean }> {
  const client = sql ?? getDb();
  try {
    const rows = (await client`
      SELECT installed_providers, model FROM agents
      WHERE organization_id = ${organizationId} AND id = ${BUILDER_AGENT_ID}
      LIMIT 1
    `) as unknown as Array<{
      installed_providers: InstalledProvider[] | null;
      model: string | null;
    }>;
    const existing = rows[0];

    if (existing) {
      const providersEmpty =
        !Array.isArray(existing.installed_providers) ||
        existing.installed_providers.length === 0;
      const modelEmpty = !existing.model || String(existing.model).trim() === '';

      // Healthy — fast path (one SELECT), no provider-config read.
      if (!providersEmpty && !modelEmpty) {
        return { created: false };
      }

      // Heal: fill only the empty fields, and only with something non-empty.
      const resolved = await resolveBuilderProviders();
      const needProviders = providersEmpty && resolved.providers.length > 0;
      const needModel = modelEmpty && !!resolved.model;
      if (needProviders || needModel) {
        await client`
          UPDATE agents SET
            installed_providers = CASE WHEN ${needProviders}
              THEN ${client.json(resolved.providers)} ELSE installed_providers END,
            model = CASE WHEN ${needModel}
              THEN ${resolved.model} ELSE model END,
            updated_at = now()
          WHERE organization_id = ${organizationId} AND id = ${BUILDER_AGENT_ID}
        `;
        logger.info(
          { organizationId, needProviders, needModel, model: resolved.model },
          '[builder-provisioning] Repaired builder providers/model'
        );
      }
      await linkOwnerAndPointer(
        client,
        organizationId,
        await resolveOwnerUserId(client, organizationId)
      );
      return { created: false };
    }

    // Builder row absent. Respect deletion stickiness: a set sentinel means an
    // admin deleted the builder — do not recreate it.
    const provisioned = await hasOrgSentinel(
      organizationId,
      BUILDER_AGENT_SENTINEL,
      client
    );
    if (provisioned) {
      return { created: false };
    }

    const resolved = await resolveBuilderProviders();
    const ownerUserId = await resolveOwnerUserId(client, organizationId);

    await client`
      INSERT INTO agents (
        id, organization_id, name, identity_md,
        owner_platform, owner_user_id,
        installed_providers, model,
        created_at, updated_at
      ) VALUES (
        ${BUILDER_AGENT_ID}, ${organizationId}, ${BUILDER_AGENT_NAME}, ${BUILDER_AGENT_IDENTITY},
        'external', ${ownerUserId},
        ${client.json(resolved.providers)}, ${resolved.model},
        NOW(), NOW()
      )
      ON CONFLICT (organization_id, id) DO NOTHING
    `;

    await linkOwnerAndPointer(client, organizationId, ownerUserId);

    await writeOrgSentinel(
      client,
      organizationId,
      BUILDER_AGENT_SENTINEL,
      new Date().toISOString()
    );

    logger.info(
      {
        organizationId,
        agentId: BUILDER_AGENT_ID,
        ownerUserId,
        providers: resolved.providers.length,
        model: resolved.model,
      },
      '[builder-provisioning] Provisioned builder agent'
    );
    return { created: true };
  } catch (err) {
    logger.warn(
      {
        organizationId,
        err: err instanceof Error ? err.message : String(err),
      },
      '[builder-provisioning] Builder-agent provisioning failed (non-fatal)'
    );
    return { created: false };
  }
}
