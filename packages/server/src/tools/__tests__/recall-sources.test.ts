/**
 * Generic test of the recall-source registry — the ONE abstraction over the two
 * consolidated recall kinds (`knowledge` = events, `conversation` =
 * channel_messages). Uses fake sources so it asserts the registry CONTRACT
 * (merge, failure isolation, empty omission, unique kinds, GATE forwarding)
 * independent of any one source's behavior. Per-source behavior is covered
 * separately (search-channel-recall.test.ts, search-content-*.test.ts).
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
  // biome-ignore lint/suspicious/noExplicitAny: fixture snippet, shape irrelevant
  read: async () => ({ content: [{ id: 1 } as any] }),
};
const conversationHit: RecallSource = {
  kind: 'conversation',
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
      read: async () => {
        throw new Error('source blew up');
      },
    };
    const merged = await gatherRecall(gate, ctx, [knowledgeHit, boom]);
    expect(merged.content).toHaveLength(1);
    expect(merged.conversation_messages).toBeUndefined();
  });

  it('omits the facet for a source that returns nothing', async () => {
    const empty: RecallSource = { kind: 'conversation', read: async () => ({}) };
    const merged = await gatherRecall(gate, ctx, [empty]);
    expect(merged).toEqual({});
  });

  it('every registered source owns a distinct kind', () => {
    const kinds = RECALL_SOURCES.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(RECALL_SOURCES.length).toBeGreaterThanOrEqual(2);
  });
});

describe('recall gate is a REQUIRED, typed argument (the contract)', () => {
  it('forwards the gate to EVERY registered reader (runtime invariant)', async () => {
    const seen: AuthzScope[] = [];
    const spy1: RecallSource = {
      kind: 'knowledge',
      read: vi.fn(async (g: AuthzScope) => {
        seen.push(g);
        return {};
      }),
    };
    const spy2: RecallSource = {
      kind: 'conversation',
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

  it('the registry type CANNOT hold a reader that omits the gate', () => {
    // A reader on the OLD `recall(ctx)` shape (no gate) is structurally
    // incompatible with FeedReader<RecallContext, …> — the compiler rejects it.
    // @ts-expect-error — `read` MUST accept the AuthzScope gate as its first arg.
    const leaky: RecallSource = {
      kind: 'knowledge',
      recall: async (_ctx: RecallContext) => ({}),
    };
    // Sanity: a correctly-typed reader IS assignable.
    const ok: FeedReader<RecallContext, Record<string, never>> = {
      kind: 'knowledge',
      read: async (_gate: AuthzScope, _ctx: RecallContext) => ({}),
    };
    expect(leaky.kind).toBe('knowledge');
    expect(ok.kind).toBe('knowledge');
  });
  // NOTE: that a reader DENIES a non-member is NOT asserted here — a fake source
  // proves nothing about production enforcement. The real fail-closed regression
  // runs `gatherRecall` against the production `conversationSource` over a seeded
  // ACL graph in
  // __tests__/integration/authz/slack-channel-visibility.test.ts.
});
