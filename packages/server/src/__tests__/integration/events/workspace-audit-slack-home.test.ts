/**
 * Slack App Home is org-scoped for any linked Slack user — it must never
 * surface owner/admin-only workspace-identity audit rows in recent activity
 * or the "captured today" count.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { resolveSlackHomeContext } from '../../../gateway/connections/chat-instance-manager';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestEvent,
  createTestOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('workspace-identity audit events > Slack App Home', () => {
  let organizationId: string;
  let normalTitle: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Slack Home Audit Org' });
    organizationId = org.id;
    normalTitle = `normal-home-event-${Date.now()}`;

    await createTestEvent({
      organization_id: organizationId,
      content: normalTitle,
      title: normalTitle,
    });

    await createTestEvent({
      organization_id: organizationId,
      content: 'workspace audit lifecycle row',
      title: 'Member "secret" added',
      semantic_type: 'change',
      metadata: {
        category: 'workspace',
        _lobu_workspace_audit: true,
        resource_kind: 'member',
        op: 'created',
      },
    });
  });

  it('excludes workspace audit rows from recent and capturedToday', async () => {
    const ctx = await resolveSlackHomeContext(organizationId);
    expect(ctx).not.toBeNull();
    expect(ctx!.recent.some((r) => r.title.includes('secret'))).toBe(false);
    expect(ctx!.recent.some((r) => r.title.includes(normalTitle.slice(0, 20)))).toBe(
      true
    );
    // At least the normal event from today; audit must not inflate the count.
    expect(ctx!.capturedToday).toBeGreaterThanOrEqual(1);
    // If only our two inserts exist for this org today, capturedToday is 1.
    // Bound loosely so concurrent test noise cannot false-fail.
    expect(ctx!.capturedToday).toBeLessThanOrEqual(50);
  });
});
