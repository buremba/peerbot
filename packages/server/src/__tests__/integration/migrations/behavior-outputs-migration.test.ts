import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

const MIGRATION = '20260803140000_behavior_outputs.sql';

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

class Rollback extends Error {}

describe('Behavior outputs migration', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
  });

  it('backfills JSONPath keying and renames stable identities without exposing two APIs', async () => {
    const workspace = await TestWorkspace.create({ name: 'Behavior Outputs Migration Org' });
    const ownerUserId = workspace.users.owner.id;
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'behavior-output-migration-agent',
    });
    const api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: ownerUserId,
      memberRole: 'owner',
    });
    await api.entity_schema.createType({ slug: 'issue', name: 'Issue' });
    const entity = (await api.entities.create({
      type: 'issue',
      name: 'Legacy promoted issue',
      metadata: { external_id: 'ISSUE-1' },
    })) as { entity: { id: number } };
    const prefixedEntity = (await api.entities.create({
      type: 'issue',
      name: 'Legacy issue with output-prefixed stable key',
      metadata: { external_id: 'items::ISSUE-2' },
    })) as { entity: { id: number } };
    const created = (await api.behaviors.create({
      slug: 'legacy-keyed-behavior',
      prompt: 'Find issues.',
      agent_id: agent.agentId,
    })) as { behavior_id: string };
    const watcherId = Number(created.behavior_id);
    const sql = getDb();
    const up = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);
    let captured:
      | {
          outputs: unknown;
          identities: string[];
          legacyColumnPresent: boolean;
        }
      | undefined;

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx`ALTER TABLE watcher_versions ADD COLUMN IF NOT EXISTS keying_config jsonb`;
        await tx`
          UPDATE watcher_versions v
          SET outputs = NULL,
              keying_config = ${tx.json({
                entity_type: 'issue',
                entity_path: '$.items[*]',
                key_fields: ['external_id'],
                name_fields: ['title'],
              })}
          FROM watchers w
          WHERE w.id = ${watcherId}
            AND v.id = w.current_version_id
        `;
        await tx`
          UPDATE entities
          SET metadata = metadata || ${tx.json({ watcher_id: watcherId })}
          WHERE id IN (${entity.entity.id}, ${prefixedEntity.entity.id})
        `;
        await tx`
          INSERT INTO entity_identities (
            organization_id, entity_id, namespace, identifier, source_connector
          ) VALUES
            (
              ${workspace.org.id}, ${entity.entity.id}, 'watcher_key',
              ${`${watcherId}::issue-1`}, 'watcher'
            ),
            (
              ${workspace.org.id}, ${prefixedEntity.entity.id}, 'watcher_key',
              ${`${watcherId}::items::issue-2`}, 'watcher'
            )
        `;

        await tx.unsafe(up);
        const [version] = await tx<{ outputs: unknown }>`
          SELECT v.outputs
          FROM watcher_versions v
          JOIN watchers w ON w.current_version_id = v.id
          WHERE w.id = ${watcherId}
        `;
        const identities = await tx<{ identifier: string }>`
          SELECT identifier FROM entity_identities
          WHERE entity_id IN (${entity.entity.id}, ${prefixedEntity.entity.id})
            AND namespace = 'watcher_key'
          ORDER BY identifier
        `;
        const [column] = await tx<{ present: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'watcher_versions'
              AND column_name = 'keying_config'
          ) AS present
        `;
        captured = {
          outputs: version.outputs,
          identities: identities.map((row) => row.identifier),
          legacyColumnPresent: column.present,
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(captured).toEqual({
      outputs: {
        items: {
          entity: 'issue',
          key: ['external_id'],
          name: ['title'],
        },
      },
      identities: [
        `${watcherId}::items::issue-1`,
        `${watcherId}::items::items::issue-2`,
      ],
      legacyColumnPresent: false,
    });
  });

  it('does not rewrite current identities on a fresh baseline', async () => {
    const workspace = await TestWorkspace.create({ name: 'Behavior Outputs Fresh Baseline Org' });
    const ownerUserId = workspace.users.owner.id;
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'behavior-output-fresh-agent',
    });
    const api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: ownerUserId,
      memberRole: 'owner',
    });
    await api.entity_schema.createType({ slug: 'fresh-issue', name: 'Fresh Issue' });
    const entity = (await api.entities.create({
      type: 'fresh-issue',
      name: 'Fresh promoted issue',
      metadata: { external_id: 'ISSUE-3' },
    })) as { entity: { id: number } };
    const created = (await api.behaviors.create({
      slug: 'fresh-output-behavior',
      prompt: 'Find fresh issues.',
      agent_id: agent.agentId,
      outputs: { items: { entity: 'fresh-issue', key: ['external_id'] } },
    })) as { behavior_id: string };
    const watcherId = Number(created.behavior_id);
    const expected = `${watcherId}::items::issue-3`;
    const sql = getDb();
    const up = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);
    let captured: string | undefined;

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx`
          UPDATE entities
          SET metadata = metadata || ${tx.json({ watcher_id: watcherId })}
          WHERE id = ${entity.entity.id}
        `;
        await tx`
          INSERT INTO entity_identities (
            organization_id, entity_id, namespace, identifier, source_connector
          ) VALUES (
            ${workspace.org.id}, ${entity.entity.id}, 'watcher_key', ${expected}, 'watcher'
          )
        `;
        await tx.unsafe(up);
        const [identity] = await tx<{ identifier: string }>`
          SELECT identifier FROM entity_identities
          WHERE entity_id = ${entity.entity.id} AND namespace = 'watcher_key'
        `;
        captured = identity.identifier;
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(captured).toBe(expected);
  });

  it('aborts rather than stranding a legacy identity with a mismatched entity type', async () => {
    const workspace = await TestWorkspace.create({ name: 'Behavior Outputs Mismatch Org' });
    const ownerUserId = workspace.users.owner.id;
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'behavior-output-mismatch-agent',
    });
    const api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: ownerUserId,
      memberRole: 'owner',
    });
    await api.entity_schema.createType({ slug: 'actual-issue', name: 'Actual Issue' });
    const entity = (await api.entities.create({
      type: 'actual-issue',
      name: 'Legacy mismatched issue',
      metadata: { external_id: 'ISSUE-4' },
    })) as { entity: { id: number } };
    const created = (await api.behaviors.create({
      slug: 'mismatched-output-behavior',
      prompt: 'Find mismatched issues.',
      agent_id: agent.agentId,
    })) as { behavior_id: string };
    const watcherId = Number(created.behavior_id);
    const sql = getDb();
    const up = loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);

    await expect(
      sql.begin(async (tx: typeof sql) => {
        await tx`ALTER TABLE watcher_versions ADD COLUMN IF NOT EXISTS keying_config jsonb`;
        await tx`
          UPDATE watcher_versions v
          SET outputs = NULL,
              keying_config = ${tx.json({
                entity_type: 'missing-issue-type',
                entity_path: '$.items[*]',
                key_fields: ['external_id'],
              })}
          FROM watchers w
          WHERE w.id = ${watcherId} AND v.id = w.current_version_id
        `;
        await tx`
          UPDATE entities
          SET metadata = metadata || ${tx.json({ watcher_id: watcherId })}
          WHERE id = ${entity.entity.id}
        `;
        await tx`
          INSERT INTO entity_identities (
            organization_id, entity_id, namespace, identifier, source_connector
          ) VALUES (
            ${workspace.org.id}, ${entity.entity.id}, 'watcher_key',
            ${`${watcherId}::issue-4`}, 'watcher'
          )
        `;
        await tx.unsafe(up);
      })
    ).rejects.toThrow(/cannot map a live watcher_key/);
  });
});
