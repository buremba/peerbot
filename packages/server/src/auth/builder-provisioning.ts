/**
 * Builder-agent auto-provisioning.
 *
 * Every org gets a dedicated "builder" agent — the org's setup/console agent
 * that manages agents, connections, watchers, and workflows on the user's
 * behalf. `organization.system_agent_id` points at it.
 *
 * Mirrors `default-provisioning.ts` exactly:
 *   - installs system-key model providers up front (so the agent can chat the
 *     moment it's created, instead of "No model configured"),
 *   - attributes ownership to the personal-org owner via the
 *     `personal_org_for_user_id` org-metadata marker,
 *   - writes a sentinel into `organization.metadata` so a deleted builder agent
 *     is NOT auto-recreated,
 *   - is best-effort / non-throwing: a failure here must never break the boot
 *     or signup path that called us.
 *
 * The agents PK is composite `(organization_id, id)`, so the same
 * `BUILDER_AGENT_ID` string per org is fine. The `system_agent_id` pointer is
 * only set when currently NULL — we never clobber an admin's explicit choice
 * (set via `manage_agents.set_system_agent`).
 */

import { getDb } from '../db/client';
import type { DbClient } from '../db/client';
import { getModelProviderModules } from '../gateway/modules/module-system';
import { collectProviderModelOptions } from '../gateway/auth/provider-model-options';
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

/**
 * Provision the org's builder agent and point `organization.system_agent_id`
 * at it, exactly once.
 *
 * Guards on the create path:
 *   1. Sentinel in `organization.metadata` (deletion stickiness — a deleted
 *      builder agent is NOT auto-recreated).
 *   2. ON CONFLICT (organization_id, id) DO NOTHING on the agents PK (guards a
 *      parallel boot / concurrent signup).
 *
 * The `system_agent_id` pointer is only written when it's currently NULL, so an
 * admin who later repoints it via `manage_agents.set_system_agent` is never
 * clobbered on a subsequent boot.
 *
 * Best-effort: a thrown error is logged and swallowed.
 */
export async function ensureBuilderAgent(
  organizationId: string,
  sql?: DbClient
): Promise<{ created: boolean }> {
  const client = sql ?? getDb();
  try {
    const provisioned = await hasOrgSentinel(
      organizationId,
      BUILDER_AGENT_SENTINEL,
      client
    );
    if (provisioned) {
      return { created: false };
    }

    // Resolve the set of model providers that have a system-level credential
    // available at this boot and install them onto the builder agent up front.
    // Without this, the row exists but `installed_providers = '[]'` and chatting
    // with the builder agent would immediately hit "No model configured" — even
    // though the env keys are sitting right there in the same process.
    const systemProviders = getModelProviderModules()
      .filter((m) => m.hasSystemKey())
      .map((m) => ({
        providerId: m.providerId,
        installedAt: Date.now(),
      }));

    // Pin an explicit model so the builder can chat the moment it's created.
    // Auto-mode no longer silently picks a provider default (an explicit model
    // is required), so without this the first turn hits "No model selected".
    // Pick the first installed system provider that exposes a model list and
    // pin its first option as `provider/model` (the format resolveEffectiveModelRef
    // expects). Best-effort: if nothing resolves, leave the model unset — the
    // owner then picks one in the agent's Providers settings, same as any agent.
    let pinnedModel: string | null = null;
    try {
      const optionsByProvider = await collectProviderModelOptions('', '');
      for (const p of systemProviders) {
        const first = optionsByProvider[p.providerId]?.[0]?.value?.trim();
        if (first) {
          pinnedModel = first.includes('/') ? first : `${p.providerId}/${first}`;
          break;
        }
      }
    } catch (err) {
      logger.warn(
        { organizationId, err: err instanceof Error ? err.message : String(err) },
        '[builder-provisioning] Default-model resolution failed; leaving model unset'
      );
    }

    // Resolve the owning user from the canonical personal-org marker, so the
    // per-user ownership check in `verifyOwnedAgentAccess` recognizes the owner
    // as the builder agent's owner.
    const orgMetadata = await readOrgMetadata(client, organizationId);
    const ownerForInsertRaw = orgMetadata['personal_org_for_user_id'];
    const ownerUserId =
      typeof ownerForInsertRaw === 'string' && ownerForInsertRaw.length > 0
        ? ownerForInsertRaw
        : null;

    await client`
      INSERT INTO agents (
        id, organization_id, name, identity_md,
        owner_platform, owner_user_id,
        installed_providers, model,
        created_at, updated_at
      ) VALUES (
        ${BUILDER_AGENT_ID}, ${organizationId}, ${BUILDER_AGENT_NAME}, ${BUILDER_AGENT_IDENTITY},
        'external', ${ownerUserId},
        ${client.json(systemProviders)}, ${pinnedModel},
        NOW(), NOW()
      )
      ON CONFLICT (organization_id, id) DO NOTHING
    `;

    // Mirror the ownership into agent_users so the per-user ownership path
    // (cookie/PAT session) recognizes the owner as the builder agent's owner.
    if (ownerUserId) {
      await client`
        INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
        VALUES (${organizationId}, ${BUILDER_AGENT_ID}, 'external', ${ownerUserId}, now())
        ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
      `;
    }

    // Point the org at the builder agent — but only if no pointer is set yet.
    // An admin who repointed `system_agent_id` (via manage_agents) must not be
    // clobbered.
    await client`
      UPDATE "organization"
      SET system_agent_id = ${BUILDER_AGENT_ID}
      WHERE id = ${organizationId}
        AND system_agent_id IS NULL
    `;

    await writeOrgSentinel(
      client,
      organizationId,
      BUILDER_AGENT_SENTINEL,
      new Date().toISOString()
    );

    logger.info(
      { organizationId, agentId: BUILDER_AGENT_ID, ownerUserId },
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
