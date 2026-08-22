import { beforeEach, describe, expect, it } from 'vitest';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

describe('insertEvent NUL sanitization', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('strips NUL from scalar and nested connector fields before persistence', async () => {
    const org = await createTestOrganization();
    const occurredAt = new Date('2026-08-21T22:00:00.000Z');

    const inserted = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'source\u0000item',
      title: 'ti\u0000tle',
      content: 'pay\u0000load',
      payloadData: {
        'nul\u0000key': 'nested\u0000value',
        array: ['a\u0000b'],
      },
      attachments: [{ filename: 'fi\u0000le.txt' }],
      metadata: { source: 'con\u0000nector' },
      authorName: 'au\u0000thor',
      occurredAt,
      semanticType: 'obser\u0000vation',
    });

    const [row] = await getTestDb()<{
      origin_id: string;
      title: string;
      payload_text: string;
      payload_data: Record<string, unknown>;
      attachments: Array<Record<string, unknown>>;
      metadata: Record<string, unknown>;
      author_name: string;
      semantic_type: string;
      occurred_at: Date;
    }>`
      SELECT origin_id, title, payload_text, payload_data, attachments, metadata,
             author_name, semantic_type, occurred_at
      FROM events
      WHERE id = ${inserted.id}
    `;

    expect(row).toMatchObject({
      origin_id: 'sourceitem',
      title: 'title',
      payload_text: 'payload',
      payload_data: { nulkey: 'nestedvalue', array: ['ab'] },
      attachments: [{ filename: 'file.txt' }],
      metadata: { source: 'connector' },
      author_name: 'author',
      semantic_type: 'observation',
    });
    expect(row.occurred_at.toISOString()).toBe(occurredAt.toISOString());
  });
});
