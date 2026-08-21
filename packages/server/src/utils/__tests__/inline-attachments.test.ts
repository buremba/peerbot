import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  runArtifactBinding,
} from '../../gateway/files/artifact-store';
import {
  AttachmentMaterializationError,
  deleteMaterializedArtifacts,
  MaterializedArtifactCleanupError,
  materializeActionOutputAttachments,
  materializeInlineAttachments,
} from '../inline-attachments';

describe('materializeActionOutputAttachments', () => {
  let artifactsDir: string;
  let artifactStore: ArtifactStore;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'lobu-action-attachments-'));
    process.env.ENCRYPTION_KEY = Buffer.from(
      '12345678901234567890123456789012',
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
    const { output, publishedArtifactIds } =
      await materializeActionOutputAttachments(
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
        artifactStore,
      );

    expect(output.asset_local_id).toBe('photo-123');
    expect(publishedArtifactIds).toHaveLength(1);
    const attachment = (
      output.attachments as Array<Record<string, unknown>>
    )[0];
    expect(attachment).toEqual(
      expect.objectContaining({
        kind: 'image',
        filename: 'photo.jpg',
        mime_type: 'image/jpeg',
        artifact_id: expect.any(String),
        download_url: expect.any(String),
        size_bytes: bytes.length,
      }),
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
        flakyStore,
      ),
    ).rejects.toThrow('second publish failed');

    expect(firstArtifactId).toBeTruthy();
    expect(await artifactStore.read(firstArtifactId!)).toBeNull();
  });

  it('surfaces a failed partial-publication cleanup', async () => {
    let publishCalls = 0;
    let firstArtifactId: string | undefined;
    const failingCleanupStore = {
      publish: async (params: Parameters<ArtifactStore['publish']>[0]) => {
        publishCalls += 1;
        if (publishCalls === 2) throw new Error('second publish failed');
        const published = await artifactStore.publish(params);
        firstArtifactId = published.artifactId;
        return published;
      },
      delete: async () => {
        throw new Error('cleanup failed');
      },
    };

    const materialization = materializeActionOutputAttachments(
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
      );
    await expect(materialization).rejects.toBeInstanceOf(
      AttachmentMaterializationError
    );
    await expect(materialization).rejects.toMatchObject({
      publishedArtifactIds: [firstArtifactId],
      errors: [
        expect.objectContaining({ message: 'second publish failed' }),
        expect.objectContaining({
          message: expect.stringContaining(
            'Failed to delete 1 uncommitted artifact(s)',
          ),
        }),
      ],
    });
  });

  it('reports exactly which artifact rollbacks failed', async () => {
    const cleanup = deleteMaterializedArtifacts(['kept', 'deleted'], {
      delete: async (artifactId: string) => {
        if (artifactId === 'kept') throw new Error('volume unavailable');
      },
    });

    await expect(cleanup).rejects.toBeInstanceOf(MaterializedArtifactCleanupError);
    await expect(cleanup).rejects.toMatchObject({ artifactIds: ['kept'] });
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
      artifactStore,
    );
    expect(publishedArtifactIds).toHaveLength(1);
    expect(await artifactStore.read(publishedArtifactIds[0])).toBeTruthy();

    await deleteMaterializedArtifacts(publishedArtifactIds, artifactStore);
    expect(await artifactStore.read(publishedArtifactIds[0])).toBeNull();
  });

  it('accepts line-wrapped base64 from MIME-style encoders', async () => {
    const bytes = Buffer.from('wrapped-base64-payload-long-enough-to-wrap');
    const wrapped = bytes.toString('base64').replace(/(.{20})/g, "$1\n");
    expect(wrapped).toContain("\n");

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
      artifactStore,
    );

    const attachment = (
      output.attachments as Array<Record<string, unknown>>
    )[0];
    expect(attachment).toBeTruthy();
    const stored = await artifactStore.read(String(attachment.artifact_id), {
      binding: runArtifactBinding(101),
    });
    expect(stored!.bytes).toEqual(bytes);
  });

  it('drops invalid base64 values instead of persisting corrupted bytes', async () => {
    const { output, publishedArtifactIds } =
      await materializeActionOutputAttachments(
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
              filename: 'wrong-type.png',
              mime_type: 'image/png',
              data: null,
            },
            {
              kind: 'image',
              filename: 'padding-only.png',
              mime_type: 'image/png',
              data: '==',
            },
            {
              kind: 'image',
              filename: 'bad-padding.png',
              mime_type: 'image/png',
              data: 'YQ=',
            },
            {
              kind: 'image',
              filename: 'noncanonical.png',
              mime_type: 'image/png',
              data: 'AB==',
            },
          ],
        },
        artifactStore,
      );

    expect(output.attachments).toEqual([]);
    expect(publishedArtifactIds).toEqual([]);
  });

  it('rejects oversized raw MIME framing before normalization', async () => {
    let publishCalls = 0;
    const base64Cap = Math.ceil((2 * 1024 * 1024 * 4) / 3) + 4;
    const rawCap = base64Cap + Math.ceil(base64Cap / 64) * 2 + 2;
    const store = {
      publish: async () => {
        publishCalls += 1;
        throw new Error('must not publish');
      },
      delete: async () => {},
    };

    const { output } = await materializeActionOutputAttachments(
      102,
      {
        attachments: [
          {
            filename: 'framed.bin',
            mime_type: 'application/octet-stream',
            data: `${" ".repeat(rawCap + 1)}YQ==`,
          },
        ],
      },
      store as never,
    );

    expect(output.attachments).toEqual([]);
    expect(publishCalls).toBe(0);
  });

  it('propagates cleanup failures instead of only logging them', async () => {
    await expect(
      deleteMaterializedArtifacts(['00000000-0000-4000-8000-000000000001'], {
        delete: async () => {
          throw new Error('retained PVC delete failed');
        },
      }),
    ).rejects.toThrow('retained PVC delete failed');
  });

  it('strips a connector-forged content hash from prepublished references', async () => {
    const { items } = await materializeInlineAttachments(
      [
        {
          id: 'forged-hash',
          attachments: [
            {
              artifact_id: '00000000-0000-4000-8000-000000000001',
              sha256: 'a'.repeat(64),
            },
          ],
        },
      ],
      undefined,
      artifactStore,
    );

    expect(items[0]!.attachments![0]).toEqual({
      artifact_id: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('surfaces cleanup failure after a partial publication', async () => {
    let publishCalls = 0;
    const store = {
      publish: async (params: Parameters<ArtifactStore['publish']>[0]) => {
        publishCalls += 1;
        if (publishCalls === 2) throw new Error('second publish failed');
        return artifactStore.publish(params);
      },
      delete: async () => {
        throw new Error('partial cleanup failed');
      },
    };

    await expect(
      materializeActionOutputAttachments(
        103,
        {
          attachments: [
            { filename: 'one.bin', data: 'YQ==' },
            { filename: 'two.bin', data: 'Yg==' },
          ],
        },
        store,
      ),
    ).rejects.toThrow('partial cleanup failed');
  });
});
