/**
 * Test setup and utilities for Gateway tests
 */

/**
 * Mock Express Response for SSE testing
 */
export class MockResponse {
  private _ended = false;
  private _written: string[] = [];

  write(chunk: string): boolean {
    if (this._ended) {
      throw new Error("Cannot write to ended response");
    }
    this._written.push(chunk);
    return true;
  }

  end(): void {
    this._ended = true;
  }

  isEnded(): boolean {
    return this._ended;
  }

  getWritten(): string[] {
    return this._written;
  }

  getLastWrite(): string | undefined {
    return this._written[this._written.length - 1];
  }

  getAllWrites(): string {
    return this._written.join("");
  }

  clearWrites(): void {
    this._written = [];
  }
}

/**
 * Mock Redis Client for testing
 */
class MockRedisClient {
  private store = new Map<string, { value: string; ttl?: number }>();
  private sets = new Map<string, Set<string>>();
  private lists = new Map<string, string[]>();
  private currentTime = Date.now();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Check TTL expiration
    if (entry.ttl && entry.ttl < this.currentTime) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ? this.currentTime + ttlSeconds * 1000 : undefined;
    this.store.set(key, { value, ttl });
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    const ttl = this.currentTime + ttlSeconds * 1000;
    this.store.set(key, { value, ttl });
  }

  async del(key: string): Promise<number> {
    const existed =
      this.store.has(key) || this.sets.has(key) || this.lists.has(key);
    this.store.delete(key);
    this.sets.delete(key);
    this.lists.delete(key);
    return existed ? 1 : 0;
  }

  // Set operations
  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!this.sets.has(key)) {
      this.sets.set(key, new Set());
    }
    const set = this.sets.get(key)!;
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) {
        removed++;
      }
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }

  // List operations
  async rpush(key: string, ...values: string[]): Promise<number> {
    if (!this.lists.has(key)) {
      this.lists.set(key, []);
    }
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

  async expire(key: string, seconds: number): Promise<number> {
    if (this.store.has(key)) {
      const entry = this.store.get(key)!;
      entry.ttl = this.currentTime + seconds * 1000;
      return 1;
    }
    return 0;
  }

  clear(): void {
    this.store.clear();
    this.sets.clear();
    this.lists.clear();
  }

  // Test helper to advance time
  advanceTime(ms: number): void {
    this.currentTime += ms;
  }

  // Test helper to check store state
  has(key: string): boolean {
    return this.store.has(key);
  }
}

/**
 * Mock Message Queue for testing
 */
export class MockMessageQueue {
  private queues = new Map<string, any[]>();
  private workers = new Map<string, (job: any) => Promise<void>>();
  private redisClient = new MockRedisClient();

  async createQueue(queueName: string): Promise<void> {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
    }
  }

  async work(
    queueName: string,
    handler: (job: any) => Promise<void>
  ): Promise<void> {
    this.workers.set(queueName, handler);
  }

  async addJob(queueName: string, job: any): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} does not exist`);
    }
    queue.push(job);

    // Auto-process if handler is registered
    const handler = this.workers.get(queueName);
    if (handler) {
      await handler(job);
    }
  }

  getRedisClient(): any {
    return this.redisClient;
  }

  // Test helper
  getQueue(queueName: string): any[] | undefined {
    return this.queues.get(queueName);
  }

  // Test helper
  clearQueues(): void {
    this.queues.clear();
    this.workers.clear();
  }
}

/**
 * Test utilities
 */
export class TestHelpers {
  static async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static parseSSE(sse: string): { event: string; data: any }[] {
    const events: { event: string; data: any }[] = [];
    const lines = sse.split("\n");

    let currentEvent = "";
    let currentData = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.substring(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.substring(5).trim();
      } else if (line === "") {
        // Empty line signifies end of event
        if (currentEvent && currentData) {
          try {
            events.push({
              event: currentEvent,
              data: JSON.parse(currentData),
            });
          } catch {
            events.push({
              event: currentEvent,
              data: currentData,
            });
          }
          currentEvent = "";
          currentData = "";
        }
      }
    }

    return events;
  }

  static createMockJob(overrides: any = {}): any {
    return {
      id: `job-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      data: {
        sessionKey: "test-session-key",
        userId: "U123",
        prompt: "test prompt",
        ...overrides,
      },
    };
  }
}

/**
 * Mock environment variables
 */
const mockEnvVars = {
  WORKER_STALE_TIMEOUT_MINUTES: "10",
  PUBLIC_GATEWAY_URL: "https://test-gateway.example.com",
};

// Global test lifecycle helpers
export function setupTestEnv(): void {
  Object.entries(mockEnvVars).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

export function cleanupTestEnv(): void {
  Object.keys(mockEnvVars).forEach((key) => {
    delete process.env[key];
  });
}
