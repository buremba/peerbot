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
          identity: string;
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
          WHERE id = ${entity.entity.id}
        `;
        await tx`
          INSERT INTO entity_identities (
            organization_id, entity_id, namespace, identifier, source_connector
          ) VALUES (
            ${workspace.org.id}, ${entity.entity.id}, 'watcher_key',
            ${`${watcherId}::issue-1`}, 'watcher'
          )
        `;

        await tx.unsafe(up);
        const [version] = await tx<{ outputs: unknown }>`
          SELECT v.outputs
          FROM watcher_versions v
          JOIN watchers w ON w.current_version_id = v.id
          WHERE w.id = ${watcherId}
        `;
        const [identity] = await tx<{ identifier: string }>`
          SELECT identifier FROM entity_identities
          WHERE entity_id = ${entity.entity.id} AND namespace = 'watcher_key'
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
          identity: identity.identifier,
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
      identity: `${watcherId}::items::issue-1`,
      legacyColumnPresent: false,
    });
  });
});
