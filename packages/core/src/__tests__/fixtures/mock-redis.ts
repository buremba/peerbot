/**
 * Unified in-memory Redis mock for testing.
 *
 * Replaces three duplicated implementations:
 *   - MockRedisClient in gateway setup.ts
 *   - FakeRedis in system-message-limiter.test.ts
 *   - queue mock getRedisClient
 *
 * Supports string, set, list, and hash operations with TTL tracking.
 */

type SetMode = "NX" | undefined;

export class MockRedisClient {
  private store = new Map<string, { value: string; ttl?: number }>();
  private sets = new Map<string, Set<string>>();
  private lists = new Map<string, string[]>();
  private currentTime = Date.now();

  // --- String operations ---

  async exists(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    if (entry.ttl && entry.ttl < this.currentTime) {
      this.store.delete(key);
      return 0;
    }
    return 1;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.ttl && entry.ttl < this.currentTime) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * ioredis-compatible set with optional EX / NX flags.
   * Supports: set(key, value), set(key, value, "EX", sec), set(key, value, "EX", sec, "NX")
   */
  async set(
    key: string,
    value: string,
    exTokenOrTtl?: "EX" | number,
    exSeconds?: number,
    mode?: SetMode
  ): Promise<"OK" | null> {
    // NX check must be synchronous to avoid TOCTOU race
    if (mode === "NX") {
      const entry = this.store.get(key);
      const alive = entry && (!entry.ttl || entry.ttl >= this.currentTime);
      if (alive) return null;
    }

    let ttl: number | undefined;
    if (exTokenOrTtl === "EX" && typeof exSeconds === "number") {
      ttl = this.currentTime + exSeconds * 1000;
    } else if (typeof exTokenOrTtl === "number") {
      ttl = this.currentTime + exTokenOrTtl * 1000;
    }

    this.store.set(key, { value, ttl });
    return "OK";
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    const ttl = this.currentTime + ttlSeconds * 1000;
    this.store.set(key, { value, ttl });
  }

  async incr(key: string): Promise<number> {
    const current = await this.get(key);
    const nextValue = (current ? Number.parseInt(current, 10) : 0) + 1;
    const entry = this.store.get(key);
    this.store.set(key, {
      value: String(nextValue),
      ttl: entry?.ttl,
    });
    return nextValue;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      const existed =
        this.store.has(key) || this.sets.has(key) || this.lists.has(key);
      this.store.delete(key);
      this.sets.delete(key);
      this.lists.delete(key);
      if (existed) deleted++;
    }
    return deleted;
  }

  async getdel(key: string): Promise<string | null> {
    const value = await this.get(key);
    if (value !== null) {
      await this.del(key);
    }
    return value;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.store.has(key)) {
      const entry = this.store.get(key)!;
      entry.ttl = this.currentTime + seconds * 1000;
      return 1;
    }
    return 0;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (!entry.ttl) return -1;
    if (entry.ttl < this.currentTime) {
      this.store.delete(key);
      return -2;
    }
    return Math.max(0, Math.ceil((entry.ttl - this.currentTime) / 1000));
  }

  // --- Set operations ---

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const set = this.sets.get(key)!;
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }

  async sismember(key: string, member: string): Promise<number> {
    const set = this.sets.get(key);
    return set?.has(member) ? 1 : 0;
  }

  // --- List operations ---

  async rpush(key: string, ...values: string[]): Promise<number> {
    if (!this.lists.has(key)) this.lists.set(key, []);
    const list = this.lists.get(key)!;
    list.push(...values);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key);
    if (!list) return [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  // --- Scan ---

  async scan(
    _cursor: string,
    ...args: (string | number)[]
  ): Promise<[string, string[]]> {
    // Extract pattern from args: "MATCH", pattern, "COUNT", count
    let pattern = "*";
    for (let i = 0; i < args.length - 1; i++) {
      if (String(args[i]).toUpperCase() === "MATCH") {
        pattern = String(args[i + 1]);
        break;
      }
    }

    const allKeys = new Set<string>();
    for (const key of this.store.keys()) allKeys.add(key);
    for (const key of this.sets.keys()) allKeys.add(key);
    for (const key of this.lists.keys()) allKeys.add(key);

    const matching: string[] = [];
    for (const key of allKeys) {
      if (pattern === "*") {
        matching.push(key);
      } else if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        if (key.startsWith(prefix)) matching.push(key);
      } else if (key === pattern) {
        matching.push(key);
      }
    }

    return ["0", matching];
  }

  // --- Batch get ---

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  // --- Watch / Unwatch (no-ops) ---

  async watch(..._keys: string[]): Promise<"OK"> {
    return "OK";
  }

  async unwatch(): Promise<"OK"> {
    return "OK";
  }

  // --- Multi ---

  multi(): {
    set(key: string, value: string): any;
    exec(): Promise<[null, string][]>;
  } {
    const pending: Array<{ key: string; value: string }> = [];
    const self = this;
    const chain = {
      set(key: string, value: string) {
        pending.push({ key, value });
        return chain;
      },
      async exec(): Promise<[null, string][]> {
        const results: [null, string][] = [];
        for (const op of pending) {
          self.store.set(op.key, { value: op.value });
          results.push([null, "OK"]);
        }
        return results;
      },
    };
    return chain;
  }

  // --- Pipeline ---

  pipeline(): {
    setex(key: string, ttl: number, value: string): any;
    del(...keys: string[]): any;
    exec(): Promise<Array<[null, any]>>;
  } {
    const ops: Array<() => Promise<any>> = [];
    const self = this;
    const chain = {
      setex(key: string, ttl: number, value: string) {
        ops.push(() => self.setex(key, ttl, value));
        return chain;
      },
      del(...keys: string[]) {
        ops.push(() => self.del(...keys));
        return chain;
      },
      async exec(): Promise<Array<[null, any]>> {
        const results: Array<[null, any]> = [];
        for (const op of ops) {
          const result = await op();
          results.push([null, result ?? "OK"]);
        }
        return results;
      },
    };
    return chain;
  }

  // --- Test helpers ---

  advanceTime(ms: number): void {
    this.currentTime += ms;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
    this.sets.clear();
    this.lists.clear();
  }
}
