/**
 * Version management action handlers for manage_watchers:
 *   create_version, upgrade, get_versions, get_version_details
 */

import { getDb } from '../../../db/client';
import { nextRunAt, validateSchedule } from '../../../utils/cron';
import { resolveUsernames } from '../../../utils/resolve-usernames';
import { getNextNumericId } from '../helpers/db-helpers';
import type { ToolContext } from '../../registry';
import type { ManageWatchersArgs, ManageWatchersResult } from '../manage_watchers';
import {
  assertWatcherVersionConfigValid,
  parseJsonInput,
  parseJson,
  normalizeStoredJsonField,
  toJsonParam,
} from './shared';

// ============================================
// handleCreateVersion
// ============================================

export async function handleCreateVersion(
  args: ManageWatchersArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<{
  action: 'create_version';
  watcher_id: string;
  version_id: string;
  version: number;
  previous_version: number;
}> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for create_version action');
  }

  // Get current watcher + resolve the group root. Versioned config
  // (prompt/schema/template/classifiers) is shared across the entire group
  // and version rows live on the group root, so we read from and write to
  // `watcher_id = watcher_group_id`. The arg's watcher_id is only used to
  // identify the group and to apply the per-assignment writes (sources,
  // schedule, scheduler_client_id) to that specific row.
  const watcherRows = await sql`
    SELECT i.id, i.version, i.current_version_id, i.watcher_group_id, i.sources
    FROM watchers i WHERE i.id = ${args.watcher_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Watcher ${args.watcher_id} not found`);
  }

  const groupId = Number(watcherRows[0].watcher_group_id);
  const previousVersion = Number(watcherRows[0].version);
  const nextVersion = previousVersion + 1;

  // Load current version (from the group root's chain) to inherit fields
  // the caller didn't specify.
  const prevRows = await sql`
    SELECT
      name, description, prompt, extraction_schema, version_sources,
      json_template, keying_config, classifiers,
      reactions_guidance, condensation_prompt, condensation_window_count
    FROM watcher_versions
    WHERE watcher_id = ${groupId}
    ORDER BY version DESC LIMIT 1
  `;
  if (prevRows.length === 0) {
    throw new Error(
      `No previous version found for watcher group ${groupId}. ` +
        'This group is missing version rows on its root — likely a stale clone from before the version-sharing refactor. Run cleanup or create a fresh watcher.'
    );
  }
  const prev = prevRows[0] as Record<string, unknown>;

  const prompt = args.prompt ?? (prev.prompt as string);
  const extractionSchema =
    parseJsonInput<Record<string, unknown>>(args.extraction_schema, 'extraction_schema') ??
    normalizeStoredJsonField(prev.extraction_schema, {} as Record<string, unknown>);
  // Sources are per-assignment now. When the caller omits args.sources we
  // keep the seed watcher's existing sources; we deliberately do not fall
  // back to prev.version_sources from the prior version row, because
  // version_sources is no longer written and is a vestigial column.
  const sources =
    args.sources ??
    normalizeStoredJsonField(
      watcherRows[0].sources,
      [] as Array<{ name: string; query: string }>
    );
  const jsonTemplate =
    parseJsonInput<unknown>(args.json_template, 'json_template') ??
    normalizeStoredJsonField(prev.json_template, undefined as unknown);
  const keyingConfig =
    parseJsonInput<Record<string, unknown>>(args.keying_config, 'keying_config') ??
    normalizeStoredJsonField(prev.keying_config, undefined as Record<string, unknown> | undefined);
  const classifiers =
    parseJsonInput<unknown[]>(args.classifiers, 'classifiers') ??
    normalizeStoredJsonField(prev.classifiers, undefined as unknown[] | undefined);

  // Validate
  assertWatcherVersionConfigValid({ prompt, extractionSchema, classifiers, sources });

  if (args.schedule) {
    const scheduleError = validateSchedule(args.schedule);
    if (scheduleError) {
      throw new Error(scheduleError);
    }
  }

  const createdBy = ctx.userId ?? 'system';
  let versionId = 0;
  let lockedNextVersion = nextVersion;
  await sql.begin(async (tx) => {
    // Serialize concurrent create_version calls on the same group. The
    // unique (watcher_id, version) index would otherwise reject one of two
    // simultaneous N+1 inserts and surface as a 500. The advisory lock is
    // tx-scoped (auto-released on commit/rollback) and keyed by group id,
    // so unrelated groups are unaffected.
    await tx`SELECT pg_advisory_xact_lock(hashtext('watcher_create_version'), ${groupId})`;

    // Re-resolve the latest id and version under the lock so we don't race
    // with a call that already committed while we were computing nextVersion.
    versionId = await getNextNumericId(tx, 'watcher_versions');
    const latestRows = await tx`
      SELECT MAX(version) AS v FROM watcher_versions WHERE watcher_id = ${groupId}
    `;
    lockedNextVersion =
      latestRows.length > 0 && latestRows[0].v != null ? Number(latestRows[0].v) + 1 : nextVersion;

    // The new version row is owned by the group root, not the assignment
    // the caller named. Every watcher in the group will later point at
    // this row via current_version_id.
    // version_sources is intentionally NULL on the new version row: sources
    // are per-assignment now, so storing one assignment's sources in the
    // shared version row would let one assignment's source list override
    // every other assignment's sources via get_content's preference order.
    // get_content falls through to watchers.sources when version_sources is
    // empty, which is the right per-assignment behavior.
    await tx`
      INSERT INTO watcher_versions (
        id, watcher_id, version, name, description,
        prompt, extraction_schema, version_sources,
        json_template, keying_config, classifiers,
        condensation_prompt, condensation_window_count,
        reactions_guidance, change_notes, created_by, created_at
      ) VALUES (
        ${versionId}, ${groupId}, ${lockedNextVersion},
        ${args.name ?? (prev.name as string) ?? 'Watcher'},
        ${args.description !== undefined ? (args.description ?? null) : ((prev.description as string) ?? null)},
        ${prompt}, ${toJsonParam(tx, extractionSchema)}, NULL,
        ${toJsonParam(tx, jsonTemplate)}, ${toJsonParam(tx, keyingConfig)}, ${toJsonParam(tx, classifiers)},
        ${args.condensation_prompt ?? (prev.condensation_prompt as string) ?? null},
        ${args.condensation_window_count ?? (prev.condensation_window_count as number) ?? null},
        ${args.reactions_guidance ?? (prev.reactions_guidance as string) ?? null},
        ${args.change_notes ?? null}, ${createdBy}, NOW()
      )
    `;

    // Update watcher to new version if set_as_current (default: true).
    // Group-shared fields (current_version_id, version, name) cascade to
    // every watcher in the group; per-assignment fields (sources,
    // schedule, scheduler_client_id) update only the targeted row.
    const setAsCurrent = args.set_as_current !== false;
    if (setAsCurrent) {
      const shouldUpdateSchedule = args.schedule !== undefined;
      const scheduleValue = shouldUpdateSchedule ? args.schedule || null : null;
      const nextRunAtVal = scheduleValue ? nextRunAt(scheduleValue) : null;

      // Group-shared cascade
      await tx`
        UPDATE watchers
        SET
          current_version_id = ${versionId},
          version = ${lockedNextVersion},
          name = ${args.name ?? (prev.name as string)},
          updated_at = NOW()
        WHERE watcher_group_id = ${groupId}
      `;

      // Per-assignment writes (only the row the caller named)
      await tx`
        UPDATE watchers
        SET
          sources = ${tx.json(sources)},
          scheduler_client_id = CASE WHEN ${args.scheduler_client_id !== undefined} THEN ${args.scheduler_client_id ?? null} ELSE scheduler_client_id END,
          schedule = CASE WHEN ${shouldUpdateSchedule} THEN ${scheduleValue} ELSE schedule END,
          next_run_at = CASE WHEN ${shouldUpdateSchedule} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END
        WHERE id = ${args.watcher_id}
      `;
    }
  });

  return {
    action: 'create_version',
    watcher_id: args.watcher_id,
    version_id: String(versionId),
    version: lockedNextVersion,
    previous_version: previousVersion,
  };
}

// ============================================
// handleUpgrade
// ============================================

export async function handleUpgrade(
  args: ManageWatchersArgs,
  _env: unknown
): Promise<{
  action: 'upgrade';
  watcher_id: string;
  version: number;
  previous_version: number;
}> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for upgrade action');
  }
  if (args.target_version === undefined) {
    throw new Error('target_version is required for upgrade action');
  }

  // Get current watcher version
  const watcherRows = await sql`
    SELECT i.id, i.version, i.current_version_id
    FROM watchers i WHERE i.id = ${args.watcher_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Watcher ${args.watcher_id} not found`);
  }
  const previousVersion = Number(watcherRows[0].version);

  // Find target version
  const versionRows = await sql`
    SELECT id, version, version_sources
    FROM watcher_versions
    WHERE watcher_id = ${args.watcher_id} AND version = ${args.target_version}
    LIMIT 1
  `;
  if (versionRows.length === 0) {
    throw new Error(`Version ${args.target_version} not found for watcher ${args.watcher_id}`);
  }

  const newVersionId = versionRows[0].id;
  const versionSources = parseJson(versionRows[0].version_sources);

  // Update watcher to point to the new version
  await sql`
    UPDATE watchers
    SET
      current_version_id = ${newVersionId},
      version = ${args.target_version},
      sources = ${sql.json(versionSources || [])},
      updated_at = NOW()
    WHERE id = ${args.watcher_id}
  `;

  return {
    action: 'upgrade',
    watcher_id: args.watcher_id,
    version: args.target_version,
    previous_version: previousVersion,
  };
}

// ============================================
// handleGetVersions
// ============================================

export async function handleGetVersions(args: ManageWatchersArgs): Promise<{
  action: 'get_versions';
  watcher_id: string;
  versions: any[];
}> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for get_versions action');
  }

  const watcherRows = await sql`
    SELECT id, name, slug, current_version_id, watcher_group_id FROM watchers WHERE id = ${args.watcher_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Watcher ${args.watcher_id} not found`);
  }

  const currentVersionId = watcherRows[0].current_version_id;
  // Version rows live on the group root (watcher_group_id), not on each
  // assignment — see handleCreateVersion. Resolve the root so get_versions
  // works for assignments created via create_from_version.
  const groupId = Number(watcherRows[0].watcher_group_id ?? watcherRows[0].id);

  const versionRows = await sql`
    SELECT
      v.id as version_id,
      v.version,
      v.name,
      v.description,
      v.created_at,
      v.created_by,
      v.change_notes
    FROM watcher_versions v
    WHERE v.watcher_id = ${groupId}
    ORDER BY v.version DESC
  `;

  const resolvedRows = await resolveUsernames(
    versionRows as unknown as Record<string, unknown>[],
    'created_by'
  );

  const versions = resolvedRows.map((row: any) => ({
    version_id: String(row.version_id),
    version: Number(row.version),
    name: row.name,
    description: row.description,
    is_current: Number(row.version_id) === Number(currentVersionId),
    created_at: row.created_at,
    created_by: row.created_by_username || row.created_by,
    change_notes: row.change_notes,
  }));

  return {
    action: 'get_versions',
    watcher_id: args.watcher_id,
    versions,
  };
}

// ============================================
// handleGetVersionDetails
// ============================================

export async function handleGetVersionDetails(
  args: ManageWatchersArgs
): Promise<ManageWatchersResult> {
  const sql = getDb();

  if (!args.watcher_id) {
    throw new Error('watcher_id is required for get_version_details action');
  }

  let rows;
  if (args.version !== undefined) {
    rows = await sql`
      SELECT
        id, version, name, description, prompt,
        extraction_schema, version_sources, json_template,
        keying_config, classifiers,
        condensation_prompt, condensation_window_count,
        reactions_guidance
      FROM watcher_versions
      WHERE watcher_id = ${args.watcher_id} AND version = ${args.version}
      LIMIT 1
    `;
  } else {
    rows = await sql`
      SELECT
        v.id, v.version, v.name, v.description, v.prompt,
        v.extraction_schema, v.version_sources, v.json_template,
        v.keying_config, v.classifiers,
        v.condensation_prompt, v.condensation_window_count,
        v.reactions_guidance
      FROM watcher_versions v
      JOIN watchers w ON v.id = w.current_version_id
      WHERE w.id = ${args.watcher_id}
      LIMIT 1
    `;
  }

  if (rows.length === 0) {
    throw new Error(
      `Version ${args.version ?? 'current'} not found for watcher ${args.watcher_id}`
    );
  }

  const v = rows[0] as Record<string, unknown>;

  return {
    action: 'get_version_details',
    watcher_id: args.watcher_id,
    version_id: String(v.id),
    version: Number(v.version),
    name: v.name as string | undefined,
    description: v.description as string | undefined,
    prompt: v.prompt as string,
    extraction_schema: normalizeStoredJsonField(v.extraction_schema, undefined as unknown),
    sources: normalizeStoredJsonField(
      v.version_sources,
      [] as Array<{ name: string; query: string }>
    ),
    json_template: normalizeStoredJsonField(v.json_template, undefined as unknown),
    keying_config: normalizeStoredJsonField(v.keying_config, undefined as unknown),
    classifiers: normalizeStoredJsonField(v.classifiers, undefined as unknown[] | undefined),
    condensation_prompt: v.condensation_prompt as string | undefined,
    condensation_window_count: v.condensation_window_count as number | undefined,
    reactions_guidance: v.reactions_guidance as string | undefined,
  };
}
