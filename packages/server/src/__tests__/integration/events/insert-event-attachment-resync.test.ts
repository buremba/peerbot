/**
 * A re-sync republishes the same bytes, so the artifact reference is fresh
 * every time: `materializeInlineAttachments` mints a new `artifact_id` and a
 * new signed `download_url` per publication. Those two fields therefore say
 * nothing about whether the attachment CHANGED, and comparing them raw makes
 * every re-sync of an attachment-bearing item look like a new version —
 * superseding forever and growing `events` without bound.
 *
 * The dedup path is connector ingest (`insertEvent(..., { onConflictUpdate: true })`,
 * used by run-lifecycle); `save_memory` does not take it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestConnection, createTestOrganization } from '../../setup/test-fixtures';

function materializedAttachment(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'image',
    filename: 'photo.jpg',
    mime_type: 'image/jpeg',
    artifact_id: '11111111-1111-4111-8111-111111111111',
    download_url:
      'https://gw.example/lobu/api/v1/files/11111111-1111-4111-8111-111111111111?token=first',
    size_bytes: 2048,
    duration_ms: null,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('insertEvent attachment re-sync', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  async function seed() {
    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });
    const base = {
      entityIds: [] as number[],
      organizationId: org.id,
      originId: 'attachment-resync',
      title: 'item',
      content: 'body',
      semanticType: 'observation',
      connectorKey: 'reddit',
      connectionId: Number(connection.id),
    };
    const first = await insertEvent(
      { ...base, attachments: [materializedAttachment()] },
      { onConflictUpdate: true }
    );
    expect(first.change).toBe('inserted');
    return { base, first };
  }

  it('does not supersede when only artifact_id and download_url were re-minted', async () => {
    const { base, first } = await seed();

    // Same bytes, republished: a fresh artifact id and a fresh signed URL.
    const resync = await insertEvent(
      {
        ...base,
        attachments: [
          materializedAttachment({
            artifact_id: '22222222-2222-4222-8222-222222222222',
            download_url:
              'https://gw.example/lobu/api/v1/files/22222222-2222-4222-8222-222222222222?token=second',
          }),
        ],
      },
      { onConflictUpdate: true }
    );

    expect(resync.change).toBe('unchanged');
    expect(Number(resync.id)).toBe(Number(first.id));
  });

  it('still supersedes when the attachment itself changed', async () => {
    const { base, first } = await seed();

    const changed = await insertEvent(
      {
        ...base,
        attachments: [
          materializedAttachment({
            artifact_id: '33333333-3333-4333-8333-333333333333',
            download_url:
              'https://gw.example/lobu/api/v1/files/33333333-3333-4333-8333-333333333333?token=third',
            filename: 'replacement.jpg',
            size_bytes: 4096,
            sha256: 'c'.repeat(64),
          }),
        ],
      },
      { onConflictUpdate: true }
    );

    expect(changed.change).toBe('superseded');
    expect(Number(changed.id)).not.toBe(Number(first.id));
  });

  it('does not supersede when the connector renamed the same bytes', async () => {
    const { base, first } = await seed();

    // The real prod shape: the retired whatsapp.local bridge named each voice
    // note with a fresh UUID, so a re-sync of identical bytes arrives under a
    // different filename.
    const renamed = await insertEvent(
      {
        ...base,
        attachments: [
          materializedAttachment({
            artifact_id: '55555555-5555-4555-8555-555555555555',
            download_url:
              'https://gw.example/lobu/api/v1/files/55555555-5555-4555-8555-555555555555?token=fifth',
            filename: 'cc9eab3c-1944-47ac-bd84-255473e48343.jpg',
          }),
        ],
      },
      { onConflictUpdate: true }
    );

    expect(renamed.change).toBe('unchanged');
    expect(Number(renamed.id)).toBe(Number(first.id));
  });

  it('still supersedes when the bytes changed but the envelope did not', async () => {
    const { base, first } = await seed();

    // Same filename, same size, same mime — only the content hash differs.
    // Envelope-only comparison would call this unchanged and strand the edit.
    const edited = await insertEvent(
      {
        ...base,
        attachments: [
          materializedAttachment({
            artifact_id: '44444444-4444-4444-8444-444444444444',
            download_url:
              'https://gw.example/lobu/api/v1/files/44444444-4444-4444-8444-444444444444?token=fourth',
            sha256: 'b'.repeat(64),
          }),
        ],
      },
      { onConflictUpdate: true }
    );

    expect(edited.change).toBe('superseded');
    expect(Number(edited.id)).not.toBe(Number(first.id));
  });

  it('treats a hashless attachment id as durable identity', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });
    const base = {
      entityIds: [] as number[],
      organizationId: org.id,
      originId: 'attachment-referenced',
      title: 'item',
      content: 'body',
      semanticType: 'observation',
      connectorKey: 'reddit',
      connectionId: Number(connection.id),
    };
    // A connector referencing an artifact it already owns publishes nothing, so
    // there is no hash and the id is the only identity the row carries.
    const referenced = { kind: 'image', artifact_id: 'external-a' };
    const first = await insertEvent(
      { ...base, attachments: [referenced] },
      { onConflictUpdate: true }
    );
    expect(first.change).toBe('inserted');

    const repointed = await insertEvent(
      { ...base, attachments: [{ kind: 'image', artifact_id: 'external-b' }] },
      { onConflictUpdate: true }
    );
    expect(repointed.change).toBe('superseded');

    const same = await insertEvent(
      { ...base, attachments: [{ kind: 'image', artifact_id: 'external-b' }] },
      { onConflictUpdate: true }
    );
    expect(same.change).toBe('unchanged');
  });

  it('still supersedes when an attachment is dropped', async () => {
    const { base } = await seed();

    const dropped = await insertEvent(
      { ...base, attachments: [] },
      { onConflictUpdate: true }
    );

    expect(dropped.change).toBe('superseded');
  });
});
