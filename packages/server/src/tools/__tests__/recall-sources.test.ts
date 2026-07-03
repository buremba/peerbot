/**
 * Generic test of the recall-source registry — the ONE abstraction over the
 * consolidated recall kinds (`knowledge` = events, `conversation` =
 * channel_messages, `virtual` = live virtual feeds), realized as the
 * `(source, lens='recall')` row of the FeedReader matrix. Uses fake sources so it
 * asserts the registry CONTRACT (canRead gating, merge, failure isolation, empty
 * omission, unique kinds, GATE forwarding) independent of any one source's
 * behavior. Per-source behavior is covered separately
 * (search-channel-recall.test.ts, search-content-*.test.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AuthzScope } from '../../authz/scope';
import type { FeedReader } from '../../lib/feed-reader';
import {
  gatherRecall,
  RECALL_SOURCES,
  type RecallContext,
  type RecallSource,
} from '../search';

// Fake sources ignore ctx, so an empty object is a fine stand-in.
const ctx = {} as RecallContext;
const gate: AuthzScope = { organizationId: 'org-1', principal: 'user-1', agentId: 'agent-1' };

const knowledgeHit: RecallSource = {
  kind: 'knowledge',
  source: 'collected',
  lens: 'recall',
  canRead: () => true,
  // biome-ignore lint/suspicious/noExplicitAny: fixture snippet, shape irrelevant
  read: async () => ({ content: [{ id: 1 } as any] }),
};
const conversationHit: RecallSource = {
  kind: 'conversation',
  source: 'chat-channel',
  lens: 'recall',
  canRead: () => true,
  // biome-ignore lint/suspicious/noExplicitAny: fixture snippet, shape irrelevant
  read: async () => ({ conversation_messages: [{ text: 'hi' } as any] }),
};

describe('recall source registry (generic contract)', () => {
  it('merges the facet contributed by every source', async () => {
    const merged = await gatherRecall(gate, ctx, [knowledgeHit, conversationHit]);
    expect(merged.content).toHaveLength(1);
    expect(merged.conversation_messages).toHaveLength(1);
  });

  it('isolates a failing source — the others still contribute', async () => {
    const boom: RecallSource = {
      kind: 'conversation',
      source: 'chat-channel',
      lens: 'recall',
      canRead: () => true,
      read: async () => {
        throw new Error('source blew up');
      },
    };
    const merged = await gatherRecall(gate, ctx, [knowledgeHit, boom]);
    expect(merged.content).toHaveLength(1);
    expect(merged.conversation_messages).toBeUndefined();
  });

  it('omits the facet for a source that returns nothing', async () => {
    const empty: RecallSource = {
      kind: 'conversation',
      source: 'chat-channel',
      lens: 'recall',
      canRead: () => true,
      read: async () => ({}),
    };
    const merged = await gatherRecall(gate, ctx, [empty]);
    expect(merged).toEqual({});
  });

  it('isolates a source whose canRead THROWS — the others still contribute', async () => {
    // canRead is part of a reader's surface, so a throwing predicate must be
    // isolated the same way a throwing read is — it must NOT reject the whole
    // gather and wipe every source's facet.
    const throwsInCanRead: RecallSource = {
      kind: 'conversation',
      source: 'chat-channel',
      lens: 'recall',
      canRead: () => {
        throw new Error('canRead blew up');
      },
      read: vi.fn(async () => ({ conversation_messages: [{ text: 'hi' }] as never })),
    };
    const merged = await gatherRecall(gate, ctx, [knowledgeHit, throwsInCanRead]);
    expect(merged.content).toHaveLength(1); // knowledge survived
    expect(merged.conversation_messages).toBeUndefined();
    expect(throwsInCanRead.read).not.toHaveBeenCalled(); // never reached read
  });

  it('skips a source whose canRead returns false — read is never called', async () => {
    const declines: RecallSource = {
      kind: 'virtual',
      source: 'virtual-live-dataset',
      lens: 'recall',
      canRead: () => false,
      read: vi.fn(async () => ({ content: [{ id: 99 }] as never })),
    };
    const merged = await gatherRecall(gate, ctx, [knowledgeHit, declines]);
    // knowledgeHit ran; the declining source contributed nothing and its read
    // was never invoked (branch-free skip, not a wasted call swallowed later).
    expect(merged.content).toHaveLength(1);
    expect(declines.read).not.toHaveBeenCalled();
  });

  it('every registered source owns a distinct kind and the recall lens', () => {
    const kinds = RECALL_SOURCES.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(RECALL_SOURCES.length).toBeGreaterThanOrEqual(2);
    // The registry is the `lens = recall` row of the matrix — every entry agrees.
    expect(RECALL_SOURCES.every((s) => s.lens === 'recall')).toBe(true);
  });

  it('each production source maps its kind to the right source-kind axis value', () => {
    // Pins the kind ↔ source correspondence the code documents (the tuple's
    // `source` is typed as the union, so a wrong pairing would still compile).
    const expected: Record<string, string> = {
      knowledge: 'collected',
      conversation: 'chat-channel',
      virtual: 'virtual-live-dataset',
    };
    for (const s of RECALL_SOURCES) {
      expect(s.source).toBe(expected[s.kind]);
    }
  });
});

describe('recall gate is a REQUIRED, typed argument (the contract)', () => {
  it('forwards the gate to EVERY registered reader (runtime invariant)', async () => {
    const seen: AuthzScope[] = [];
    const spy1: RecallSource = {
      kind: 'knowledge',
      source: 'collected',
      lens: 'recall',
      canRead: () => true,
      read: vi.fn(async (g: AuthzScope) => {
        seen.push(g);
        return {};
      }),
    };
    const spy2: RecallSource = {
      kind: 'conversation',
      source: 'chat-channel',
      lens: 'recall',
      canRead: () => true,
      read: vi.fn(async (g: AuthzScope) => {
        seen.push(g);
        return {};
      }),
    };
    await gatherRecall(gate, ctx, [spy1, spy2]);
    // Both readers ran and BOTH received the exact gate instance — no reader can
    // run without the ACL boundary in hand.
    expect(spy1.read).toHaveBeenCalledWith(gate, ctx);
    expect(spy2.read).toHaveBeenCalledWith(gate, ctx);
    expect(seen).toEqual([gate, gate]);
  });

  it('the registry type CANNOT hold a reader whose read omits the gate', () => {
    // A reader whose `read` takes only ctx (the OLD gate-less shape) is
    // structurally incompatible with FeedReader<…>: RecallContext and AuthzScope
    // are unrelated, so the first-arg mismatch is what the compiler rejects here
    // — NOT a missing property. This pins the exact claim (gate-first signature),
    // so adding fields to the reader shape can't silently satisfy the suppression.
    // @ts-expect-error — `read`'s first arg MUST be the AuthzScope gate, not ctx.
    const leaky: RecallSource = {
      kind: 'knowledge',
      source: 'collected',
      lens: 'recall',
      canRead: () => true,
      read: async (_ctx: RecallContext) => ({}),
    };
    // Sanity: a correctly-typed reader IS assignable.
    const ok: FeedReader<'collected', 'recall', RecallContext, Record<string, never>> = {
      source: 'collected',
      lens: 'recall',
      canRead: () => true,
      read: async (_gate: AuthzScope, _ctx: RecallContext) => ({}),
    };
    expect(leaky.kind).toBe('knowledge');
    expect(ok.source).toBe('collected');
  });
  // NOTE: that a reader DENIES a non-member is NOT asserted here — a fake source
  // proves nothing about production enforcement. The real fail-closed regression
  // runs `gatherRecall` against the production `conversationSource` over a seeded
  // ACL graph in
  // __tests__/integration/authz/slack-channel-visibility.test.ts.
});
