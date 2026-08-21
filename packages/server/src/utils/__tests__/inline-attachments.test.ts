import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  runArtifactBinding,
} from '../../gateway/files/artifact-store';
import {
  deleteMaterializedArtifacts,
  materializeActionOutputAttachments,
} from '../inline-attachments';

describe('materializeActionOutputAttachments', () => {
  let artifactsDir: string;
  let artifactStore: ArtifactStore;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-action-attachments-'));
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012'
    ).toString('base64');
    artifactStore = new ArtifactStore(artifactsDir);
  });

  afterEach(() => {
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('reuses connector attachment materialization for device action media', async () => {
    const bytes = Buffer.from('device-photo-bytes');
    const { output, publishedArtifactIds } = await materializeActionOutputAttachments(
      42,
      {
        asset_local_id: 'photo-123',
        attachments: [
          {
            kind: 'image',
            filename: 'photo.jpg',
            mime_type: 'image/jpeg',
            data: bytes.toString('base64'),
            size_bytes: bytes.length,
          },
        ],
      },
      artifactStore
    );

    expect(output.asset_local_id).toBe('photo-123');
    expect(publishedArtifactIds).toHaveLength(1);
    const attachment = (output.attachments as Array<Record<string, unknown>>)[0];
    expect(attachment).toEqual(
      expect.objectContaining({
        kind: 'image',
        filename: 'photo.jpg',
        mime_type: 'image/jpeg',
        artifact_id: expect.any(String),
        download_url: expect.any(String),
        size_bytes: bytes.length,
      })
    );
    expect(attachment).not.toHaveProperty('data');

    const stored = await artifactStore.read(String(attachment.artifact_id), {
      binding: runArtifactBinding(42),
    });
    expect(stored).toBeTruthy();
    expect(stored!.bytes).toEqual(bytes);
  });

  it('deletes partial publishes when a later attachment publish fails', async () => {
    let publishCalls = 0;
    let firstArtifactId: string | undefined;
    const flakyStore = {
      publish: async (params: Parameters<ArtifactStore['publish']>[0]) => {
        publishCalls += 1;
        if (publishCalls === 2) throw new Error('second publish failed');
        const published = await artifactStore.publish(params);
        firstArtifactId = published.artifactId;
        return published;
      },
      delete: (artifactId: string) => artifactStore.delete(artifactId),
    };

    await expect(
      materializeActionOutputAttachments(
        77,
        {
          attachments: [
            {
              kind: 'image',
              filename: 'first.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('first').toString('base64'),
            },
            {
              kind: 'image',
              filename: 'second.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('second').toString('base64'),
            },
          ],
        },
        flakyStore
      )
    ).rejects.toThrow('second publish failed');

    expect(firstArtifactId).toBeTruthy();
    expect(await artifactStore.read(firstArtifactId!)).toBeNull();
  });

  it('surfaces a failed partial-publication cleanup', async () => {
    let publishCalls = 0;
    const failingCleanupStore = {
      publish: async (params: Parameters<ArtifactStore['publish']>[0]) => {
        publishCalls += 1;
        if (publishCalls === 2) throw new Error('second publish failed');
        return artifactStore.publish(params);
      },
      delete: async () => {
        throw new Error('cleanup failed');
      },
    };

    await expect(
      materializeActionOutputAttachments(
        78,
        {
          attachments: [
            {
              filename: 'first.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('first').toString('base64'),
            },
            {
              filename: 'second.jpg',
              mime_type: 'image/jpeg',
              data: Buffer.from('second').toString('base64'),
            },
          ],
        },
        failingCleanupStore
      )
    ).rejects.toThrow(
      'Attachment publication failed and partial artifact cleanup also failed'
    );
  });

  it('deletes materialized action artifacts when finalization is abandoned', async () => {
    const { publishedArtifactIds } = await materializeActionOutputAttachments(
      88,
      {
        attachments: [
          {
            kind: 'image',
            filename: 'abandoned.jpg',
            mime_type: 'image/jpeg',
            data: Buffer.from('abandoned').toString('base64'),
          },
        ],
      },
      artifactStore
    );
    expect(publishedArtifactIds).toHaveLength(1);
    expect(await artifactStore.read(publishedArtifactIds[0])).toBeTruthy();

    await deleteMaterializedArtifacts(publishedArtifactIds, artifactStore);
    expect(await artifactStore.read(publishedArtifactIds[0])).toBeNull();
  });

  it('accepts line-wrapped base64 from MIME-style encoders', async () => {
    const bytes = Buffer.from('wrapped-base64-payload-long-enough-to-wrap');
    const wrapped = bytes.toString('base64').replace(/(.{20})/g, '$1\n');
    expect(wrapped).toContain('\n');

    const { output } = await materializeActionOutputAttachments(
      101,
      {
        attachments: [
          {
            kind: 'image',
            filename: 'wrapped.png',
            mime_type: 'image/png',
            data: wrapped,
          },
        ],
      },
      artifactStore
    );

    const attachment = (output.attachments as Array<Record<string, unknown>>)[0];
    expect(attachment).toBeTruthy();
    const stored = await artifactStore.read(String(attachment.artifact_id), {
      binding: runArtifactBinding(101),
    });
    expect(stored!.bytes).toEqual(bytes);
  });

  it('drops invalid base64 values instead of persisting corrupted bytes', async () => {
    const { output, publishedArtifactIds } = await materializeActionOutputAttachments(
      99,
      {
        attachments: [
          {
            kind: 'image',
            filename: 'bad.png',
            mime_type: 'image/png',
            data: 'not-base64!!',
          },
          {
            kind: 'image',
            filename: 'empty.png',
            mime_type: 'image/png',
            data: '',
          },
          {
            kind: 'image',
            filename: 'padding-only.png',
            mime_type: 'image/png',
            data: '==',
          },
          {
            kind: 'image',
            filename: 'wrong-type.png',
            mime_type: 'image/png',
            data: null,
          },
        ],
      },
      artifactStore
    );

    expect(output.attachments).toEqual([]);
    expect(publishedArtifactIds).toEqual([]);
  });

  it('drops raw base64 input beyond the MIME framing allowance', async () => {
    const { output, publishedArtifactIds } = await materializeActionOutputAttachments(
      100,
      {
        attachments: [
          {
            kind: 'image',
            filename: 'whitespace-heavy.png',
            mime_type: 'image/png',
            data: `${' '.repeat(6 * 1024 * 1024)}QQ==`,
          },
        ],
      },
      artifactStore
    );

    expect(output.attachments).toEqual([]);
    expect(publishedArtifactIds).toEqual([]);
  });
});
