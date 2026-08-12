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
  });

  it('excludes workspace audit rows from recent and capturedToday', async () => {
    const empty = await resolveSlackHomeContext(organizationId);
    expect(empty).not.toBeNull();
    expect(empty!.capturedToday).toBe(0);
    expect(empty!.recent).toHaveLength(0);

    await createTestEvent({
      organization_id: organizationId,
      content: normalTitle,
      title: normalTitle,
    });
    const withNormal = await resolveSlackHomeContext(organizationId);
    expect(withNormal!.capturedToday).toBe(1);
    expect(
      withNormal!.recent.some((r) => r.title.includes(normalTitle.slice(0, 20)))
    ).toBe(true);

    // Inserting a genuine workspace-audit row must NOT move the count or
    // appear in recent — this fails closed if the exclusion predicate is dropped.
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
    const withAudit = await resolveSlackHomeContext(organizationId);
    expect(withAudit!.capturedToday).toBe(1);
    expect(withAudit!.recent.some((r) => r.title.includes('secret'))).toBe(false);
    expect(
      withAudit!.recent.some((r) => r.title.includes(normalTitle.slice(0, 20)))
    ).toBe(true);
  });
});
