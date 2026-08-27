/**
 * Connectionless audit inserts retry with the same origin_id. Without a unique
 * (connection_id, origin_id) constraint, a bare re-insert after an ambiguous
 * success would append a duplicate. insertConnectionlessAuditEvent reconciles
 * first — this test pins that contract.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { insertConnectionlessAuditEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

describe('insertConnectionlessAuditEvent idempotency', () => {
  let organizationId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Audit insert idempotency' });
    organizationId = org.id;
  });

  it('a second call reuses the first row after lineage is NUL-stripped', async () => {
    const originId = `workspace_member_created_test_${Date.now()}_idem\0origin`;
    const parentOriginId = 'workspace_parent\0member';
    const params = {
      entityIds: [] as number[],
      organizationId,
      originId,
      parentOriginId,
      title: 'Member "a member" added',
      semanticType: 'change',
      originType: 'workspace_member_created',
      payloadType: 'empty' as const,
      payloadData: { state: { id: 'member_1', role: 'member' } },
      metadata: {
        category: 'workspace',
        _lobu_workspace_audit: true,
        resource_kind: 'member',
        resource_id: 'member_1',
        op: 'created',
      },
    };

    const first = await insertConnectionlessAuditEvent(params, { subject: 'member', op: 'created' });
    const second = await insertConnectionlessAuditEvent(params, { subject: 'member', op: 'created' });

    expect(second.change).toBe('unchanged');
    expect(second.id).toBe(first.id);
    expect(second.origin_id).toBe(originId.replaceAll('\0', ''));

    const sql = getDb();
    const rows = await sql`
      SELECT id, origin_parent_id FROM events
      WHERE organization_id = ${organizationId}
        AND metadata->>'_lobu_idempotency_key' = ${`audit:${originId.replaceAll('\0', '')}`}
    `;
    expect(rows).toEqual([
      expect.objectContaining({ origin_parent_id: parentOriginId.replaceAll('\0', '') }),
    ]);
  });

  it('concurrent same-origin inserts resolve to a single row', async () => {
    const originId = `workspace_member_created_test_${Date.now()}_race`;
    const params = {
      entityIds: [] as number[],
      organizationId,
      originId,
      title: 'Member "racer" added',
      semanticType: 'change',
      originType: 'workspace_member_created',
      payloadType: 'empty' as const,
      payloadData: { state: { id: 'member_race', role: 'member' } },
      metadata: {
        category: 'workspace',
        _lobu_workspace_audit: true,
        resource_kind: 'member',
        resource_id: 'member_race',
        op: 'created',
      },
    };

    const results = await Promise.all([
      insertConnectionlessAuditEvent(params, { subject: 'member', op: 'created' }),
      insertConnectionlessAuditEvent(params, { subject: 'member', op: 'created' }),
      insertConnectionlessAuditEvent(params, { subject: 'member', op: 'created' }),
    ]);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);

    const sql = getDb();
    const rows = await sql`
      SELECT id FROM events
      WHERE organization_id = ${organizationId}
        AND metadata->>'_lobu_idempotency_key' = ${`audit:${originId}`}
    `;
    expect(rows).toHaveLength(1);
  });
});
