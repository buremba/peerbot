/**
 * createSyncRun orphan-feed handling (#1012).
 *
 * A feed whose connector resolves to a definition + version row that has no
 * compiled code and no bundled source file (the prod `chrome.tabs` state) can
 * never run. Pre-fix, createSyncRun threw on every CheckDueFeeds tick, storming
 * the logs with a per-poll error and never making progress. It must instead
 * soft-delete the orphan feed (mirroring the no-definition path) so it stops
 * appearing in CheckDueFeeds.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { createSyncRun } from '../../../utils/queue-helpers';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
} from '../../setup/test-fixtures';

describe('createSyncRun orphan-feed handling (#1012)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('soft-deletes a feed whose connector has no compiled code and no bundled source instead of throwing', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();

    // Definition + version exist (so this is NOT the no-definition orphan path)…
    await createTestConnectorDefinition({
      key: 'orphan.no_code',
      name: 'Orphan No Code',
      organization_id: org.id,
    });
    // …but the version carries no runnable code, and the key is not a bundled
    // connector — exactly the prod `chrome.tabs` state that threw every poll.
    await sql`UPDATE connector_versions SET compiled_code = NULL WHERE connector_key = 'orphan.no_code'`;

    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'orphan.no_code',
    });
    const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${conn.id}`;
    const feedId = Number((feed as { id: number }).id);

    // Pre-fix: threw "has no compiled code and no bundled source file".
    const runId = await createSyncRun(feedId, {} as Env, sql);
    expect(runId).toBeNull();

    const [after] = await sql`SELECT deleted_at FROM feeds WHERE id = ${feedId}`;
    expect((after as { deleted_at: Date | null }).deleted_at).not.toBeNull();

    // No run row was created for the orphan feed.
    const runs = await sql`SELECT id FROM runs WHERE feed_id = ${feedId}`;
    expect(runs.length).toBe(0);
  });
});
