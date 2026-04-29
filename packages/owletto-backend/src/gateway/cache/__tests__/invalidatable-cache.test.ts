import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InvalidatableCache,
  type ListenSubscriber,
} from "../invalidatable-cache.js";

/**
 * Test fake for the postgres-js `sql.listen()` seam. Lets each test drive
 * notifications, simulate reconnects (via repeated `onListen` calls), and
 * inspect subscription state.
 *
 * One `FakeListener` per channel is created on first subscribe; subsequent
 * subscribes to the same channel reuse it (matching postgres-js semantics).
 */
class FakeListener {
  readonly channel: string;
  notifyHandlers: Array<(payload: string) => void> = [];
  listenHandlers: Array<() => void> = [];
  unlistened = false;

  constructor(channel: string) {
    this.channel = channel;
  }

  notify(payload: string): void {
    if (this.unlistened) return;
    for (const fn of this.notifyHandlers) fn(payload);
  }

  /** Simulate a reconnect: postgres-js calls `onListen` again after the
   *  internal listener socket re-LISTENs. */
  simulateReListen(): void {
    if (this.unlistened) return;
    for (const fn of this.listenHandlers) fn();
  }
}

let listeners: Map<string, FakeListener>;
let subscribeAttempts: number;
let subscribeFailFirstN: number;

function makeSubscriber(): ListenSubscriber {
  return async (channel, onNotify, onListen) => {
    subscribeAttempts += 1;
    if (subscribeAttempts <= subscribeFailFirstN) {
      throw new Error("could not connect");
    }
    let listener = listeners.get(channel);
    if (!listener) {
      listener = new FakeListener(channel);
      listeners.set(channel, listener);
    }
    listener.notifyHandlers.push(onNotify);
    listener.listenHandlers.push(onListen);
    // Fire onListen once on subscribe — matches postgres-js's behavior of
    // calling the onlisten callback after the LISTEN statement completes.
    queueMicrotask(() => onListen());
    return {
      unlisten: async () => {
        listener!.unlistened = true;
        listener!.notifyHandlers = listener!.notifyHandlers.filter(
          (fn) => fn !== onNotify,
        );
        listener!.listenHandlers = listener!.listenHandlers.filter(
          (fn) => fn !== onListen,
        );
      },
    };
  };
}

beforeEach(() => {
  listeners = new Map();
  subscribeAttempts = 0;
  subscribeFailFirstN = 0;
});

afterEach(async () => {
  // No-op; individual tests own their cache lifecycle.
});

describe("InvalidatableCache", () => {
  test("loader is called once on miss; cached on subsequent hits", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "test_channel",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async (k) => {
        calls += 1;
        return k.length;
      },
    });

    expect(await cache.get("hello")).toBe(5);
    expect(await cache.get("hello")).toBe(5);
    expect(await cache.get("hello")).toBe(5);
    expect(calls).toBe(1);
    expect(subscribeAttempts).toBe(1);
    expect(listeners.get("test_channel")).toBeDefined();
    await cache.close();
  });

  test("concurrent misses for the same key share a single loader call", async () => {
    let calls = 0;
    let resolveLoader: ((v: number) => void) | null = null;
    const loaderPromise = new Promise<number>((res) => {
      resolveLoader = res;
    });

    const cache = new InvalidatableCache<string, number>({
      channel: "concurrent_test",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => {
        calls += 1;
        return loaderPromise;
      },
    });

    const a = cache.get("k");
    const b = cache.get("k");
    const c = cache.get("k");
    resolveLoader?.(42);
    const [va, vb, vc] = await Promise.all([a, b, c]);
    expect(va).toBe(42);
    expect(vb).toBe(42);
    expect(vc).toBe(42);
    expect(calls).toBe(1);
    await cache.close();
  });

  test("TTL expiry forces a reload", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "ttl_test",
      ttlMs: 1, // 1ms TTL
      listenSubscriber: makeSubscriber(),
      loader: async () => {
        calls += 1;
        return calls;
      },
    });

    expect(await cache.get("k")).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.get("k")).toBe(2);
    expect(calls).toBe(2);
    await cache.close();
  });

  test("NOTIFY for a specific key invalidates only that key", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "notify_key",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => ++calls,
    });

    await cache.get("a");
    await cache.get("b");
    expect(cache.size()).toBe(2);
    expect(calls).toBe(2);

    listeners.get("notify_key")?.notify("a");
    expect(cache.size()).toBe(1);

    await cache.get("a");
    expect(calls).toBe(3); // a was reloaded
    await cache.get("b");
    expect(calls).toBe(3); // b stayed cached
    await cache.close();
  });

  test("NOTIFY with empty payload clears the entire cache", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "notify_all",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => 1,
    });

    await cache.get("a");
    await cache.get("b");
    await cache.get("c");
    expect(cache.size()).toBe(3);

    listeners.get("notify_all")?.notify("");
    expect(cache.size()).toBe(0);

    listeners.get("notify_all")?.notify("a"); // no-op on empty cache
    expect(cache.size()).toBe(0);
    await cache.close();
  });

  test("NOTIFY with '*' payload clears the entire cache", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "notify_star",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => 1,
    });

    await cache.get("a");
    await cache.get("b");
    expect(cache.size()).toBe(2);
    listeners.get("notify_star")?.notify("*");
    expect(cache.size()).toBe(0);
    await cache.close();
  });

  test("invalidate(key) drops a single entry", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "invalidate_one",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => ++calls,
    });

    await cache.get("a");
    cache.invalidate("a");
    await cache.get("a");
    expect(calls).toBe(2);
    await cache.close();
  });

  test("invalidateAll() drops the whole cache", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "invalidate_all",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => 1,
    });

    await cache.get("a");
    await cache.get("b");
    expect(cache.size()).toBe(2);
    cache.invalidateAll();
    expect(cache.size()).toBe(0);
    await cache.close();
  });

  test("LRU evicts the oldest entry past maxEntries", async () => {
    let counter = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "lru_test",
      ttlMs: 60_000,
      maxEntries: 2,
      listenSubscriber: makeSubscriber(),
      loader: async () => ++counter,
    });

    await cache.get("a"); // 1
    await cache.get("b"); // 2
    await cache.get("c"); // 3 → evicts a
    expect(cache.size()).toBe(2);

    // a should now be reloaded; b should be evicted (older than c)
    await cache.get("a"); // reloads → 4, evicts b
    expect(counter).toBe(4);

    await cache.get("c"); // still cached → no new call
    expect(counter).toBe(4);

    // b was evicted in the previous step → reloads
    await cache.get("b"); // 5
    expect(counter).toBe(5);
    await cache.close();
  });

  test("re-listen (postgres-js reconnect) bumps generation and clears the cache", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "reconnect_test",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async (k) => k.length,
    });

    await cache.get("hi");
    // Drain the queueMicrotask onlisten so the "first listen" flag is set.
    await Promise.resolve();
    expect(cache.size()).toBe(1);
    expect(cache.getGeneration()).toBe(0);

    // Postgres-js fires onListen again after a reconnect. The cache must
    // treat that as "we may have missed NOTIFYs" and invalidate.
    listeners.get("reconnect_test")?.simulateReListen();

    expect(cache.size()).toBe(0);
    expect(cache.getGeneration()).toBe(1);

    // After re-listen, get() should reload.
    await cache.get("hi");
    expect(cache.size()).toBe(1);
    await cache.close();
  });

  test("close() prevents further get() calls", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "close_test",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => 1,
    });

    await cache.get("a");
    await cache.close();
    await expect(cache.get("a")).rejects.toThrow(/closed/);
  });

  test("rejects channel names with invalid characters", () => {
    expect(
      () =>
        new InvalidatableCache({
          channel: "has-dashes",
          ttlMs: 1,
          loader: async () => 1,
        }),
    ).toThrow(/match/);

    expect(
      () =>
        new InvalidatableCache({
          channel: 'has"quote',
          ttlMs: 1,
          loader: async () => 1,
        }),
    ).toThrow(/match/);

    expect(
      () =>
        new InvalidatableCache({
          channel: "",
          ttlMs: 1,
          loader: async () => 1,
        }),
    ).toThrow(/empty/);
  });

  test("loader rejection does not poison the cache", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "loader_reject",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return 7;
      },
    });

    await expect(cache.get("k")).rejects.toThrow("boom");
    // Subsequent call should retry the loader.
    expect(await cache.get("k")).toBe(7);
    expect(calls).toBe(2);
    await cache.close();
  });

  test("NOTIFY for the loaded key during in-flight load discards the result", async () => {
    let calls = 0;
    let resolveLoad: ((v: number) => void) | null = null;
    const cache = new InvalidatableCache<string, number>({
      channel: "race_key",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<number>((res) => {
            resolveLoad = res;
          });
        }
        return calls;
      },
    });

    const first = cache.get("k");
    // Wait one tick so the loader is in flight.
    await new Promise((r) => setTimeout(r, 1));
    // Writer's NOTIFY arrives mid-load.
    cache._notifyForTest("k");
    // Loader resolves with stale data.
    resolveLoad?.(1);
    expect(await first).toBe(1);

    // Stale value MUST NOT be cached — next read reloads.
    expect(cache.size()).toBe(0);
    expect(await cache.get("k")).toBe(2);
    expect(calls).toBe(2);
    await cache.close();
  });

  test("NOTIFY '*' during in-flight load discards the result", async () => {
    let calls = 0;
    let resolveLoad: ((v: number) => void) | null = null;
    const cache = new InvalidatableCache<string, number>({
      channel: "race_global",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<number>((res) => {
            resolveLoad = res;
          });
        }
        return calls;
      },
    });

    const first = cache.get("k");
    await new Promise((r) => setTimeout(r, 1));
    cache._notifyForTest("*");
    resolveLoad?.(1);
    expect(await first).toBe(1);
    expect(cache.size()).toBe(0);

    expect(await cache.get("k")).toBe(2);
    await cache.close();
  });

  test("subscribe failure rejects the get() and allows retry", async () => {
    subscribeFailFirstN = 1;
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "subscribe_fails_first",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      loader: async () => ++calls,
    });

    await expect(cache.get("a")).rejects.toThrow(/could not connect/);
    // Second attempt succeeds.
    expect(await cache.get("a")).toBe(1);
    expect(subscribeAttempts).toBe(2);
    await cache.close();
  });

  test("close() before subscribe completes leaves no dangling subscription", async () => {
    let resolveSubscribe: (() => void) | null = null;
    const slowSubscriber: ListenSubscriber = async (
      _channel,
      _onNotify,
      _onListen,
    ) => {
      await new Promise<void>((res) => {
        resolveSubscribe = res;
      });
      return { unlisten: async () => {} };
    };

    const cache = new InvalidatableCache<string, number>({
      channel: "close_before_subscribe",
      ttlMs: 60_000,
      listenSubscriber: slowSubscriber,
      loader: async () => 1,
    });

    const pending = cache.get("a");
    // Allow ensureListening to enter the subscriber.
    await new Promise((r) => setTimeout(r, 1));
    await cache.close();
    resolveSubscribe?.();
    await expect(pending).resolves.toBe(1);
    // close() is idempotent and didn't throw.
  });

  test("keyToString controls the cache key", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<{ id: string }, number>({
      channel: "key_to_string",
      ttlMs: 60_000,
      listenSubscriber: makeSubscriber(),
      keyToString: (k) => k.id,
      loader: async () => ++calls,
    });

    await cache.get({ id: "abc" });
    await cache.get({ id: "abc" }); // same id, different object
    expect(calls).toBe(1);

    cache._notifyForTest("abc");
    await cache.get({ id: "abc" });
    expect(calls).toBe(2);
    await cache.close();
  });
});
