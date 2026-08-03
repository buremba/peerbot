/**
 * Migration 20260728100010 rewrites the persisted Behavior DEFAULT source
 * (the legacy `SELECT * FROM events ORDER BY occurred_at DESC` literal) to the
 * bookkeeping-excluding DEFAULT_BEHAVIOR_SOURCE_QUERY. It matches by exact
 * query text — the schema stores no generated-vs-authored provenance — so this
 * replay proves both directions of the contract:
 *   - a source carrying the exact legacy literal IS rewritten (and any source
 *   with that text had identical pre-change window behavior, since
 *   bookkeeping rows were invisible via occurred_at NULL);
 *   - any other authored source, however similar, is left byte-identical.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { getDb } from '../../../db/client';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { adaptImmutableMigrationToBehaviorSchema } from '../../setup/immutable-migration';
import { manageBehaviors } from '../../../tools/admin/manage_behaviors';
import { DEFAULT_BEHAVIOR_SOURCE_QUERY } from '../../../behaviors/source-refs';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, seedOwnerContext } from '../../setup/test-fixtures';

const MIGRATION = '20260728100010_behavior_default_source_excludes_bookkeeping.sql';
const LEGACY_DEFAULT = 'SELECT * FROM events ORDER BY occurred_at DESC';
const AUTHORED_CUSTOM =
  "SELECT id, payload_text FROM events WHERE connector_key = 'github' ORDER BY occurred_at DESC";

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

async function executeSection(section: string): Promise<void> {
  const sql = getDb();
  for (const statement of section.split(/;\s*(?:\n|$)/).map((part) => part.trim())) {
    if (statement) await sql.unsafe(statement);
  }
}

describe('behavior default-source migration replay', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
  });

  it('rewrites only the exact legacy default literal, leaving authored sources byte-identical', async () => {
    const { org, user, ctx } = await seedOwnerContext();
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
    });
    const created = await manageBehaviors(
      {
        action: 'create',
        slug: 'default-source-migration-probe',
        name: 'Default source migration probe',
        prompt: 'Summarize new workspace content.',
        agent_id: agent.agentId,
        triggers: [{ kind: 'schedule', cron: '* * * * *' }],
      },
      {} as Env,
      ctx
    );
    if (created.action !== 'create' || !('behavior_id' in created)) {
      throw new Error('Behavior creation did not complete');
    }
    const behaviorId = Number(created.behavior_id);
    const sql = getTestDb();

    // Recreate the pre-deploy state: one legacy default source and one
    // authored custom source, on both the behavior row and its version row.
    // sql.json, not a ::jsonb-cast string — the prod value options serialize a
    // plain string param into a double-encoded JSON string.
    const preDeploySources = [
      { name: 'content', query: LEGACY_DEFAULT },
      { name: 'github', query: AUTHORED_CUSTOM },
    ];
    await sql`
      UPDATE behaviors SET sources = ${sql.json(preDeploySources)} WHERE id = ${behaviorId}
    `;
    await sql`
      UPDATE behavior_versions SET version_sources = ${sql.json(preDeploySources)}
      WHERE id = (SELECT current_version_id FROM behaviors WHERE id = ${behaviorId})
    `;

    await executeSection(
      adaptImmutableMigrationToBehaviorSchema(
        loadMigrationUpSection(resolveMigrationsDir(), MIGRATION),
      ),
    );

    const [behavior] = await sql`SELECT sources FROM behaviors WHERE id = ${behaviorId}`;
    const [version] = await sql`
      SELECT version_sources FROM behavior_versions
      WHERE id = (SELECT current_version_id FROM behaviors WHERE id = ${behaviorId})
    `;
    for (const sources of [behavior.sources, version.version_sources]) {
      const byName = Object.fromEntries(
        (sources as Array<{ name: string; query: string }>).map((s) => [s.name, s.query])
      );
      expect(byName.content).toBe(DEFAULT_BEHAVIOR_SOURCE_QUERY);
      expect(byName.github).toBe(AUTHORED_CUSTOM);
    }
  });
});
