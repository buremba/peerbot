import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactStore,
  runArtifactBinding,
} from '../../gateway/files/artifact-store';
import * as lobuGateway from '../../lobu/gateway';
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
    vi.spyOn(lobuGateway, 'getLobuCoreServices').mockReturnValue({
      getArtifactStore: () => artifactStore,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      }
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
    expect(await readFile(stored!.filePath)).toEqual(bytes);
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
    vi.mocked(lobuGateway.getLobuCoreServices).mockReturnValue({
      getArtifactStore: () => flakyStore,
    });

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
        }
      )
    ).rejects.toThrow('second publish failed');

    expect(firstArtifactId).toBeTruthy();
    expect(await artifactStore.read(firstArtifactId!)).toBeNull();
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
      }
    );
    expect(publishedArtifactIds).toHaveLength(1);
    expect(await artifactStore.read(publishedArtifactIds[0])).toBeTruthy();

    await deleteMaterializedArtifacts(publishedArtifactIds);
    expect(await artifactStore.read(publishedArtifactIds[0])).toBeNull();
  });
});
