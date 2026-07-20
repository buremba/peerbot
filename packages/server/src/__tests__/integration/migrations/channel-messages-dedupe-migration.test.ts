import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationDownSection, loadMigrationUpSection } from '../../../db/migration-loader';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

const DEDUPE_MIGRATION = '20260719120010_drop_channel_messages_global_dedupe.sql';

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

async function executeNonTransactionalSection(section: string): Promise<void> {
  const sql = getDb();
  for (const statement of section.split(/;\s*(?:\n|$)/).map((part) => part.trim())) {
    if (statement) await sql.unsafe(statement);
  }
}

describe('channel message dedupe migration', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
  });

  afterAll(async () => {
    await getDb().unsafe('DROP INDEX CONCURRENTLY IF EXISTS public.channel_messages_dedup');
    await cleanupTestDatabase();
  });

  it('allows cross-organization duplicates after rollback and reapply', async () => {
    const migrationsDir = resolveMigrationsDir();
    const down = loadMigrationDownSection(migrationsDir, DEDUPE_MIGRATION);
    const up = loadMigrationUpSection(migrationsDir, DEDUPE_MIGRATION);
    const firstOrg = await createTestOrganization({ name: 'Dedupe migration one' });
    const secondOrg = await createTestOrganization({ name: 'Dedupe migration two' });
    const sql = getDb();

    await executeNonTransactionalSection(down);
    await executeNonTransactionalSection(up);

    const messages = await sql`
      INSERT INTO channel_messages (
        organization_id, connection_id, platform, channel_id,
        platform_message_id, is_bot, text, occurred_at
      ) VALUES
        (
          ${firstOrg.id}, 'preview-shared', 'slack', 'C-SHARED',
          'M-SHARED', false, 'first organization', NOW()
        ),
        (
          ${secondOrg.id}, 'preview-shared', 'slack', 'C-SHARED',
          'M-SHARED', false, 'second organization', NOW()
        )
      RETURNING id
    `;

    expect(messages).toHaveLength(2);
  });
});
