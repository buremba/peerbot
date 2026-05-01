/**
 * Minimal in-memory StateAdapter for Chat SDK tests.
 * Implements the full StateAdapter interface so a real `Chat` can boot without Redis.
 */
import type { Lock, StateAdapter } from "chat";

export class InMemoryStateAdapter implements StateAdapter {
  private values = new Map<string, { value: unknown; expiresAt?: number }>();
  private lists = new Map<string, unknown[]>();
  private locks = new Map<string, Lock>();
  private subscriptions = new Set<string>();

  private alive(key: string): boolean {
    const entry = this.values.get(key);
    if (!entry) return false;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.values.delete(key);
      return false;
    }
    return true;
  }

  async connect(): Promise<void> {
    // no-op
  }
  async disconnect(): Promise<void> {
    // no-op
  }

  async subscribe(threadId: string): Promise<void> {
    this.subscriptions.add(threadId);
  }
  async unsubscribe(threadId: string): Promise<void> {
    this.subscriptions.delete(threadId);
  }
  async isSubscribed(threadId: string): Promise<boolean> {
    return this.subscriptions.has(threadId);
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const existing = this.locks.get(threadId);
    if (existing && existing.expiresAt > Date.now()) return null;
    const lock: Lock = {
      threadId,
      token: `${threadId}:${Math.random().toString(36).slice(2)}`,
      expiresAt: Date.now() + ttlMs,
    };
    this.locks.set(threadId, lock);
    return lock;
  }
  async releaseLock(lock: Lock): Promise<void> {
    const current = this.locks.get(lock.threadId);
    if (current?.token === lock.token) this.locks.delete(lock.threadId);
  }
  async forceReleaseLock(threadId: string): Promise<void> {
    this.locks.delete(threadId);
  }
  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const current = this.locks.get(lock.threadId);
    if (current?.token !== lock.token) return false;
    current.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    if (!this.alive(key)) return null;
    return this.values.get(key)!.value as T;
  }
  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
    });
  }
  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number
  ): Promise<boolean> {
    if (this.alive(key)) return false;
    await this.set(key, value, ttlMs);
    return true;
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.lists.delete(key);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ): Promise<void> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    if (options?.maxLength && list.length > options.maxLength) {
      list.splice(0, list.length - options.maxLength);
    }
    this.lists.set(key, list);
    if (options?.ttlMs) {
      // TTL on lists is coarse — mirror values map for reaper convenience
      this.values.set(key, {
        value: list,
        expiresAt: Date.now() + options.ttlMs,
      });
    }
  }
  async getList<T = unknown>(key: string): Promise<T[]> {
    return (this.lists.get(key) as T[] | undefined) ?? [];
  }
}
