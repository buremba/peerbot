/**
 * Every audit writer speaks ONE `<subject>.<op>` vocabulary.
 *
 * The four `record*` writers each hold the pair under their own key
 * (`entity_type`, `resource_kind`, a bare `op`, or free-form caller metadata),
 * so classifying a row per writer would mean special-casing each. The funnel
 * (`insertConnectionlessAuditEvent`) REQUIRES the pair and stamps
 * `_lobu_event_type` itself, so:
 *   - a new writer that omits it is a compile error, not a silently
 *     unclassifiable row, and
 *   - a new event type costs no code here — pass a new `subject`.
 *
 * `_lobu_` matters: that namespace is stripped from caller input in
 * save_content.ts, so a member cannot forge an event type through save_memory.
 * Deriving the type from `category`/`entity_type` instead — both caller-writable
 * — would have been spoofable.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  formatAuditEventType,
  insertConnectionlessAuditEvent,
} from '../../../utils/insert-event';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

let organizationId: string;

async function stampedTypeFor(originId: string): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT metadata->>'_lobu_event_type' AS event_type
    FROM events
    WHERE organization_id = ${organizationId} AND origin_id = ${originId}
    LIMIT 1
  `) as unknown as Array<{ event_type: string | null }>;
  return rows[0]?.event_type ?? null;
}

describe('audit events carry a uniform _lobu_event_type', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    organizationId = (await createTestOrganization({ name: 'Audit Type Org' })).id;
  });

  it('formats the pair as dotted <subject>.<op>', () => {
    // Dotted + past tense, matching feed.auto_paused / message.created — NOT the
    // underscored origin_type audit tag.
    expect(formatAuditEventType({ subject: 'device', op: 'created' })).toBe(
      'device.created'
    );
  });

  it('stamps the type onto the persisted row', async () => {
    const originId = `audit_type_${Date.now()}`;
    await insertConnectionlessAuditEvent(
      {
        entityIds: [],
        organizationId,
        originId,
        title: 'Device registered',
        semanticType: 'change',
        metadata: { category: 'lifecycle' },
      },
      { subject: 'device', op: 'created' }
    );
    expect(await stampedTypeFor(originId)).toBe('device.created');
  });

  it('stamps over caller metadata that carries the same key', async () => {
    // The funnel's own stamp is applied after the caller's metadata spread, so
    // a writer passing `_lobu_event_type` itself cannot override the declared
    // pair. (save_content separately strips every `_lobu_*` key from member
    // input, so save_memory cannot reach this key at all.)
    const originId = `audit_forge_${Date.now()}`;
    await insertConnectionlessAuditEvent(
      {
        entityIds: [],
        organizationId,
        originId,
        title: 'Attempted forge',
        semanticType: 'change',
        metadata: { _lobu_event_type: 'device.created' },
      },
      { subject: 'entity', op: 'updated' }
    );
    expect(await stampedTypeFor(originId)).toBe('entity.updated');
  });

  it('keeps a distinct type per subject so one vocabulary covers every writer', async () => {
    const cases: Array<{ subject: string; op: string; expected: string }> = [
      { subject: 'connection', op: 'deleted', expected: 'connection.deleted' },
      { subject: 'relationship', op: 'linked', expected: 'relationship.linked' },
      { subject: 'member', op: 'created', expected: 'member.created' },
    ];
    for (const c of cases) {
      const originId = `audit_${c.expected}_${Date.now()}`;
      await insertConnectionlessAuditEvent(
        {
          entityIds: [],
          organizationId,
          originId,
          title: c.expected,
          semanticType: 'change',
        },
        { subject: c.subject, op: c.op }
      );
      expect(await stampedTypeFor(originId)).toBe(c.expected);
    }
  });
});
