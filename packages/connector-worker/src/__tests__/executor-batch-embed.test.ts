/**
 * Finding #12 reproducer: the sync embedding path must batch a whole event
 * chunk into ONE embedding call (one HTTP round-trip / vectorized pass), not
 * one call per event, while still mapping each vector back to its source event.
 *
 * Strategy: mock `executeCompiledConnector` to invoke `onEventChunk` with a
 * 3-event chunk, mock `batchGenerateEmbeddings` to return distinguishable
 * vectors, and assert:
 *   - batchGenerateEmbeddings was called exactly ONCE (not 3x),
 *   - it received all 3 chunk texts in one call,
 *   - each streamed ContentItem carries the vector for its own text + the model
 *     stamp,
 *   - an event with empty text gets no embedding (per-event association held).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: test seam — module mocks need loose types
type AnyFn = (...args: any[]) => any;

// Return a vector derived from the text so we can assert per-event mapping.
const batchGenerateEmbeddingsMock = mock<AnyFn>(async (texts: string[]) => ({
  embeddings: texts.map((t) => [t.length, 0, 0]),
  model: 'stub-model-v1',
}));

let capturedHooks: { onEventChunk: (events: unknown[]) => Promise<void> } | undefined;

const executeCompiledConnectorMock = mock<AnyFn>(async (args: { hooks: typeof capturedHooks }) => {
  capturedHooks = args.hooks;
  return { mode: 'sync', checkpoint: null };
});

mock.module('../executor/runtime.js', () => ({
  executeCompiledConnector: executeCompiledConnectorMock,
}));

mock.module('../embeddings.js', () => ({
  batchGenerateEmbeddings: batchGenerateEmbeddingsMock,
  generateEmbedding: async () => [0, 0, 0],
}));

mock.module('../compile-connector.js', () => ({
  compileConnectorFromFile: async () => 'compiled-code',
  findBundledConnectorFile: () => '/fake/path',
}));

mock.module('../executor/subprocess.js', () => ({
  SubprocessExecutor: class {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    constructor(_opts: any) {}
  },
}));

import type { ContentItem } from '../daemon/client.js';
import { executeRun } from '../daemon/executor.js';

function makeStubClient() {
  const streamed: ContentItem[] = [];
  const client = {
    id: 'test-worker',
    version: 'test',
    streamed,
    async heartbeat() {},
    async stream(batch: { items: ContentItem[] }) {
      streamed.push(...batch.items);
    },
    async complete() {},
    async completeAction() {},
    async completeEmbeddings() {},
    async completeAuth() {},
    async emitAuthArtifact() {},
    async pollAuthSignal() {
      return { signal: null };
    },
    async fetchEventsForEmbedding() {
      return [];
    },
  };
  return client;
}

describe('sync embedding path batches per chunk (Finding #12)', () => {
  beforeEach(() => {
    capturedHooks = undefined;
    executeCompiledConnectorMock.mockClear();
    batchGenerateEmbeddingsMock.mockClear();
  });

  afterEach(() => {
    batchGenerateEmbeddingsMock.mockClear();
  });

  test('one chunk of N events triggers exactly one batch call with all texts mapped back', async () => {
    const client = makeStubClient();

    executeCompiledConnectorMock.mockImplementationOnce(async (args: { hooks: typeof capturedHooks }) => {
      capturedHooks = args.hooks;
      // One chunk, three events. The third has empty text (no embeddable
      // content) — it must still stream through, just without a vector.
      await capturedHooks!.onEventChunk([
        { origin_id: 'a', payload_text: 'aa', occurred_at: new Date(), origin_type: 'post' },
        { origin_id: 'b', payload_text: 'bbbb', occurred_at: new Date(), origin_type: 'post' },
        { origin_id: 'c', payload_text: '', title: '', occurred_at: new Date(), origin_type: 'post' },
      ]);
      return { mode: 'sync', checkpoint: null };
    });

    const job = {
      run_id: 500,
      run_type: 'sync',
      connector_key: 'fake',
      feed_key: 'feed',
      compiled_code: 'compiled-code',
      // biome-ignore lint/suspicious/noExplicitAny: minimal job shape
    } as any;

    // batchSize=10 so the chunk does not flush mid-loop; default generateEmbeddings=true.
    // biome-ignore lint/suspicious/noExplicitAny: minimal env
    const result = await executeRun(client as any, job, {} as any, { batchSize: 10 });
    expect(result.error).toBeUndefined();

    // (1) exactly ONE batch call for the whole chunk — not one per event.
    expect(batchGenerateEmbeddingsMock).toHaveBeenCalledTimes(1);

    // (2) the call received only the embeddable texts ('a'+'b'; 'c' is empty).
    const callArgs = batchGenerateEmbeddingsMock.mock.calls[0]![0] as string[];
    expect(callArgs).toEqual(['aa', 'bbbb']);

    // (3) per-event mapping: 'aa' (len 2) and 'bbbb' (len 4) get their own
    //     vectors + the model stamp; the empty event gets no embedding.
    const byId = new Map(client.streamed.map((it) => [it.id, it]));
    expect(byId.get('a')!.embedding).toEqual([2, 0, 0]);
    expect(byId.get('a')!.embedding_model).toBe('stub-model-v1');
    expect(byId.get('b')!.embedding).toEqual([4, 0, 0]);
    expect(byId.get('b')!.embedding_model).toBe('stub-model-v1');
    expect(byId.get('c')!.embedding).toBeUndefined();
    expect(byId.get('c')!.embedding_model).toBeUndefined();
  });
});
