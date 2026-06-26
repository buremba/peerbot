/**
 * Generic test of the recall-source registry — the ONE abstraction over the two
 * consolidated recall kinds (`knowledge` = events, `conversation` =
 * channel_messages). Uses fake sources so it asserts the registry CONTRACT
 * (merge, failure isolation, empty omission, unique kinds) independent of any
 * one source's behavior. Per-source behavior is covered separately
 * (search-channel-recall.test.ts, search-content-*.test.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  gatherRecall,
  RECALL_SOURCES,
  type RecallContext,
  type RecallSource,
} from '../search';

// Fake sources ignore ctx, so an empty object is a fine stand-in.
const ctx = {} as RecallContext;

const knowledgeHit: RecallSource = {
  kind: 'knowledge',
  // biome-ignore lint/suspicious/noExplicitAny: fixture snippet, shape irrelevant
  recall: async () => ({ content: [{ id: 1 } as any] }),
};
const conversationHit: RecallSource = {
  kind: 'conversation',
  // biome-ignore lint/suspicious/noExplicitAny: fixture snippet, shape irrelevant
  recall: async () => ({ conversation_messages: [{ text: 'hi' } as any] }),
};

describe('recall source registry (generic contract)', () => {
  it('merges the facet contributed by every source', async () => {
    const merged = await gatherRecall(ctx, [knowledgeHit, conversationHit]);
    expect(merged.content).toHaveLength(1);
    expect(merged.conversation_messages).toHaveLength(1);
  });

  it('isolates a failing source — the others still contribute', async () => {
    const boom: RecallSource = {
      kind: 'conversation',
      recall: async () => {
        throw new Error('source blew up');
      },
    };
    const merged = await gatherRecall(ctx, [knowledgeHit, boom]);
    expect(merged.content).toHaveLength(1);
    expect(merged.conversation_messages).toBeUndefined();
  });

  it('omits the facet for a source that returns nothing', async () => {
    const empty: RecallSource = { kind: 'conversation', recall: async () => ({}) };
    const merged = await gatherRecall(ctx, [empty]);
    expect(merged).toEqual({});
  });

  it('every registered source owns a distinct kind', () => {
    const kinds = RECALL_SOURCES.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(RECALL_SOURCES.length).toBeGreaterThanOrEqual(2);
  });
});
