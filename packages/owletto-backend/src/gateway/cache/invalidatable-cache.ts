/**
 * InvalidatableCache — read-through cache with PostgreSQL `LISTEN/NOTIFY`-driven
 * invalidation.
 *
 * Use when:
 * - You read the same row(s) frequently on a hot path (e.g. dispatch).
 * - The row's writers are willing to call `pg_notify(<channel>, <key>)`.
 * - There's only a handful of channels (~3-5) — one per cached table is fine.
 *   Per-row channels would explode the postmaster's notification table; this
 *   primitive is NOT designed for that.
 *
 * Semantics:
 * - `get(key)` reads through to `loader(key)` on miss, caches the result, and
 *   returns it. Subsequent calls return the cached value until either (a) the
 *   `ttlMs` expires or (b) a `NOTIFY` arrives whose payload matches the key.
 * - On `NOTIFY` with payload `*` or empty payload, the entire cache is cleared
 *   (operators should treat this as a sledgehammer; prefer per-key payloads).
 * - On underlying connection drop, ALL cached entries are dropped on
 *   reconnect — we cannot guarantee no NOTIFY was missed during the gap.
 *   Note: PG LISTEN/NOTIFY is not durable. NOTIFYs sent during a reconnect
 *   gap are gone; the TTL is the only backstop. Set ttlMs to a value you're
 *   willing to be stale for in the worst case.
 * - In-flight loaders are coalesced: concurrent `get(key)` calls that miss
 *   will share the same loader Promise.
 * - Loads that race a NOTIFY for the same key are NOT cached, so a stale
 *   row never silently lands in the cache after the writer's invalidation.
 *
 * Connection ownership:
 * - This class does NOT open its own pg connection. It calls
 *   `getRawDb().listen(channel, fn)` (postgres-js), which lazily constructs
 *   one shared LISTEN connection per process and multiplexes every channel
 *   subscription across all cache instances onto that single socket.
 * - Reconnect/backoff is handled inside postgres-js. We bump our generation
 *   counter via the `onlisten` callback so any cached entries from before
 *   the reconnect are treated as stale.
 */

import { createLogger, type Logger } from "@lobu/core";
import { getDbListener } from "../../db/client.js";

interface Entry<V> {
  value: V;
  expiresAt: number;
  /** Generation counter of the listener at the time this entry was loaded. */
  generation: number;
  /** Snapshot of `globalEpoch` when the entry was put. Bumped on `*`/`""`
   *  NOTIFYs so a load that started before such a NOTIFY isn't cached. */
  globalEpoch: number;
  /** Snapshot of the per-key epoch when the entry was put. Bumped on every
   *  per-key NOTIFY for that key so a load that started before the NOTIFY
   *  isn't cached. */
  keyEpoch: number;
}

/** Test seam for the LISTEN subscription. Production passes `getRawDb().listen`
 *  via the default. Tests inject a deterministic stub.
 *
 *  - `onNotify` is called for each notification payload (string).
 *  - `onListen` is called once per successful LISTEN — first time on initial
 *    connect, again after every reconnect. The cache uses this to bump its
 *    generation and drop any state that may have crossed a missed-NOTIFY gap.
 *  - The returned `unlisten()` is awaited on `close()`. */
export type ListenSubscriber = (
  channel: string,
  onNotify: (payload: string) => void,
  onListen: () => void,
) => Promise<{ unlisten: () => Promise<unknown> }>;

export interface InvalidatableCacheOptions<K, V> {
  /** PostgreSQL NOTIFY channel name. Must be a plain SQL identifier
   *  (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`). */
  channel: string;
  /** Hard TTL after which an entry is considered stale and reloaded. */
  ttlMs: number;
  /** Optional LRU cap. Default 1000. */
  maxEntries?: number;
  /** Loader called on cache miss. Should NOT throw for normal "row missing"
   *  cases — return `null` / a sentinel and let the caller decide. */
  loader: (key: K) => Promise<V>;
  /** Map keys to a string for use in the cache map and matching against the
   *  NOTIFY payload. Default: `String(k)`. */
  keyToString?: (key: K) => string;
  /** Logger. Defaults to `createLogger("invalidatable-cache:<channel>")`. */
  logger?: Logger;
  /** Test seam: override how the cache subscribes to NOTIFY. Production
   *  defaults to `getRawDb().listen`. */
  listenSubscriber?: ListenSubscriber;
}

export class InvalidatableCache<K, V> {
  private entries = new Map<string, Entry<V>>();
  /** In-flight loaders, keyed by stringified key. Used to coalesce concurrent
   *  cache misses for the same key. */
  private inflight = new Map<string, Promise<V>>();
  /** Bumped on reconnect. Old generation entries are treated as expired. */
  private generation = 0;
  /** Bumped on every `*`/`""` NOTIFY (and on reconnect). Used to invalidate
   *  loads that started before a global invalidation. */
  private globalEpoch = 0;
  /** Per-key counter, bumped on every per-key NOTIFY. Loads that started
   *  before the bump must not be cached. */
  private keyEpochs = new Map<string, number>();
  /** Active subscription handle. Set after the initial LISTEN succeeds. */
  private subscription: { unlisten: () => Promise<unknown> } | null = null;
  /** Tracks whether we've ever successfully listened. Used to distinguish
   *  the first `onListen` (initial subscribe) from subsequent ones (reconnect). */
  private hasListenedAtLeastOnce = false;
  private connectPromise: Promise<void> | null = null;
  private closed = false;
  private readonly logger: Logger;
  private readonly maxEntries: number;
  private readonly keyToString: (key: K) => string;
  private readonly subscribe: ListenSubscriber;

  constructor(private readonly opts: InvalidatableCacheOptions<K, V>) {
    quoteIdent(opts.channel); // validate channel name early
    this.logger =
      opts.logger ?? createLogger(`invalidatable-cache:${opts.channel}`);
    this.maxEntries = opts.maxEntries ?? 1000;
    this.keyToString = opts.keyToString ?? ((k) => String(k));
    this.subscribe = opts.listenSubscriber ?? defaultListenSubscriber;
  }

  /**
   * Read-through. Returns the cached value if fresh, otherwise calls
   * `loader(key)`, caches the result, and returns it.
   *
   * Concurrent misses for the same key share a single loader Promise.
   *
   * If a NOTIFY for this key (or a global invalidate) lands while the loader
   * is in flight, the eventual value is returned to callers but NOT cached —
   * the next read triggers a fresh load.
   */
  async get(key: K): Promise<V> {
    if (this.closed) {
      throw new Error("InvalidatableCache: closed");
    }
    await this.ensureListening();

    const k = this.keyToString(key);
    const now = Date.now();
    const cached = this.entries.get(k);
    if (
      cached &&
      cached.expiresAt > now &&
      cached.generation === this.generation &&
      cached.globalEpoch === this.globalEpoch &&
      cached.keyEpoch === (this.keyEpochs.get(k) ?? 0)
    ) {
      // Touch for LRU.
      this.entries.delete(k);
      this.entries.set(k, cached);
      return cached.value;
    }

    const inflight = this.inflight.get(k);
    if (inflight) {
      return inflight;
    }

    // Snapshot all three counters before kicking off the loader. If ANY of
    // them have changed by the time we go to put(), it means a NOTIFY (or
    // reconnect) landed mid-load and we MUST discard the result.
    const startGen = this.generation;
    const startGlobalEpoch = this.globalEpoch;
    const startKeyEpoch = this.keyEpochs.get(k) ?? 0;

    const promise = (async () => {
      const value = await this.opts.loader(key);
      if (this.closed) return value;
      const cur = this.keyEpochs.get(k) ?? 0;
      if (
        startGen === this.generation &&
        startGlobalEpoch === this.globalEpoch &&
        startKeyEpoch === cur
      ) {
        this.put(k, value, this.generation, this.globalEpoch, cur);
      }
      return value;
    })().finally(() => {
      // Only clear our own inflight entry. handleNotification may have
      // already deleted it (and a fresh load may have replaced it) — in
      // that case leave the new entry alone.
      if (this.inflight.get(k) === promise) {
        this.inflight.delete(k);
      }
    });

    this.inflight.set(k, promise);
    return promise;
  }

  /** Drop a single key from the cache. Does NOT call NOTIFY — callers that
   *  want other gateway processes to invalidate must call `pg_notify` directly. */
  invalidate(key: K): void {
    const k = this.keyToString(key);
    this.entries.delete(k);
    this.keyEpochs.set(k, (this.keyEpochs.get(k) ?? 0) + 1);
  }

  /** Drop the entire cache. Does NOT call NOTIFY. */
  invalidateAll(): void {
    this.entries.clear();
    this.globalEpoch += 1;
  }

  /** Returns the current cache size (test/diagnostic only). */
  size(): number {
    return this.entries.size;
  }

  /** Returns the current generation counter (test/diagnostic only).
   *  Bumped on every reconnect. */
  getGeneration(): number {
    return this.generation;
  }

  /** Tear down the listener and clear local state. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    this.entries.clear();
    this.inflight.clear();
    this.keyEpochs.clear();
    const sub = this.subscription;
    this.subscription = null;
    if (sub) {
      try {
        await sub.unlisten();
      } catch {
        // best effort
      }
    }
  }

  /** Test-only: simulate a reconnect (drop everything, bump generation). */
  _forceReconnectForTest(): void {
    this.handleReListen();
  }

  /** Test-only: synchronously deliver a NOTIFY payload. */
  _notifyForTest(payload: string): void {
    this.handleNotification(payload);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private put(
    key: string,
    value: V,
    generation: number,
    globalEpoch: number,
    keyEpoch: number,
  ): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.opts.ttlMs,
      generation,
      globalEpoch,
      keyEpoch,
    });
  }

  /** Lazily start the LISTEN subscription on first `get()`. */
  private async ensureListening(): Promise<void> {
    if (this.subscription || this.closed) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    this.connectPromise = this.connectAndListen().finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  private async connectAndListen(): Promise<void> {
    if (this.closed) return;
    if (this.subscription) return;

    const sub = await this.subscribe(
      this.opts.channel,
      (payload) => this.handleNotification(payload),
      () => this.handleReListen(),
    );

    if (this.closed) {
      try {
        await sub.unlisten();
      } catch {
        // ignore
      }
      return;
    }
    this.subscription = sub;
    this.logger.debug(
      { channel: this.opts.channel },
      "InvalidatableCache: listening",
    );
  }

  private handleNotification(payload: string): void {
    if (payload === "" || payload === "*") {
      this.entries.clear();
      this.globalEpoch += 1;
      // Drop every in-flight loader so any caller that joined before the
      // NOTIFY can't be served the pre-NOTIFY value coalesced from a stale
      // load. Already-running loaders complete normally (we cannot revoke
      // the Promise) but the eventual put() epoch check refuses to cache.
      this.inflight.clear();
      return;
    }
    this.entries.delete(payload);
    this.keyEpochs.set(payload, (this.keyEpochs.get(payload) ?? 0) + 1);
    // Same reasoning as the global branch: drop the per-key in-flight so a
    // late-arriving caller for `payload` triggers a fresh load instead of
    // joining a loader that started before the invalidation.
    this.inflight.delete(payload);
  }

  /**
   * Called on every successful LISTEN: once on initial subscribe, then on
   * every reconnect. The first call is a no-op (we just started up); every
   * subsequent call means the underlying socket dropped and re-established,
   * during which we may have missed NOTIFYs — invalidate everything.
   */
  private handleReListen(): void {
    if (this.closed) return;
    if (!this.hasListenedAtLeastOnce) {
      this.hasListenedAtLeastOnce = true;
      return;
    }
    this.logger.warn(
      { channel: this.opts.channel },
      "InvalidatableCache: re-listened after reconnect, dropping cached entries",
    );
    this.generation += 1;
    this.globalEpoch += 1;
    this.entries.clear();
  }
}

const defaultListenSubscriber: ListenSubscriber = async (
  channel,
  onNotify,
  onListen,
) => {
  // postgres-js's listen(channel, onnotify, onlisten?) returns
  // { state, unlisten }. onlisten fires on first subscribe + every reconnect
  // (see node_modules/postgres/src/index.js — onclose handler re-invokes
  // listen() for every channel).
  const result = await getDbListener().listen(
    channel,
    (x) => onNotify(typeof x === "string" ? x : ""),
    () => onListen(),
  );
  return { unlisten: result.unlisten };
};

/**
 * Quote a Postgres identifier for use in `LISTEN`. Refuses anything that
 * isn't a plain SQL identifier so the operator never has to think about
 * quoting, escaping, or injection. Kept exported (via the constructor's
 * up-front call) so misconfigured channel names fail at construction.
 */
function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new Error("Channel name cannot be empty");
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Channel name must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (got: ${name})`,
    );
  }
  return `"${name}"`;
}
