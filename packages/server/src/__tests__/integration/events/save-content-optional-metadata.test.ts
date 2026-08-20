/**
 * Integration test: `save_memory` accepts calls without `metadata`.
 * Omitted metadata passes the shared tool validator and is normalized to `{}`
 * by the save path; ordinary caller metadata remains accepted.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { saveContent } from '../../../tools/save_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > optional metadata', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Optional Metadata Org' });
    user = await createTestUser({ email: 'optional-metadata@example.com' });
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

  it('saves a plain note with no metadata key at all', async () => {
    const saved = await saveContent(
      {
        content: 'a note saved without any metadata',
        semantic_type: 'content',
      },
      {} as never,
      ctx
    );

    expect(saved.id).toBeGreaterThan(0);
    expect(saved.created).toBe(true);
    expect(saved.metadata).toEqual({});
  });

  it('still preserves ordinary metadata when supplied', async () => {
    const saved = await saveContent(
      {
        content: 'a note saved with metadata',
        semantic_type: 'content',
        metadata: { namespace: 'optional-metadata-test', importance: 'low' },
      },
      {} as never,
      ctx
    );

    expect(saved.metadata).toMatchObject({
      namespace: 'optional-metadata-test',
      importance: 'low',
    });
  });
});
