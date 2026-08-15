import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { findCanvasHead } from '../../../utils/canvas-events';
import { persistAutomationEventOutput } from '../../../utils/persist-automation-event-output';
import {
  AUTOMATION_EVENT_IDENTITY_NS,
  computeStableKey,
  formatAutomationEventIdentity,
} from '../../../utils/stable-keys';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestOrganization, createTestUser } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const CUTOVER_MIGRATION = '20260816000010_automation_vocabulary.sql';
const TRAIT_REWRITE_START = '-- connector-trait-merge-strategy:start';
const TRAIT_REWRITE_END = '-- connector-trait-merge-strategy:end';
const ENTITY_REWRITE_START = '-- entity-metadata-cutover:start';
const ENTITY_REWRITE_END = '-- entity-metadata-cutover:end';
const IDENTITY_BRIDGE_START = '-- automation-event-identity-bridge:start';
const IDENTITY_BRIDGE_END = '-- automation-event-identity-bridge:end';

class Rollback extends Error {}

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

function loadMarkedSection(startMarker: string, endMarker: string, label: string): string {
  const up = loadMigrationUpSection(resolveMigrationsDir(), CUTOVER_MIGRATION);
  const start = up.indexOf(startMarker);
  const end = up.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error(`Could not locate ${label}`);
  return up.slice(start + startMarker.length, end);
}

function loadTraitRewrite(): string {
  return loadMarkedSection(TRAIT_REWRITE_START, TRAIT_REWRITE_END, 'connector trait rewrite');
}

describe('Automation schema vocabulary', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('bridges keyed event identity without rewriting or deleting authored event history', () => {
    const up = loadMigrationUpSection(resolveMigrationsDir(), CUTOVER_MIGRATION);
    expect(up).not.toMatch(/\bDELETE\s+FROM\s+(?:public\.)?events\b/i);
    expect(up).not.toMatch(/UPDATE\s+(?:public\.)?events[^;]*SET\s+(?:payload_|metadata|attachments|identity_)/i);
    expect(up).toMatch(/SET\s+superseded_by\s*=\s*canonical\.id/i);
    expect(up).toMatch(/legacy\.id,\s*'automation_event',\s*legacy\.identity_key/i);
  });

  it('does not globally rewrite user-authored SQL, templates, or opaque run JSON', () => {
    const up = loadMigrationUpSection(resolveMigrationsDir(), CUTOVER_MIGRATION);
    expect(up).not.toMatch(/UPDATE\s+public\.(?:watchers|watcher_versions|view_template_versions)\b/i);
    expect(up).not.toMatch(/SET\s+\w+\s*=\s*replace\s*\(\s*replace\s*\([^;]*::text/is);
  });

  it('hard-renames persisted connector trait merge policies in definitions and device manifests', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const user = await createTestUser();
    const legacyTrait = {
      eventPath: 'metadata.display_name',
      behavior: 'prefer_non_empty',
    };
    const feedsSchema = {
      messages: {
        eventKinds: {
          message: {
            attributions: [{ role: 'authored_by', traits: { display_name: legacyTrait } }],
          },
        },
      },
    };

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx`
          INSERT INTO connector_definitions
            (organization_id, key, name, version, auth_schema, feeds_schema, status)
          VALUES (
            ${org.id}, 'merge-strategy-cutover', 'Merge strategy cutover', '1.0.0',
            ${tx.json({ methods: [{ type: 'none' }] })}, ${tx.json(feedsSchema)}, 'active'
          )
        `;
        await tx`
          INSERT INTO device_workers
            (user_id, worker_id, platform, app_version, capabilities, label,
             organization_id, connector_manifests)
          VALUES (
            ${user.id}, 'merge-strategy-cutover', 'macos', '1.0.0',
            ${tx.json(['test'])}, 'Merge strategy cutover', ${org.id},
            ${tx.json({
              test: {
                manifest_hash: 'legacy',
                received_at: '2026-08-15T00:00:00.000Z',
                manifest: { key: 'test', feeds_schema: feedsSchema },
              },
            })}
          )
        `;

        const rewrite = loadTraitRewrite();
        await tx.unsafe(rewrite);
        await tx.unsafe(rewrite);

        const [definition] = await tx<{ feeds_schema: Record<string, unknown> }[]>`
          SELECT feeds_schema
          FROM connector_definitions
          WHERE organization_id = ${org.id} AND key = 'merge-strategy-cutover'
        `;
        const [device] = await tx<{ connector_manifests: Record<string, unknown> }[]>`
          SELECT connector_manifests
          FROM device_workers
          WHERE user_id = ${user.id} AND worker_id = 'merge-strategy-cutover'
        `;

        const definitionText = JSON.stringify(definition.feeds_schema);
        const manifestText = JSON.stringify(device.connector_manifests);
        expect(definitionText).toContain('"mergeStrategy":"prefer_non_empty"');
        expect(manifestText).toContain('"mergeStrategy":"prefer_non_empty"');
        expect(definitionText).not.toContain('"behavior"');
        expect(manifestText).not.toContain('"behavior"');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('rewrites only entity metadata claimed by Automation identities', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const user = await createTestUser();
    const owned = await createTestEntity({
      name: 'Owned Automation entity',
      organization_id: org.id,
      created_by: user.id,
    });
    const authored = await createTestEntity({
      name: 'Customer-authored entity',
      organization_id: org.id,
      created_by: user.id,
    });
    const legacyMetadata = {
      watcher_id: 42,
      source: 'watcher_promotion',
      resourceKind: 'behavior',
      resource_kind: 'watcher',
      note: 'customer text remains byte-for-byte',
    };

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx`
          UPDATE entities
          SET metadata = ${tx.json(legacyMetadata)}
          WHERE id IN (${owned.id}, ${authored.id})
        `;
        await tx`
          INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
          VALUES (${org.id}, ${owned.id}, 'automation_key', 'owned-automation-key')
        `;

        const rewrite = loadMarkedSection(ENTITY_REWRITE_START, ENTITY_REWRITE_END, 'entity metadata cutover');
        await tx.unsafe(rewrite);
        await tx.unsafe(rewrite);

        const rows = await tx<{ id: number; metadata: Record<string, unknown> }[]>`
          SELECT id, metadata
          FROM entities
          WHERE id IN (${owned.id}, ${authored.id})
          ORDER BY id
        `;
        const ownedRow = rows.find((row) => Number(row.id) === owned.id);
        const authoredRow = rows.find((row) => Number(row.id) === authored.id);
        expect(ownedRow?.metadata).toEqual({
          automation_id: 42,
          source: 'automation_promotion',
          resourceKind: 'automation',
          resource_kind: 'automation',
          note: 'customer text remains byte-for-byte',
        });
        expect(authoredRow?.metadata).toEqual(legacyMetadata);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('keeps pre-cutover keyed output heads in the post-cutover supersede chain', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({
      name: 'Identity bridge upgrade org',
    });
    const ownerUserId = workspace.users.owner.id;
    const parent = await createTestEntity({
      name: 'Identity bridge subject',
      organization_id: workspace.org.id,
      created_by: ownerUserId,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'identity-bridge-agent',
    });
    const [created] = await sql<{ id: number }[]>`
      WITH next_id AS (
        SELECT nextval('automations_id_seq')::int AS id
      )
      INSERT INTO automations (
        id, organization_id, created_by, agent_id, automation_group_id,
        name, slug, entity_ids
      )
      SELECT
        id, ${workspace.org.id}, ${ownerUserId}, ${agent.agentId}, id,
        'Identity bridge Automation', 'identity-bridge-automation', ARRAY[${parent.id}]::bigint[]
      FROM next_id
      RETURNING id
    `;
    const automationId = Number(created.id);
    const identityKey = formatAutomationEventIdentity(
      'observation',
      computeStableKey({ channel: 'z', mode: 'voice' }, ['channel', 'mode'])
    );
    const [legacy] = await sql<{ id: number }[]>`
      INSERT INTO events (
        organization_id, origin_id, title, payload_text, semantic_type, client_id,
        metadata, identity_ns, identity_key, automation_id
      ) VALUES (
        ${workspace.org.id}, 'pre-cutover-keyed-head', 'Pre-cutover profile',
        'Z voice legacy', 'observation', NULL,
        ${sql.json({
          channel: 'z',
          mode: 'voice',
          automation_output: 'profiles',
          _lobu_idempotency_key: 'pre-cutover-keyed-head',
        })},
        'behavior_event', ${identityKey}, ${automationId}
      )
      RETURNING id
    `;

    const bridge = loadMarkedSection(IDENTITY_BRIDGE_START, IDENTITY_BRIDGE_END, 'Automation event identity bridge');
    await sql.unsafe(bridge);
    await sql.unsafe(bridge);

    const [canonical] = await sql<
      {
        id: number;
        supersedes_event_id: number;
        identity_ns: string;
        payload_text: string;
        metadata: Record<string, unknown>;
      }[]
    >`
      SELECT id, supersedes_event_id, identity_ns, payload_text, metadata
      FROM events
      WHERE supersedes_event_id = ${legacy.id}
    `;
    expect(canonical).toMatchObject({
      supersedes_event_id: legacy.id,
      identity_ns: AUTOMATION_EVENT_IDENTITY_NS,
      payload_text: 'Z voice legacy',
    });
    expect(canonical.metadata).not.toHaveProperty('_lobu_idempotency_key');
    const [legacyAfterBridge] = await sql<{ superseded_by: number | null }[]>`
      SELECT superseded_by FROM events WHERE id = ${legacy.id}
    `;
    expect(legacyAfterBridge.superseded_by).toBe(canonical.id);

    await sql.begin((tx) =>
      persistAutomationEventOutput({
        tx: tx as unknown as DbClient,
        rows: [{ content: 'Z voice v1', metadata: { channel: 'z', mode: 'voice' } }],
        outputName: 'profiles',
        output: { event: 'observation', key: ['channel', 'mode'] },
        automationId,
        versionId: null,
        organizationId: workspace.org.id,
        windowId: 9007,
        canvasRevisionId: 9007,
        runId: null,
        boundEntityIds: [parent.id],
        validContentIds: new Set<number>(),
        occurredAt: new Date().toISOString(),
        createdBy: ownerUserId,
      })
    );
    const [postCutover] = await sql<{ supersedes_event_id: number | null }[]>`
      SELECT supersedes_event_id
      FROM events
      WHERE organization_id = ${workspace.org.id} AND payload_text = 'Z voice v1'
    `;
    expect(postCutover.supersedes_event_id).toBe(canonical.id);
  });

  it('finds pre-cutover canvas rows through preserved physical attribution', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({
      name: 'Canvas attribution upgrade org',
    });
    const ownerUserId = workspace.users.owner.id;
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'canvas-attribution-agent',
    });
    const [created] = await sql<{ id: number }[]>`
      WITH next_id AS (
        SELECT nextval('automations_id_seq')::int AS id
      )
      INSERT INTO automations (
        id, organization_id, created_by, agent_id, automation_group_id,
        name, slug, entity_ids
      )
      SELECT
        id, ${workspace.org.id}, ${ownerUserId}, ${agent.agentId}, id,
        'Canvas attribution Automation', 'canvas-attribution-automation', '{}'::bigint[]
      FROM next_id
      RETURNING id
    `;
    const automationId = Number(created.id);
    const period = {
      automationId,
      granularity: 'daily',
      windowStart: '2026-08-14T00:00:00.000Z',
    };
    const [legacyCanvas] = await sql<{ id: number }[]>`
      INSERT INTO events (
        organization_id, automation_id, semantic_type, payload_data, metadata
      ) VALUES (
        ${workspace.org.id}, ${automationId}, 'canvas_state',
        ${sql.json({ summary: 'historical canvas remains visible' })},
        ${sql.json({
          watcher_id: automationId,
          granularity: period.granularity,
          window_start: period.windowStart,
          window_end: '2026-08-15T00:00:00.000Z',
        })}
      )
      RETURNING id
    `;

    const head = await findCanvasHead(sql as unknown as DbClient, period);
    expect(head).toMatchObject({
      id: legacyCanvas.id,
      rootEventId: legacyCanvas.id,
      payloadData: { summary: 'historical canvas remains visible' },
    });
  });

  it('contains no live schema identifiers or definitions using retired product names', async () => {
    const sql = getTestDb();
    const rows = await sql<{ kind: string; name: string }[]>`
      SELECT 'relation' AS kind, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'column', table_name || '.' || column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'constraint', con.conname
      FROM pg_constraint con
      JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'public'
        AND (
          con.conname ~* '(watcher|behavior)'
          OR pg_get_constraintdef(con.oid) ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'trigger', trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND (
          trigger_name ~* '(watcher|behavior)'
          OR action_statement ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'function', p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (
          p.proname ~* '(watcher|behavior)'
          OR CASE
            WHEN p.prokind IN ('f', 'p')
              THEN pg_get_functiondef(p.oid) ~* '(watcher|behavior)'
            ELSE false
          END
        )
      UNION ALL
      SELECT 'view', viewname
      FROM pg_views
      WHERE schemaname = 'public' AND definition ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'default', table_name || '.' || column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'index', indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'policy', policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND (
          qual ~* '(watcher|behavior)'
          OR with_check ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'comment', COALESCE(c.relname || '.' || a.attname, c.relname, p.proname)
      FROM pg_description d
      LEFT JOIN pg_class c ON c.oid = d.objoid
      LEFT JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
      LEFT JOIN pg_proc p ON p.oid = d.objoid
      LEFT JOIN pg_namespace n ON n.oid = COALESCE(c.relnamespace, p.pronamespace)
      WHERE n.nspname = 'public' AND d.description ~* '(watcher|behavior)'
      ORDER BY kind, name
    `;

    expect(rows).toEqual([]);
  });
});
