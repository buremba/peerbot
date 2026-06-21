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
import { collectProviderModelOptions } from '../gateway/auth/provider-model-options';
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
 * Preference for the builder's *pinned* model among providers declared in
 * config/providers.json. We pin the first provider here that (a) has a system
 * key in this environment and (b) declares a `defaultModel`. These ids are
 * config-maintained, so they stay current without a code change. Providers not
 * listed are still installed; they just aren't preferred for the initial pin.
 */
const BUILDER_MODEL_PROVIDER_PREFERENCE = [
  'openai',
  'gemini',
  'groq',
  'mistral',
  'deepseek',
  'cohere',
  'xai',
];

/**
 * Anthropic/Claude is the canonical platform provider but is intentionally NOT
 * in config/providers.json (its model list is fetched live from the provider).
 * Resolve it directly from its env vars so an Anthropic-only deployment still
 * gets a working builder even when the live module registry is empty. The
 * fallback model is a last resort, used only when no config-declared provider
 * model is available — prod also carries openai/gemini keys, so it pins one of
 * those instead and this snapshot is rarely reached.
 */
const CLAUDE_PROVIDER_ID = 'claude';
const CLAUDE_SYSTEM_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
const CLAUDE_FALLBACK_MODEL = 'claude/claude-sonnet-4-6';

function hasClaudeSystemKey(): boolean {
  return CLAUDE_SYSTEM_ENV_VARS.some((v) => !!resolveEnv(v));
}

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

  // (2) Anthropic/Claude — the canonical platform provider, not in
  // providers.json. Resolve it from its env vars directly so an Anthropic-only
  // deployment still gets a provider, registry or not.
  if (hasClaudeSystemKey()) {
    installed.set(CLAUDE_PROVIDER_ID, {
      providerId: CLAUDE_PROVIDER_ID,
      installedAt: now,
    });
  }

  // (3) Best-effort union with the live module registry (additive — picks up
  // any further providers it knows about when it happens to be initialized).
  try {
    for (const m of getModelProviderModules()) {
      if (m.hasSystemKey() && !installed.has(m.providerId)) {
        installed.set(m.providerId, { providerId: m.providerId, installedAt: now });
      }
    }
  } catch {
    // Registry not available — the providers.json + Claude floor already applies.
  }

  // Pin a model deterministically from providers.json `defaultModel`, preferring
  // the capability order above, then any other env-matched provider that
  // declares a default.
  const pickModel = (providerId: string): string | null => {
    const cfg = configs[providerId];
    const dm = cfg?.defaultModel?.trim();
    if (cfg?.envVarName && resolveEnv(cfg.envVarName) && dm) {
      // A model ref is parsed as `providerId/<rest>` (split on the FIRST slash),
      // and a model id can itself contain slashes (e.g. openrouter's
      // `anthropic/claude-sonnet-4`, together-ai's `meta-llama/...`). Always
      // prefix the providerId so the ref resolves to the right provider.
      return `${providerId}/${dm}`;
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
  // Module-only providers that aren't in providers.json (e.g. Bedrock) declare
  // their model only via the live registry. This is reached only when no
  // config-declared provider resolved a model — i.e. a module-only deployment,
  // where the registry is populated by definition (those providers came from
  // it). Best-effort; covers any such provider generically.
  if (!model && installed.size > 0) {
    try {
      const optionsByProvider = await collectProviderModelOptions('', '');
      for (const { providerId } of installed.values()) {
        const first = optionsByProvider[providerId]?.[0]?.value?.trim();
        if (first) {
          model = first.startsWith(`${providerId}/`)
            ? first
            : `${providerId}/${first}`;
          break;
        }
      }
    } catch {
      // Registry/model fetch unavailable — fall through to the Claude floor.
    }
  }
  // Registry-independent floor: Claude has no providers.json default, so pin a
  // current snapshot when it's the only system key available and nothing above
  // resolved (e.g. an Anthropic-only deploy with an empty registry).
  if (!model && hasClaudeSystemKey()) {
    model = CLAUDE_FALLBACK_MODEL;
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

      // Heal providers/model only when broken, keeping providers + model
      // CONSISTENT — the pinned model's provider must always be installed, so we
      // never leave a dangling ref (e.g. model=openai/... with providers=[claude]).
      // The healthy path skips this provider-config read entirely.
      if (providersEmpty || modelEmpty) {
        const resolved = await resolveBuilderProviders();
        const existingProviders: InstalledProvider[] = Array.isArray(
          existing.installed_providers
        )
          ? existing.installed_providers
          : [];
        // Keep an existing model if present, otherwise take the resolved pick.
        const newModel = modelEmpty ? resolved.model : existing.model;
        // Providers = existing ∪ resolved, plus the (new) model's own provider.
        const providerMap = new Map<string, InstalledProvider>();
        for (const p of existingProviders) providerMap.set(p.providerId, p);
        for (const p of resolved.providers) {
          if (!providerMap.has(p.providerId)) providerMap.set(p.providerId, p);
        }
        if (newModel) {
          const slash = newModel.indexOf('/');
          const modelProviderId = slash > 0 ? newModel.slice(0, slash) : '';
          if (modelProviderId && !providerMap.has(modelProviderId)) {
            providerMap.set(modelProviderId, {
              providerId: modelProviderId,
              installedAt: Date.now(),
            });
          }
        }
        const mergedProviders = [...providerMap.values()];
        // Union only ever grows, so a length change means we added a provider.
        const writeProviders =
          mergedProviders.length !== existingProviders.length;
        const writeModel = modelEmpty && !!newModel;
        if (writeProviders || writeModel) {
          await client`
            UPDATE agents SET
              installed_providers = CASE WHEN ${writeProviders}
                THEN ${client.json(mergedProviders)} ELSE installed_providers END,
              model = CASE WHEN ${writeModel}
                THEN ${newModel} ELSE model END,
              updated_at = now()
            WHERE organization_id = ${organizationId} AND id = ${BUILDER_AGENT_ID}
          `;
          logger.info(
            { organizationId, writeProviders, writeModel, model: newModel },
            '[builder-provisioning] Repaired builder providers/model'
          );
        }
      }

      // Reconcile ownership + pointer + sentinel on every call — cheap idempotent
      // writes that heal a builder whose create crashed between the INSERT and
      // the follow-up writes (NULL system_agent_id, missing agent_users row, or
      // missing deletion sentinel). Metadata is read once.
      const md = await readOrgMetadata(client, organizationId);
      const ownerRaw = md['personal_org_for_user_id'];
      const ownerUserId =
        typeof ownerRaw === 'string' && ownerRaw.length > 0 ? ownerRaw : null;
      await linkOwnerAndPointer(client, organizationId, ownerUserId);
      if (!md[BUILDER_AGENT_SENTINEL]) {
        await writeOrgSentinel(
          client,
          organizationId,
          BUILDER_AGENT_SENTINEL,
          new Date().toISOString()
        );
      }
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
