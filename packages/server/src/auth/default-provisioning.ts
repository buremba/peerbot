/**
 * Default agent + watcher auto-provisioning for the Mac-app bootstrap org.
 *
 * The Owletto Mac app's onboarding expects a usable agent + a daily watcher
 * already wired up the first time the device polls. Without this, the user
 * lands on an empty dashboard and has no clear next step.
 *
 * Sticky against deletion: a sentinel timestamp is written to
 * `organization.metadata` (JSON-as-text) per provisioning step. If the user
 * later deletes the agent or watcher via the web UI, the sentinel stays —
 * we do NOT auto-recreate. The sentinels live alongside the existing
 * `personal_org_for_user_id` marker so we keep one source of truth for
 * org-scoped lifecycle flags.
 *
 * Provisioning timing:
 *   - **Agent** is provisioned at server boot, immediately after
 *     `ensureBootstrapPat` lands the bootstrap user/org/member.
 *   - **Watcher** is provisioned the first time the user's Mac device
 *     polls `/api/workers/poll` (when the device_workers row is freshly
 *     INSERTed). Deferring it is what lets us pin the watcher to that
 *     exact device via `device_worker_id`.
 */

import { getDb } from '../db/client';
import type { DbClient } from '../db/client';
import { getNextNumericId } from '../tools/admin/helpers/db-helpers';
import { nextRunAt } from '../utils/cron';
import logger from '../utils/logger';

export const DEFAULT_AGENT_SENTINEL = 'default_agent_provisioned';
export const DEFAULT_WATCHER_SENTINEL = 'default_watcher_provisioned';

export const DEFAULT_AGENT_ID = 'owletto-default';
export const DEFAULT_AGENT_NAME = 'Owletto Personal';
export const DEFAULT_AGENT_IDENTITY =
  "You are the user's personal assistant on their Mac. " +
  'You help them stay productive by surfacing relevant context ' +
  'and useful summaries. ' +
  "If you don't have access to recent history or context, say so " +
  'clearly and suggest what the user could connect or track next.';

export const DEFAULT_WATCHER_SLUG = 'daily-checkin';
export const DEFAULT_WATCHER_NAME = 'Daily check-in';
export const DEFAULT_WATCHER_SCHEDULE = '0 9 * * *';
export const DEFAULT_WATCHER_PROMPT =
  'Summarize what the user worked on yesterday in 1-2 sentences. ' +
  'Suggest 1-3 concrete priorities for today. ' +
  "If you don't have recent history or context for this user, " +
  'say that clearly and suggest what the user could connect ' +
  'or track next (calendar, browser activity, etc.).';

export const DEFAULT_WATCHER_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
};

/**
 * Read the JSON-decoded `organization.metadata` for the given org.
 * Returns an empty object if the row is missing or the JSON is invalid.
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
    // Defensive: legacy rows might hold non-JSON text. Treat as empty so the
    // sentinel-write below produces a valid JSON object going forward.
    logger.warn({ organizationId }, '[default-provisioning] organization.metadata is not valid JSON; resetting');
    return {};
  }
}

/**
 * Merge a sentinel key into `organization.metadata` and write it back as
 * JSON-text. Idempotent: if the sentinel is already present, it's a no-op
 * relative to the value (we overwrite with the current timestamp, but the
 * key presence is what we read for the existence check).
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
 * True when the sentinel key is present in `organization.metadata` — meaning
 * we previously ran this provisioning step for this org and must NOT re-run
 * it even if the row it created has since been deleted.
 */
export async function hasOrgSentinel(
  organizationId: string,
  key: string,
  sql?: DbClient
): Promise<boolean> {
  const client = sql ?? getDb();
  const metadata = await readOrgMetadata(client, organizationId);
  return key in metadata;
}

/**
 * Provision the default Owletto agent for the given org, exactly once.
 *
 * Three guards stack:
 *   1. Sentinel in `organization.metadata` (deletion stickiness).
 *   2. No existing agents in the org (don't graft Owletto's defaults onto an
 *      org that's already curated agents by hand).
 *   3. ON CONFLICT (organization_id, id) DO NOTHING on the agents PK.
 *
 * Best-effort: a thrown error is logged and swallowed. A failure here must
 * not break the boot path that called us.
 */
export async function ensureDefaultAgent(
  organizationId: string,
  sql?: DbClient
): Promise<{ created: boolean; reason: 'sentinel' | 'has_agents' | 'inserted' }> {
  const client = sql ?? getDb();
  try {
    const provisioned = await hasOrgSentinel(organizationId, DEFAULT_AGENT_SENTINEL, client);
    if (provisioned) {
      return { created: false, reason: 'sentinel' };
    }

    const existingAgents = (await client`
      SELECT 1 FROM agents WHERE organization_id = ${organizationId} LIMIT 1
    `) as unknown as Array<unknown>;
    if (existingAgents.length > 0) {
      // Still write the sentinel so we don't re-check on every boot.
      await writeOrgSentinel(
        client,
        organizationId,
        DEFAULT_AGENT_SENTINEL,
        new Date().toISOString()
      );
      return { created: false, reason: 'has_agents' };
    }

    // Insert the default agent. The PK is (organization_id, id) so we can
    // ON CONFLICT DO NOTHING to guard against a parallel boot.
    await client`
      INSERT INTO agents (
        id, organization_id, name, identity_md,
        owner_platform, owner_user_id, is_workspace_agent,
        created_at, updated_at
      ) VALUES (
        ${DEFAULT_AGENT_ID}, ${organizationId}, ${DEFAULT_AGENT_NAME}, ${DEFAULT_AGENT_IDENTITY},
        'lobu', NULL, false,
        NOW(), NOW()
      )
      ON CONFLICT (organization_id, id) DO NOTHING
    `;

    await writeOrgSentinel(
      client,
      organizationId,
      DEFAULT_AGENT_SENTINEL,
      new Date().toISOString()
    );

    logger.info(
      { organizationId, agentId: DEFAULT_AGENT_ID },
      '[default-provisioning] Provisioned default agent'
    );
    return { created: true, reason: 'inserted' };
  } catch (err) {
    logger.warn(
      { organizationId, err: err instanceof Error ? err.message : String(err) },
      '[default-provisioning] Default-agent provisioning failed (non-fatal)'
    );
    return { created: false, reason: 'sentinel' };
  }
}

/**
 * Provision the default daily-check-in watcher for the bootstrap org, pinned
 * to the given device worker, exactly once.
 *
 * Deferred to the first `/api/workers/poll` from the user's first Mac so the
 * `device_worker_id` lane is set correctly — the dispatcher then skips this
 * watcher and only the matching device claims it via poll.
 *
 * Same three guards as `ensureDefaultAgent`: org sentinel, fall-back slug
 * uniqueness check, and the watchers (organization_id, slug) constraint
 * (enforced manually via SELECT + INSERT in a transaction).
 *
 * Best-effort: errors are logged and swallowed so a partial provisioning
 * failure doesn't break the poll response.
 */
export async function ensureDefaultWatcher(params: {
  organizationId: string;
  agentId: string;
  deviceWorkerId: string;
  sql?: DbClient;
}): Promise<{ created: boolean; reason: 'sentinel' | 'slug_taken' | 'inserted' | 'no_agent' }> {
  const sql = params.sql ?? getDb();
  try {
    const provisioned = await hasOrgSentinel(
      params.organizationId,
      DEFAULT_WATCHER_SENTINEL,
      sql
    );
    if (provisioned) {
      return { created: false, reason: 'sentinel' };
    }

    // The agent we pin to must actually exist. If the user deleted the
    // default agent before the device first polled, fall back to ANY agent
    // in the org so the watcher still has a valid foreign key. If there's
    // no agent at all (zombied org), set the sentinel and skip — there's
    // nothing useful we can wire up.
    const agentRows = (await sql`
      SELECT id FROM agents
      WHERE organization_id = ${params.organizationId}
        AND id = ${params.agentId}
      LIMIT 1
    `) as unknown as Array<{ id: string }>;
    let resolvedAgentId = agentRows[0]?.id ?? null;
    if (!resolvedAgentId) {
      const fallback = (await sql`
        SELECT id FROM agents
        WHERE organization_id = ${params.organizationId}
        ORDER BY created_at ASC
        LIMIT 1
      `) as unknown as Array<{ id: string }>;
      resolvedAgentId = fallback[0]?.id ?? null;
    }
    if (!resolvedAgentId) {
      await writeOrgSentinel(
        sql,
        params.organizationId,
        DEFAULT_WATCHER_SENTINEL,
        new Date().toISOString()
      );
      return { created: false, reason: 'no_agent' };
    }

    // Slug-uniqueness guard (matches the implicit uniqueness handleCreate enforces).
    const slugClash = (await sql`
      SELECT 1 FROM watchers
      WHERE organization_id = ${params.organizationId}
        AND slug = ${DEFAULT_WATCHER_SLUG}
      LIMIT 1
    `) as unknown as Array<unknown>;
    if (slugClash.length > 0) {
      await writeOrgSentinel(
        sql,
        params.organizationId,
        DEFAULT_WATCHER_SENTINEL,
        new Date().toISOString()
      );
      return { created: false, reason: 'slug_taken' };
    }

    // The `watchers.created_by` FK references `user(id)` ON DELETE RESTRICT.
    // Pick the org owner (any member with role='owner', falling back to any
    // member) so the row stays attributable. The `system` user fallback is
    // for tests and local dev where the bootstrap path may not have run yet.
    const createdByRows = (await sql`
      SELECT "userId" FROM "member"
      WHERE "organizationId" = ${params.organizationId}
      ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END ASC, "createdAt" ASC
      LIMIT 1
    `) as unknown as Array<{ userId: string }>;
    const ownerUserId = createdByRows[0]?.userId ?? null;
    let createdBy: string | null = ownerUserId;
    if (!createdBy) {
      const systemRows = (await sql`
        SELECT id FROM "user" WHERE id = 'system' LIMIT 1
      `) as unknown as Array<{ id: string }>;
      createdBy = systemRows[0]?.id ?? null;
    }
    if (!createdBy) {
      logger.warn(
        { organizationId: params.organizationId },
        '[default-provisioning] No user available to attribute watcher creation — skipping'
      );
      await writeOrgSentinel(
        sql,
        params.organizationId,
        DEFAULT_WATCHER_SENTINEL,
        new Date().toISOString()
      );
      return { created: false, reason: 'no_agent' };
    }

    const extractionSchema = DEFAULT_WATCHER_EXTRACTION_SCHEMA;
    const sources = [
      { name: 'content', query: 'SELECT * FROM events ORDER BY occurred_at DESC' },
    ];

    await sql.begin(async (tx) => {
      const watcherId = await getNextNumericId(tx, 'watchers');
      const versionId = await getNextNumericId(tx, 'watcher_versions');
      const scheduledNextRun = nextRunAt(DEFAULT_WATCHER_SCHEDULE);

      await tx`
        INSERT INTO watchers (
          id, name, slug, organization_id, entity_ids,
          schedule, next_run_at, agent_id, scheduler_client_id, model_config, sources, version,
          current_version_id, tags, status, created_by, created_at, updated_at,
          watcher_group_id,
          device_worker_id, agent_kind,
          notification_channel, notification_priority, min_cooldown_seconds
        ) VALUES (
          ${watcherId}, ${DEFAULT_WATCHER_NAME}, ${DEFAULT_WATCHER_SLUG},
          ${params.organizationId}, ${'{}'}::bigint[],
          ${DEFAULT_WATCHER_SCHEDULE}, ${scheduledNextRun},
          ${resolvedAgentId}, NULL,
          ${tx.json({})}, ${tx.json(sources)},
          1, NULL, ${'{}'}::text[],
          'active', ${createdBy}, NOW(), NOW(),
          ${watcherId},
          ${params.deviceWorkerId}::uuid, NULL,
          'canvas', 'normal', 3600
        )
      `;

      await tx`
        INSERT INTO watcher_versions (
          id, watcher_id, version, name, description,
          prompt, extraction_schema, version_sources,
          json_template, keying_config, classifiers,
          condensation_prompt, condensation_window_count,
          reactions_guidance, change_notes, created_by, created_at
        ) VALUES (
          ${versionId}, ${watcherId}, 1, ${DEFAULT_WATCHER_NAME}, NULL,
          ${DEFAULT_WATCHER_PROMPT}, ${tx.json(extractionSchema)}, ${tx.json(sources)},
          NULL, NULL, NULL,
          NULL, NULL,
          NULL, 'Initial version', ${createdBy}, NOW()
        )
      `;

      await tx`
        UPDATE watchers
        SET current_version_id = ${versionId}
        WHERE id = ${watcherId}
      `;
    });

    await writeOrgSentinel(
      sql,
      params.organizationId,
      DEFAULT_WATCHER_SENTINEL,
      new Date().toISOString()
    );

    logger.info(
      {
        organizationId: params.organizationId,
        agentId: resolvedAgentId,
        deviceWorkerId: params.deviceWorkerId,
        slug: DEFAULT_WATCHER_SLUG,
      },
      '[default-provisioning] Provisioned default watcher pinned to device'
    );
    return { created: true, reason: 'inserted' };
  } catch (err) {
    logger.warn(
      {
        organizationId: params.organizationId,
        deviceWorkerId: params.deviceWorkerId,
        err: err instanceof Error ? err.message : String(err),
      },
      '[default-provisioning] Default-watcher provisioning failed (non-fatal)'
    );
    return { created: false, reason: 'sentinel' };
  }
}
