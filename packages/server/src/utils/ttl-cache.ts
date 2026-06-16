/**
 * Simple TTL cache -- avoids repeated DB lookups for rarely-changing data.
 */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();
  constructor(private ttlMs: number) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Return the cached value for `key`, or compute it via `loader`, store it, and
   * return it on a miss. Collapses the get/null-check/set boilerplate at call
   * sites. Per-pod cache (no cross-replica sharing) — identical semantics to a
   * manual get-then-set.
   */
  async getOrSet(key: string, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    this.set(key, value);
    return value;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
