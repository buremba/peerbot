/**
 * Integration test: save_content payload_type='json_template' save-side schema.
 *
 * save_content (save_memory) validates the json_template contract at the
 * handler level (save_content.ts), AFTER the org write gate and after
 * `ensureMemberEntityType` (a DB write) — so this is necessarily a DB-backed
 * test, not a pure unit test.
 *
 * Pinned behavior:
 *   - payload_type='json_template' with NO payload_template → ToolUserError
 *     ("payload_template is required when payload_type is 'json_template'").
 *   - payload_type='json_template' WITH a payload_template that lacks a `root`
 *     key → the handler does NOT enforce template structure; the save
 *     SUCCEEDS and stores the template verbatim. (Structure is the renderer's
 *     problem — and the renderer degrades gracefully on malformed templates;
 *     see packages/owletto json-renderer/renderer.test.ts.)
 *
 * Vitest CI gap note (mirrors neighbors): runs locally / in the CI
 * integration job against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { saveContent } from '../../../tools/save_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > json_template save-side schema', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'JSON Template Org' });
    user = await createTestUser({ email: 'json-template@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
    };
  });

  it("throws when payload_type='json_template' and payload_template is missing", async () => {
    await expect(
      saveContent(
        {
          payload_type: 'json_template',
          payload_data: { score: 42 },
          semantic_type: 'content',
          metadata: {},
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/payload_template is required when payload_type is 'json_template'/);
  });

  it('saves successfully when payload_template lacks a `root` key (no structural enforcement)', async () => {
    // The handler only checks presence of payload_template, not its shape. A
    // template missing `root` is accepted and stored verbatim; the renderer is
    // responsible for graceful degradation at display time.
    const result = await saveContent(
      {
        payload_type: 'json_template',
        payload_template: { version: 1 /* no `root` */ },
        payload_data: { score: 42 },
        semantic_type: 'content',
        title: 'Rootless template',
        metadata: {},
      } as never,
      {} as never,
      ctx
    );

    expect(result.id).toBeGreaterThan(0);
    expect(result.semantic_type).toBe('content');

    // The rootless template is persisted exactly as given.
    const sql = getTestDb();
    const rows = await sql`
      SELECT payload_type, payload_template FROM events WHERE id = ${result.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_type).toBe('json_template');
    expect(rows[0].payload_template).toMatchObject({ version: 1 });
    expect((rows[0].payload_template as Record<string, unknown>).root).toBeUndefined();
  });
});
