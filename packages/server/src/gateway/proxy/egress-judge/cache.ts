import type { JudgeVerdict } from "./types.js";

interface Entry {
  verdict: JudgeVerdict;
  expiresAt: number;
  /** Doubly-linked-list touchstamp for LRU eviction. */
  touch: number;
}

/**
 * Small LRU with absolute TTL. Keyed by `(policyHash, request signature)`,
 * so a policy edit invalidates prior verdicts automatically — the hash
 * changes, the cache misses.
 *
 * Scale budget: expected to sit in the low thousands of entries. When the
 * map grows past `maxEntries`, the oldest-touched key is evicted.
 */
export class VerdictCache {
  private entries = new Map<string, Entry>();
  private counter = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  static key(parts: {
    policyHash: string;
    hostname: string;
    method?: string;
    path?: string;
  }): string {
    return [
      parts.policyHash,
      parts.hostname.toLowerCase(),
      parts.method?.toUpperCase() ?? "",
      parts.path ?? "",
    ].join("|");
  }

  get(key: string): JudgeVerdict | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    entry.touch = ++this.counter;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.verdict;
  }

  set(key: string, verdict: JudgeVerdict): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      // Map preserves insertion order; the first key is the oldest touched.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      verdict,
      expiresAt: Date.now() + this.ttlMs,
      touch: ++this.counter,
    });
  }

  /** For tests. */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.counter = 0;
  }
}
