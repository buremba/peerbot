/**
 * Version management action handlers for manage_behaviors:
 *   create_version, upgrade, get_versions, get_version_details
 */

import { getDb, parsePgNumberArray } from '../../../db/client';
import { ToolUserError } from '../../../utils/errors';
import { recordToolConfigChange } from '../helpers/config-audit';
import { nextRunAt } from '../../../utils/cron';
import { resolveUsernames } from '../../../utils/resolve-usernames';
import { getNextNumericId } from '../helpers/db-helpers';
import type { ToolContext } from '../../registry';
import type { ManageBehaviorsArgs, ManageBehaviorsResult } from '../manage_behaviors';
import {
  assertKeyingConfigEntityTypeExists,
  assertWatcherVersionConfigValid,
  assertWatcherSourcesResolve,
  assertBehaviorSkillsResolve,
  assertPromptSkillTokensPinned,
  parseJsonInput,
  normalizeStoredJsonField,
  toJsonParam,
} from './shared';
import {
  assertBehaviorInstructions,
  assertBehaviorTriggerConnections,
  behaviorTriggersEqual,
  resolveBehaviorTriggerWrite,
} from '../../../behaviors/triggers';
import { syncBehaviorChannelFeedsBestEffort } from '../../../behaviors/channel-subscriptions';

// ============================================
// handleCreateVersion
// ============================================

export async function handleCreateVersion(
  args: ManageBehaviorsArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<{
  action: 'create_version';
  behavior_id: string;
  version_id: string;
  version: number;
  previous_version: number;
  source_count: number;
  removed_sources?: string[];
}> {
  const sql = getDb();

  if (!args.behavior_id) {
    throw new Error('behavior_id is required for create_version action');
  }

  // Get current watcher + resolve the group root. Versioned config
  // (prompt/schema/template/classifiers) is shared across the entire group
  // and version rows live on the group root, so we read from and write to
  // `watcher_id = watcher_group_id`. The arg's watcher_id is only used to
  // identify the group and to apply the per-assignment writes (sources,
  // schedule, scheduler_client_id) to that specific row.
  const watcherRows = await sql`
    SELECT i.id, i.version, i.current_version_id, i.watcher_group_id, i.sources, i.organization_id,
           i.entity_ids, i.schedule, i.timezone, i.triggers, i.agent_id
    FROM watchers i WHERE i.id = ${args.behavior_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Behavior ${args.behavior_id} not found`);
  }

  const groupId = Number(watcherRows[0].watcher_group_id);
  const previousVersion = Number(watcherRows[0].version);
  const nextVersion = previousVersion + 1;

  // Load current version (from the group root's chain) to inherit fields
  // the caller didn't specify.
  const prevRows = await sql`
    SELECT
      name, description, prompt, version_sources, skills,
      keying_config, classifiers,
      reactions_guidance
    FROM watcher_versions
    WHERE watcher_id = ${groupId}
    ORDER BY version DESC LIMIT 1
  `;
  if (prevRows.length === 0) {
    throw new Error(
      `No previous version found for Behavior group ${groupId}. ` +
        'This group is missing version rows on its root — likely a stale clone from before the version-sharing refactor. Run cleanup or create a fresh Behavior.'
    );
  }
  const prev = prevRows[0] as Record<string, unknown>;

  const promptEdited = args.prompt !== undefined;
  const prompt = args.prompt ?? (prev.prompt as string);
  // Sources on a version bump — full-replacement semantics keyed on INTENT,
  // distinguishing "the caller omitted sources" (inherit) from "the caller
  // explicitly set them" (replace, even to empty). This closes #2048: passing
  // `sources: []` used to be conflated with "omitted" and silently re-inherited
  // the stored sources.
  //
  //   1. `sources` passed → EXPLICIT replacement. The given list is
  //      authoritative even when empty (`[]` clears).
  //   2. `sources` omitted → INHERIT the assignment's stored sources, so a
  //      prompt- or metadata-only bump preserves them.
  //
  // The prompt is not a third input. In particular, chip-shaped prose in an
  // inherited task statement must not add or remove the assignment's sources.
  // Interactive authoring clients send an explicit replacement when their
  // source-chip set changes.
  const storedSources = normalizeStoredJsonField(
    watcherRows[0].sources,
    [] as Array<{ name: string; query: string }>
  );
  const sources = args.sources !== undefined ? args.sources : storedSources;
  // Pinned skills follow the same passed-vs-omitted intent split as sources: an
  // explicit array replaces (`[]` clears), omission inherits the previous
  // version's snapshots so a prompt- or metadata-only bump keeps them. Inherited
  // snapshots are carried VERBATIM and never re-read from the agent's library —
  // a bump that only renames the Behavior must not quietly upgrade its skill
  // text to whatever the library holds today. Taking a newer body is an explicit
  // act: the caller sends the new snapshots.
  const storedSkills = normalizeStoredJsonField(
    prev.skills,
    [] as Array<{ name: string; content: string }>
  );
  const skills = args.skills !== undefined ? args.skills : storedSkills;
  const keyingConfig =
    parseJsonInput<Record<string, unknown>>(args.keying_config, 'keying_config') ??
    normalizeStoredJsonField(prev.keying_config, undefined as Record<string, unknown> | undefined);
  const classifiers =
    parseJsonInput<unknown[]>(args.classifiers, 'classifiers') ??
    normalizeStoredJsonField(prev.classifiers, undefined as unknown[] | undefined);

  // Validate. The output contract is not authored on the watcher: an
  // entity-typed watcher (keying_config.entity_type) derives it from that
  // entity type's metadata_schema at runtime, and an untyped watcher runs
  // the worker's free-form summary fallback.
  assertWatcherVersionConfigValid({ prompt, classifiers, sources });

  // Resolve every source against the org now (broken source → 422, not silent
  // empty context at read_knowledge): @refs are existence-checked, custom SQL is
  // planned (LIMIT 0) for bad columns/syntax. The watcher row carries the org +
  // entity_ids so {{entityId}} validates as it runs.
  const versionOrganizationId = watcherRows[0].organization_id as string | null;
  if (versionOrganizationId) {
    // Only validate a CALLER-SUPPLIED keying_config. An inherited value comes
    // from the stored previous version, and a metadata-only bump (name/schedule)
    // must not start failing because of a type that was already persisted.
    if (args.keying_config !== undefined) {
      await assertKeyingConfigEntityTypeExists(sql, versionOrganizationId, keyingConfig);
    }
    await assertWatcherSourcesResolve(
      sql,
      versionOrganizationId,
      sources,
      parsePgNumberArray(watcherRows[0].entity_ids),
    );
    // Only check a CALLER-SUPPLIED skill set, for the same reason keying_config
    // is gated above: inherited snapshots were already valid when pinned, and a
    // name-only bump must not start failing because a skill was since renamed or
    // disabled in the library. The stored text still runs either way.
    const versionAgentId = watcherRows[0].agent_id as string | null;
    if (args.skills !== undefined && skills.length > 0) {
      if (!versionAgentId) {
        throw new ToolUserError(
          'This Behavior has no owning agent, so pinned skills cannot be resolved.',
          422
        );
      }
      await assertBehaviorSkillsResolve(sql, versionOrganizationId, versionAgentId, skills);
    }
  } else if (args.skills !== undefined && skills.length > 0) {
    throw new ToolUserError(
      'This Behavior has no organization, so pinned skills cannot be resolved.',
      422
    );
  }

  const triggerWrite = resolveBehaviorTriggerWrite({
    triggers: args.triggers,
    currentTriggers: watcherRows[0].triggers ?? [],
  });
  const previousTriggers = watcherRows[0].triggers ?? [];
  const triggersChanged =
    args.triggers !== undefined &&
    !behaviorTriggersEqual(previousTriggers, triggerWrite.triggers);
  if (versionOrganizationId && triggersChanged) {
    await assertBehaviorTriggerConnections(
      sql,
      versionOrganizationId,
      triggerWrite.triggers
    );
  }

  // Final-state instruction rule. The prompt version is group-shared
  // (cascades to every assignment), while triggers are per-assignment — so
  // when set_as_current, validate the new prompt against every sibling's
  // final trigger set (the targeted row uses triggerWrite.triggers).
  const setAsCurrent = args.set_as_current !== false;
  if (setAsCurrent) {
    const siblingRows = await sql`
      SELECT id, triggers FROM watchers WHERE watcher_group_id = ${groupId}
    `;
    for (const sibling of siblingRows) {
      const siblingTriggers =
        Number(sibling.id) === Number(args.behavior_id)
          ? triggerWrite.triggers
          : ((sibling.triggers ?? []) as typeof triggerWrite.triggers);
      assertBehaviorInstructions(siblingTriggers, prompt, skills);
    }
  } else {
    // Draft version only — triggers on the live row do not change.
    assertBehaviorInstructions(previousTriggers, prompt, skills);
  }
  // Both branches above write the SAME resolved prompt+skills pair, so the
  // chip/pin agreement is checked once here rather than inside either arm.
  assertPromptSkillTokensPinned(prompt, skills);

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
        prompt, version_sources, skills,
        keying_config, classifiers,
        reactions_guidance, change_notes, created_by, created_at
      ) VALUES (
        ${versionId}, ${groupId}, ${lockedNextVersion},
        ${args.name ?? (prev.name as string) ?? 'Behavior'},
        ${args.description !== undefined ? (args.description ?? null) : ((prev.description as string) ?? null)},
        ${prompt}, NULL, ${tx.json(skills)},
        ${toJsonParam(tx, keyingConfig)}, ${toJsonParam(tx, classifiers)},
        ${args.reactions_guidance ?? (prev.reactions_guidance as string) ?? null},
        ${args.change_notes ?? null}, ${createdBy}, NOW()
      )
    `;

    // Update watcher to new version if set_as_current (default: true).
    // Group-shared fields (current_version_id, version, name) cascade to
    // every watcher in the group; per-assignment fields (sources,
    // schedule, scheduler_client_id) update only the targeted row.
    if (setAsCurrent) {
      const shouldUpdateTriggers = args.triggers !== undefined;
      const scheduleValue = triggerWrite.schedule;
      const timezoneValue = triggerWrite.timezone;
      // Recompute next_run_at when the cadence OR its zone changes, mixing
      // incoming args with the stored row for whichever side was omitted.
      const touchesCadence = shouldUpdateTriggers;
      const effectiveSchedule = touchesCadence
        ? scheduleValue
        : ((watcherRows[0].schedule as string | null) ?? null);
      const effectiveTimezone = touchesCadence
        ? timezoneValue
        : ((watcherRows[0].timezone as string | null) ?? null);
      const nextRunAtVal =
        touchesCadence && effectiveSchedule
          ? nextRunAt(effectiveSchedule, new Date(), effectiveTimezone)
          : null;

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
          schedule = CASE WHEN ${touchesCadence} THEN ${scheduleValue} ELSE schedule END,
          timezone = CASE WHEN ${touchesCadence} THEN ${timezoneValue} ELSE timezone END,
          triggers = CASE WHEN ${touchesCadence} THEN ${tx.json(triggerWrite.triggers)} ELSE triggers END,
          next_run_at = CASE WHEN ${touchesCadence} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END
        WHERE id = ${args.behavior_id}
      `;
    }
  });

  if (versionOrganizationId && setAsCurrent && triggersChanged) {
    await syncBehaviorChannelFeedsBestEffort({
      organizationId: versionOrganizationId,
      before: previousTriggers,
      after: triggerWrite.triggers,
      sql,
    });
  }

  if (versionOrganizationId) {
    recordToolConfigChange(ctx, {
      organizationId: versionOrganizationId,
      resourceKind: 'behavior',
      resourceId: args.behavior_id,
      op: 'updated',
      summary: `Behavior '${args.name ?? (prev.name as string) ?? args.behavior_id}' version ${lockedNextVersion} created`,
      // Composed from the values just written (watcher row not refetched);
      // carries the new version-bound fields.
      state: {
        id: args.behavior_id,
        name: args.name ?? (prev.name as string) ?? 'Behavior',
        version: lockedNextVersion,
        current_version_id: setAsCurrent ? versionId : undefined,
        prompt,
        sources,
        keying_config: keyingConfig ?? null,
        classifiers: classifiers ?? null,
        reactions_guidance: args.reactions_guidance ?? (prev.reactions_guidance as string) ?? null,
        change_notes: args.change_notes ?? null,
        ...(args.triggers !== undefined ? { schedule: triggerWrite.schedule } : {}),
        ...(args.triggers !== undefined ? { timezone: triggerWrite.timezone } : {}),
        ...(args.triggers !== undefined ? { triggers: triggerWrite.triggers } : {}),
      },
      changedFields: [
        'version',
        ...(promptEdited ? ['prompt'] : []),
        ...(args.name !== undefined ? ['name'] : []),
        ...(args.sources !== undefined ? ['sources'] : []),
        ...(args.keying_config !== undefined ? ['keying_config'] : []),
        ...(args.classifiers !== undefined ? ['classifiers'] : []),
        ...(args.reactions_guidance !== undefined ? ['reactions_guidance'] : []),
        ...(args.triggers !== undefined ? ['schedule', 'timezone'] : []),
        ...(args.triggers !== undefined ? ['triggers'] : []),
      ],
    });
  }

  // Report the resulting source set + what a full-replacement dropped, so a
  // caller can SEE that publishing this version removed sources (rather than
  // discovering it at the next run). `removed_sources` = names present on the
  // prior assignment but absent from the new version (#2048).
  const newSourceNames = new Set(sources.map((s) => s.name));
  const removedSources = storedSources
    .map((s) => s.name)
    .filter((name) => !newSourceNames.has(name));

  return {
    action: 'create_version',
    behavior_id: args.behavior_id,
    version_id: String(versionId),
    version: lockedNextVersion,
    previous_version: previousVersion,
    source_count: sources.length,
    ...(removedSources.length > 0 ? { removed_sources: removedSources } : {}),
  };
}

// ============================================
// handleGetVersions
// ============================================

export async function handleGetVersions(args: ManageBehaviorsArgs): Promise<{
  action: 'get_versions';
  behavior_id: string;
  versions: any[];
}> {
  const sql = getDb();

  if (!args.behavior_id) {
    throw new Error('behavior_id is required for get_versions action');
  }

  const watcherRows = await sql`
    SELECT id, name, slug, current_version_id, watcher_group_id FROM watchers WHERE id = ${args.behavior_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Behavior ${args.behavior_id} not found`);
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
    behavior_id: args.behavior_id,
    versions,
  };
}

// ============================================
// handleGetVersionDetails
// ============================================

export async function handleGetVersionDetails(
  args: ManageBehaviorsArgs
): Promise<ManageBehaviorsResult> {
  const sql = getDb();

  if (!args.behavior_id) {
    throw new Error('behavior_id is required for get_version_details action');
  }

  // Version rows live on the group root while sources live on the assignment.
  // Resolve both so assignment ids behave consistently with get_versions.
  const watcherRows = await sql`
    SELECT id, watcher_group_id, sources
    FROM watchers WHERE id = ${args.behavior_id}
  `;
  if (watcherRows.length === 0) {
    throw new Error(`Behavior ${args.behavior_id} not found`);
  }
  const groupId = Number(watcherRows[0].watcher_group_id ?? watcherRows[0].id);

  let rows;
  if (args.version !== undefined) {
    rows = await sql`
      SELECT
        id, version, name, description, prompt,
        version_sources, skills,
        keying_config, classifiers,
        reactions_guidance
      FROM watcher_versions
      WHERE watcher_id = ${groupId} AND version = ${args.version}
      LIMIT 1
    `;
  } else {
    rows = await sql`
      SELECT
        v.id, v.version, v.name, v.description, v.prompt,
        v.version_sources, v.skills,
        v.keying_config, v.classifiers,
        v.reactions_guidance
      FROM watcher_versions v
      JOIN watchers w ON v.id = w.current_version_id
      WHERE w.id = ${args.behavior_id}
      LIMIT 1
    `;
  }

  if (rows.length === 0) {
    throw new Error(
      `Version ${args.version ?? 'current'} not found for Behavior ${args.behavior_id}`
    );
  }

  const v = rows[0] as Record<string, unknown>;

  // create_version leaves version_sources NULL because sources are
  // per-assignment. Fall through to the assignment's live list, matching
  // get_content while retaining sources stored on older version rows.
  const versionSources = normalizeStoredJsonField(
    v.version_sources,
    [] as Array<{ name: string; query: string }>
  );

  return {
    action: 'get_version_details',
    behavior_id: args.behavior_id,
    version_id: String(v.id),
    version: Number(v.version),
    name: v.name as string | undefined,
    description: v.description as string | undefined,
    prompt: v.prompt as string,
    skills: normalizeStoredJsonField(
      v.skills,
      [] as Array<{ name: string; content: string }>
    ),
    sources:
      versionSources.length > 0
        ? versionSources
        : normalizeStoredJsonField(
            watcherRows[0].sources,
            [] as Array<{ name: string; query: string }>
          ),
    keying_config: normalizeStoredJsonField(v.keying_config, undefined as unknown),
    classifiers: normalizeStoredJsonField(v.classifiers, undefined as unknown[] | undefined),
    reactions_guidance: v.reactions_guidance as string | undefined,
  };
}
