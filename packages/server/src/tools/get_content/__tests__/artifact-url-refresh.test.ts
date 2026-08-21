import type { ContentItem } from '@lobu/connector-sdk';
import { describe, expect, test } from 'vitest';
import { refreshEventArtifactDownloadUrls } from '../render';

describe('refreshEventArtifactDownloadUrls', () => {
  test('bounds metadata verification concurrency while replacing expired URLs', async () => {
    let active = 0;
    let maxActive = 0;
    const bindings: string[] = [];
    const items = [1, 2].map(
      (id) =>
        ({
          id,
          origin_id: `origin-${id}`,
          connection_id: 42,
          feed_id: null,
          attachments: [0, 1].map((index) => ({
            artifact_id: `artifact-${id}-${index}`,
            download_url: 'https://expired.example.test',
          })),
        }) as unknown as ContentItem
    );

    await refreshEventArtifactDownloadUrls({
      items,
      organizationId: 'org-1',
      publicGatewayUrl: 'https://gateway.example.test',
      artifactStore: {
        mintBoundDownloadUrl: async ({ artifactId, binding }) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          bindings.push(binding);
          await new Promise((resolve) => setTimeout(resolve, 0));
          active -= 1;
          return `https://fresh.example.test/${artifactId}`;
        },
      },
    });

    expect(maxActive).toBe(1);
    expect(bindings).toEqual([
      'event:org-1:connection:42:origin-1',
      'event:org-1:connection:42:origin-1',
      'event:org-1:connection:42:origin-2',
      'event:org-1:connection:42:origin-2',
    ]);
    expect(items.flatMap((item) => item.attachments ?? [])).toEqual([
      {
        artifact_id: 'artifact-1-0',
        download_url: 'https://fresh.example.test/artifact-1-0',
      },
      {
        artifact_id: 'artifact-1-1',
        download_url: 'https://fresh.example.test/artifact-1-1',
      },
      {
        artifact_id: 'artifact-2-0',
        download_url: 'https://fresh.example.test/artifact-2-0',
      },
      {
        artifact_id: 'artifact-2-1',
        download_url: 'https://fresh.example.test/artifact-2-1',
      },
    ]);
  });

  test('drops an unmintable URL and leaves unbindable attachments alone', async () => {
    const seen: string[] = [];
    const items = [
      {
        id: 1,
        origin_id: 'origin-1',
        connection_id: null,
        feed_id: 7,
        attachments: [
          { artifact_id: 'revoked', download_url: 'https://expired.example.test' },
          { artifact_id: 42, download_url: 'https://expired.example.test' },
        ],
      },
      // No `origin_id` means no binding can be derived, so the whole item is
      // left untouched rather than silently stripped.
      {
        id: 2,
        origin_id: '',
        attachments: [
          { artifact_id: 'orphan', download_url: 'https://expired.example.test' },
        ],
      },
    ] as unknown as ContentItem[];

    await refreshEventArtifactDownloadUrls({
      items,
      organizationId: 'org-1',
      publicGatewayUrl: 'https://gateway.example.test',
      artifactStore: {
        mintBoundDownloadUrl: async ({ artifactId, binding }) => {
          seen.push(`${binding}|${artifactId}`);
          return null;
        },
      },
    });

    expect(seen).toEqual(['event:org-1:feed:7:origin-1|revoked']);
    expect(items[0].attachments).toEqual([
      { artifact_id: 'revoked' },
      { artifact_id: 42, download_url: 'https://expired.example.test' },
    ]);
    expect(items[1].attachments).toEqual([
      { artifact_id: 'orphan', download_url: 'https://expired.example.test' },
    ]);
  });
});
