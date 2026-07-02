/**
 * Canvas-on-events Phase 3a migration contract.
 *
 * Locks the inline, set-based backfill + re-key the retirement migration
 * (db/migrations/20260703000000_canvas_windows_inline_backfill_and_rekey.sql)
 * performs. Migrations auto-apply BEFORE any test row exists, so this test seeds
 * legacy watcher_windows rows + dependent link/reaction/run/correction rows
 * pre-migration-style (window_id pointing at the legacy watcher_windows.id) and
 * then runs the migration's core SQL blocks directly, asserting:
 *   (1) a canvas_state ROOT is created per legacy window (created_at preserved,
 *       canonical UTC ISO metadata), replays are no-ops;
 *   (2) watcher_reactions / runs / watcher_window_events / event_classifications
 *       window_id columns are re-keyed to the canvas root event id;
 *   (3) correction events' metadata.window_id is re-keyed;
 *   (4) runs provenance (model_used / run_metadata) is backfilled.
 *
 * The re-key SQL is exercised directly (not via a fresh migration run) because
 * the migration already applied at DB setup against an empty watcher_windows.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const DAY_MS = 24 * 60 * 60 * 1000;

// Canonical UTC ISO text used by both the write path (Date.toISOString()) and
// the migration's to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"').
function utcIso(d: Date): string {
  return d.toISOString();
}

/** The migration's inline canvas-root backfill (entity + identity + root event). */
async function runInlineBackfill(): Promise<void> {
  const sql = getTestDb();
  await sql.unsafe(`
    WITH watchers_needing_canvas AS (
      SELECT DISTINCT w.id AS watcher_id, w.organization_id, w.entity_ids,
        COALESCE(w.created_by, (
          SELECT m."userId" FROM public.member m
          WHERE m."organizationId" = w.organization_id
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m."createdAt" ASC
          LIMIT 1)) AS created_by
      FROM public.watchers w
      WHERE EXISTS (SELECT 1 FROM public.watcher_windows ww WHERE ww.watcher_id = w.id)
        AND NOT EXISTS (
          SELECT 1 FROM public.entity_identities ei JOIN public.entities e ON e.id = ei.entity_id
          WHERE ei.organization_id = w.organization_id AND ei.namespace = 'watcher_canvas'
            AND ei.identifier = w.id::text AND ei.deleted_at IS NULL AND e.deleted_at IS NULL)
    ),
    resolved AS (
      SELECT wnc.watcher_id, wnc.organization_id, wnc.created_by,
        (SELECT (regexp_split_to_array(trim(both '{}' FROM wnc.entity_ids::text), ','))[1]::bigint
         WHERE wnc.entity_ids IS NOT NULL AND trim(both '{}' FROM wnc.entity_ids::text) <> '') AS parent_entity_id,
        COALESCE(
          (SELECT et.id FROM public.entity_types et LEFT JOIN public.organization o ON o.id = et.organization_id
           WHERE et.slug = 'canvas' AND et.deleted_at IS NULL AND et.backing_sql IS NULL
             AND (et.organization_id = wnc.organization_id OR o.visibility = 'public')
           ORDER BY (et.organization_id = wnc.organization_id) DESC, et.id ASC LIMIT 1),
          (SELECT et.id FROM public.entity_types et WHERE et.organization_id = wnc.organization_id
             AND et.deleted_at IS NULL AND et.backing_sql IS NULL ORDER BY et.id ASC LIMIT 1)
        ) AS entity_type_id
      FROM watchers_needing_canvas wnc WHERE wnc.created_by IS NOT NULL
    ),
    inserted_entities AS (
      INSERT INTO public.entities (organization_id, entity_type_id, name, slug, parent_id, metadata, created_by, created_at, updated_at)
      SELECT r.organization_id, r.entity_type_id, 'Canvas · watcher ' || r.watcher_id,
        'watcher-canvas-' || r.watcher_id, r.parent_entity_id,
        jsonb_build_object('watcher_id', r.watcher_id, 'source', 'watcher_canvas'),
        r.created_by, current_timestamp, current_timestamp
      FROM resolved r WHERE r.entity_type_id IS NOT NULL
      ON CONFLICT DO NOTHING
      RETURNING id, (metadata->>'watcher_id')::bigint AS watcher_id, organization_id
    )
    INSERT INTO public.entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
    SELECT ie.organization_id, ie.id, 'watcher_canvas', ie.watcher_id::text, 'watcher'
    FROM inserted_entities ie
    ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL DO NOTHING;
  `);

  await sql.unsafe(`
    INSERT INTO public.events (entity_ids, organization_id, origin_id, payload_type, payload_data, semantic_type, metadata, occurred_at, created_by, created_at)
    SELECT
      CASE WHEN ci.entity_id IS NOT NULL THEN ('{' || ci.entity_id || '}')::bigint[] ELSE '{}'::bigint[] END,
      w.organization_id, 'canvas_backfill_' || ww.id, 'json_template', ww.extracted_data, 'canvas_state',
      jsonb_build_object(
        'watcher_id', ww.watcher_id, 'granularity', ww.granularity,
        'window_start', to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'window_end', to_char(ww.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'content_analyzed', COALESCE(ww.content_analyzed, 0), 'version_id', ww.version_id),
      ww.window_end,
      COALESCE(w.created_by, (SELECT m."userId" FROM public.member m WHERE m."organizationId" = w.organization_id
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m."createdAt" ASC LIMIT 1)),
      COALESCE(ww.created_at, ww.window_end)
    FROM public.watcher_windows ww
    JOIN public.watchers w ON w.id = ww.watcher_id
    LEFT JOIN LATERAL (
      SELECT ei.entity_id FROM public.entity_identities ei JOIN public.entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = w.organization_id AND ei.namespace = 'watcher_canvas'
        AND ei.identifier = w.id::text AND ei.deleted_at IS NULL AND e.deleted_at IS NULL LIMIT 1) ci ON TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM public.events ev WHERE ev.semantic_type = 'canvas_state' AND ev.supersedes_event_id IS NULL
        AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
        AND (ev.metadata->>'granularity') = ww.granularity
        AND (ev.metadata->>'window_start') = to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ON CONFLICT (((metadata->>'watcher_id')::bigint), (metadata->>'granularity'), (metadata->>'window_start'))
      WHERE (semantic_type = 'canvas_state' AND supersedes_event_id IS NULL) DO NOTHING;
  `);
}

/** The migration's re-key of one window_id column onto the canvas root event id. */
async function rekeyColumn(table: string): Promise<void> {
  await getTestDb().unsafe(`
    WITH root AS (
      SELECT ww.id AS old_id, ev.id AS root_id
      FROM public.watcher_windows ww
      JOIN public.events ev ON ev.semantic_type = 'canvas_state' AND ev.supersedes_event_id IS NULL
        AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
        AND (ev.metadata->>'granularity') = ww.granularity
        AND (ev.metadata->>'window_start') = to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    UPDATE public.${table} t SET window_id = r.root_id FROM root r WHERE t.window_id = r.old_id;
  `);
}

describe('canvas-on-events Phase 3a migration', () => {
  let workspace: TestWorkspace;
  let watcherId: number;
  let legacyWindowId: number;
  let runId: number;
  let linkEventId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Canvas Migration Org' });
    const entity = await createTestEntity({
      name: 'Migration Entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId: workspace.users.owner.id,
    });
    const watcher = (await workspace.owner.watchers.create({
      entity_id: entity.id,
      slug: 'canvas-migration-watcher',
      name: 'Canvas Migration Watcher',
      prompt: 'Analyze inputs.',
      agent_id: agent.agentId,
    })) as { watcher_id: string };
    watcherId = Number(watcher.watcher_id);

    const sql = getTestDb();
    // A legacy pre-canvas window created ~3 days ago (created_at must survive).
    const [win] = await sql`
      INSERT INTO watcher_windows (
        watcher_id, granularity, window_start, window_end,
        extracted_data, content_analyzed, model_used, run_metadata, created_at
      ) VALUES (
        ${watcherId}, 'weekly',
        ${new Date(Date.now() - 7 * DAY_MS)}, ${new Date()},
        ${sql.json({ summary: 'legacy window payload' })}, 3, 'legacy-model',
        ${sql.json({ legacy: true })}, ${new Date(Date.now() - 3 * DAY_MS)}
      )
      RETURNING id
    `;
    legacyWindowId = Number((win as { id: unknown }).id);

    // A run whose window_id references the legacy window (pre-re-key).
    const [run] = await sql`
      INSERT INTO runs (organization_id, run_type, status, watcher_id, window_id, created_at)
      VALUES (${workspace.org.id}, 'watcher', 'completed', ${watcherId}, ${legacyWindowId}, NOW())
      RETURNING id
    `;
    runId = Number((run as { id: unknown }).id);

    // A link row (window_id → legacy id) + a reaction (window_id → legacy id).
    const linkEvent = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      content: 'linked content',
      occurred_at: new Date(),
    });
    linkEventId = linkEvent.id;
    await sql`
      INSERT INTO watcher_window_events (window_id, event_id, watcher_id)
      VALUES (${legacyWindowId}, ${linkEventId}, ${watcherId})
    `;
    await sql`
      INSERT INTO watcher_reactions (organization_id, watcher_id, window_id, reaction_type, tool_name)
      VALUES (${workspace.org.id}, ${watcherId}, ${legacyWindowId}, 'script_execution', 'reaction_executor')
    `;
    // A correction event whose metadata.window_id references the legacy id.
    await sql`
      INSERT INTO events (organization_id, semantic_type, entity_ids, origin_id, metadata, occurred_at, created_at)
      VALUES (${workspace.org.id}, 'correction', '{}'::bigint[], 'wwff_999999',
        ${sql.json({ window_id: legacyWindowId, watcher_id: watcherId, field_path: 'x', mutation: 'set' })},
        NOW(), NOW())
    `;
  });

  it('backfills a canvas root (created_at preserved, canonical ISO metadata) and re-keys all window_id columns', async () => {
    const sql = getTestDb();

    await runInlineBackfill();

    // (1) One root, created_at preserved (~3 days ago, not NOW()).
    const roots = await sql`
      SELECT id, created_at, payload_data, metadata
      FROM events
      WHERE semantic_type = 'canvas_state' AND supersedes_event_id IS NULL
        AND (metadata->>'watcher_id')::bigint = ${watcherId}
    `;
    expect(roots).toHaveLength(1);
    const rootId = Number(roots[0].id);
    expect(Date.now() - new Date(roots[0].created_at as string).getTime()).toBeGreaterThan(2 * DAY_MS);
    expect((roots[0].payload_data as Record<string, unknown>).summary).toBe('legacy window payload');
    // window_start metadata is canonical UTC ISO — matches Date.toISOString().
    const [legacy] = await sql`SELECT window_start FROM watcher_windows WHERE id = ${legacyWindowId}`;
    const md = roots[0].metadata as Record<string, unknown>;
    expect(md.window_start).toBe(utcIso(new Date(legacy.window_start as string)));

    // Replay is a no-op (idempotent on idx_canvas_chain_root).
    await runInlineBackfill();
    const rootsAfter = await sql`
      SELECT id FROM events WHERE semantic_type = 'canvas_state' AND supersedes_event_id IS NULL
        AND (metadata->>'watcher_id')::bigint = ${watcherId}
    `;
    expect(rootsAfter).toHaveLength(1);
    expect(Number(rootsAfter[0].id)).toBe(rootId);

    // (2) Re-key the four window_id columns.
    for (const table of ['watcher_reactions', 'runs', 'watcher_window_events', 'event_classifications']) {
      await rekeyColumn(table);
    }
    const [reaction] = await sql`SELECT window_id FROM watcher_reactions WHERE watcher_id = ${watcherId}`;
    expect(Number(reaction.window_id)).toBe(rootId);
    const [run] = await sql`SELECT window_id, model_used, run_metadata FROM runs WHERE id = ${runId}`;
    expect(Number(run.window_id)).toBe(rootId);
    const [wwe] = await sql`SELECT window_id FROM watcher_window_events WHERE event_id = ${linkEventId}`;
    expect(Number(wwe.window_id)).toBe(rootId);

    // (3) Re-key correction metadata.window_id.
    await sql.unsafe(`
      WITH root AS (
        SELECT ww.id AS old_id, ev.id AS root_id
        FROM public.watcher_windows ww
        JOIN public.events ev ON ev.semantic_type = 'canvas_state' AND ev.supersedes_event_id IS NULL
          AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
          AND (ev.metadata->>'granularity') = ww.granularity
          AND (ev.metadata->>'window_start') = to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      UPDATE public.events e SET metadata = jsonb_set(e.metadata, '{window_id}', to_jsonb(r.root_id))
      FROM root r WHERE e.semantic_type = 'correction' AND (e.metadata->>'window_id')::bigint = r.old_id;
    `);
    const [correction] = await sql`
      SELECT (metadata->>'window_id')::bigint AS window_id FROM events
      WHERE semantic_type = 'correction' AND origin_id = 'wwff_999999'
    `;
    expect(Number(correction.window_id)).toBe(rootId);

    // (4) runs provenance backfill from the legacy window's run linkage.
    await sql.unsafe(`
      UPDATE public.runs r
      SET model_used = COALESCE(r.model_used, ww.model_used),
          run_metadata = COALESCE(r.run_metadata, ww.run_metadata)
      FROM public.watcher_windows ww
      WHERE ww.run_id = r.id AND (r.model_used IS NULL OR r.run_metadata IS NULL);
    `);
    // The seeded run had no run_id linkage on the window; provenance backfills
    // via the re-keyed window_id → root → window join instead.
    await sql.unsafe(`
      WITH win AS (
        SELECT ev.id AS root_id, ww.model_used, ww.run_metadata
        FROM public.watcher_windows ww
        JOIN public.events ev ON ev.semantic_type = 'canvas_state' AND ev.supersedes_event_id IS NULL
          AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
          AND (ev.metadata->>'granularity') = ww.granularity
          AND (ev.metadata->>'window_start') = to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      UPDATE public.runs r
      SET model_used = COALESCE(r.model_used, win.model_used),
          run_metadata = COALESCE(r.run_metadata, win.run_metadata)
      FROM win WHERE r.window_id = win.root_id AND (r.model_used IS NULL OR r.run_metadata IS NULL);
    `);
    const [runAfter] = await sql`SELECT model_used, run_metadata FROM runs WHERE id = ${runId}`;
    expect(runAfter.model_used).toBe('legacy-model');
    expect((runAfter.run_metadata as Record<string, unknown>).legacy).toBe(true);
  });
});
