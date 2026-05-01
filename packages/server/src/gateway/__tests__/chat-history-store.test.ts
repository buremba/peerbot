import { describe, expect, test } from "bun:test";
import {
  ConversationStateStore,
  HISTORY_TTL_MS,
  MAX_HISTORY_MESSAGES,
  historyIndexKey,
} from "../connections/conversation-state-store.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";

function freshStore() {
  const state = new InMemoryStateAdapter();
  const store = new ConversationStateStore(state);
  return { state, store };
}

describe("ConversationStateStore history", () => {
  test("append + getHistory round-trips in user→assistant order", async () => {
    const { store } = freshStore();
    await store.appendHistory("conn-1", "C123", {
      role: "user",
      content: "hi",
      authorName: "Alice",
      timestamp: 1,
    });
    await store.appendHistory("conn-1", "C123", {
      role: "assistant",
      content: "hello",
      timestamp: 2,
    });

    const history = await store.getHistory("conn-1", "C123");
    expect(history).toEqual([
      { role: "user", content: "hi", name: "Alice" },
      { role: "assistant", content: "hello", name: undefined },
    ]);
  });

  test("getEntries preserves timestamps for admin transcript views", async () => {
    const { store } = freshStore();
    await store.appendHistory("conn-1", "C123", {
      role: "user",
      content: "q",
      timestamp: 1700000000000,
    });
    const entries = await store.getEntries("conn-1", "C123");
    expect(entries[0]?.timestamp).toBe(1700000000000);
  });

  test("appendToList is called with maxLength + ttlMs so sliding window is atomic", async () => {
    const { state, store } = freshStore();
    const spy = {
      calls: [] as Array<{ key: string; value: unknown; opts: unknown }>,
    };
    const original = state.appendToList.bind(state);
    state.appendToList = (async (key: string, value: unknown, opts: any) => {
      spy.calls.push({ key, value, opts });
      return original(key, value, opts);
    }) as any;

    await store.appendHistory("c", "ch", {
      role: "user",
      content: "x",
      timestamp: 1,
    });

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.key).toBe("history:c:ch");
    expect(spy.calls[0]?.opts).toEqual({
      maxLength: MAX_HISTORY_MESSAGES,
      ttlMs: HISTORY_TTL_MS,
    });
  });

  test("getHistory returns only the last MAX_HISTORY_MESSAGES entries", async () => {
    const { state, store } = freshStore();
    const overflow = MAX_HISTORY_MESSAGES + 3;
    for (let i = 0; i < overflow; i++) {
      await state.appendToList("history:c:ch", {
        role: "user",
        content: `msg-${i}`,
        timestamp: i,
      });
    }
    const history = await store.getHistory("c", "ch");
    expect(history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(history[0]?.content).toBe(`msg-${overflow - MAX_HISTORY_MESSAGES}`);
    expect(history.at(-1)?.content).toBe(`msg-${overflow - 1}`);
  });

  test("clearHistory removes the history key", async () => {
    const { state, store } = freshStore();
    await store.appendHistory("c", "ch", {
      role: "user",
      content: "x",
      timestamp: 1,
    });
    await store.clearHistory("c", "ch");
    expect(await store.getHistory("c", "ch")).toEqual([]);
    expect(await state.get(historyIndexKey("c"))).toBeNull();
  });

  test("clearAllHistory removes all indexed history for a connection", async () => {
    const { state, store } = freshStore();
    await store.appendHistory("c", "ch-1", {
      role: "user",
      content: "x",
      timestamp: 1,
    });
    await store.appendHistory("c", "ch-2", {
      role: "assistant",
      content: "y",
      timestamp: 2,
    });

    expect(await store.clearAllHistory("c")).toBe(2);
    expect(await store.getHistory("c", "ch-1")).toEqual([]);
    expect(await store.getHistory("c", "ch-2")).toEqual([]);
    expect(await state.get(historyIndexKey("c"))).toBeNull();
  });

  test("history is scoped per (connection, channel)", async () => {
    const { store } = freshStore();
    await store.appendHistory("A", "ch-1", {
      role: "user",
      content: "a1",
      timestamp: 1,
    });
    await store.appendHistory("B", "ch-1", {
      role: "user",
      content: "b1",
      timestamp: 2,
    });
    await store.appendHistory("A", "ch-2", {
      role: "user",
      content: "a2",
      timestamp: 3,
    });

    expect((await store.getHistory("A", "ch-1"))[0]?.content).toBe("a1");
    expect((await store.getHistory("B", "ch-1"))[0]?.content).toBe("b1");
    expect((await store.getHistory("A", "ch-2"))[0]?.content).toBe("a2");
  });
});
