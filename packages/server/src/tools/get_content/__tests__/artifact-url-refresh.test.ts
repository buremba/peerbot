import type { ContentItem } from '@lobu/connector-sdk';
import { describe, expect, test } from 'vitest';
import { refreshEventArtifactDownloadUrls } from '../render';

/** Records what it was asked to sign; never touches a filesystem. */
function recordingStore() {
  const calls: Array<{ artifactId: string; binding?: string }> = [];
  return {
    calls,
    buildDownloadUrl: (
      _publicGatewayUrl: string,
      artifactId: string,
      _ttlMs?: number,
      binding?: string
    ) => {
      calls.push({ artifactId, binding });
      return `https://fresh.example.test/${artifactId}?token=t`;
    },
  };
}

describe('refreshEventArtifactDownloadUrls', () => {
  test('re-mints each attachment URL under the event binding', () => {
    const store = recordingStore();
    const items = [
      {
        id: 1,
        origin_id: 'origin-1',
        connection_id: 42,
        feed_id: null,
        attachments: [
          { artifact_id: 'a1', download_url: 'https://expired.example.test' },
          { artifact_id: 'a2', download_url: 'https://expired.example.test' },
        ],
      },
    ] as unknown as ContentItem[];

    refreshEventArtifactDownloadUrls({
      items,
      organizationId: 'org-1',
      publicGatewayUrl: 'https://gateway.example.test',
      artifactStore: store,
    });

    expect(store.calls).toEqual([
      { artifactId: 'a1', binding: 'event:org-1:connection:42:origin-1' },
      { artifactId: 'a2', binding: 'event:org-1:connection:42:origin-1' },
    ]);
    expect(items[0].attachments).toEqual([
      { artifact_id: 'a1', download_url: 'https://fresh.example.test/a1?token=t' },
      { artifact_id: 'a2', download_url: 'https://fresh.example.test/a2?token=t' },
    ]);
  });

  test('falls back to the feed scope when there is no connection', () => {
    const store = recordingStore();
    const items = [
      {
        id: 1,
        origin_id: 'origin-1',
        connection_id: null,
        feed_id: 7,
        attachments: [{ artifact_id: 'a1', download_url: 'https://expired.example.test' }],
      },
    ] as unknown as ContentItem[];

    refreshEventArtifactDownloadUrls({
      items,
      organizationId: 'org-1',
      publicGatewayUrl: 'https://gateway.example.test',
      artifactStore: store,
    });

    expect(store.calls).toEqual([
      { artifactId: 'a1', binding: 'event:org-1:feed:7:origin-1' },
    ]);
  });

  test('leaves attachments it does not own untouched', () => {
    const store = recordingStore();
    const items = [
      {
        id: 1,
        origin_id: 'origin-1',
        connection_id: 42,
        feed_id: null,
        attachments: [
          // Connector-supplied external link: no artifact_id, not ours to sign.
          { url: 'https://files.slack.example/x.png' },
          // Names an artifact but carries no URL to refresh.
          { artifact_id: 'a1' },
          // Non-string artifact id.
          { artifact_id: 42, download_url: 'https://expired.example.test' },
        ],
      },
      // No origin_id means no binding can be derived; skip the whole item
      // rather than sign something unverifiable.
      {
        id: 2,
        origin_id: '',
        attachments: [{ artifact_id: 'orphan', download_url: 'https://expired.example.test' }],
      },
    ] as unknown as ContentItem[];

    refreshEventArtifactDownloadUrls({
      items,
      organizationId: 'org-1',
      publicGatewayUrl: 'https://gateway.example.test',
      artifactStore: store,
    });

    expect(store.calls).toEqual([]);
    expect(items[0].attachments).toEqual([
      { url: 'https://files.slack.example/x.png' },
      { artifact_id: 'a1' },
      { artifact_id: 42, download_url: 'https://expired.example.test' },
    ]);
    expect(items[1].attachments).toEqual([
      { artifact_id: 'orphan', download_url: 'https://expired.example.test' },
    ]);
  });
});
