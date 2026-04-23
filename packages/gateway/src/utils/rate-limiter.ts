interface RedisRateLimitStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl?(key: string): Promise<number>;
  del?(key: string): Promise<number>;
}

interface FixedWindowRateLimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
}

interface FixedWindowRateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
}

export class RedisFixedWindowRateLimiter {
  constructor(private readonly redis: RedisRateLimitStore) {}

  async consume(
    options: FixedWindowRateLimitOptions
  ): Promise<FixedWindowRateLimitResult> {
    const count = await this.redis.incr(options.key);
    if (count === 1) {
      await this.redis.expire(options.key, options.windowSeconds);
    }

    const ttlSeconds = await this.getTtlSeconds(
      options.key,
      options.windowSeconds
    );
    return this.buildResult(options, count, ttlSeconds);
  }

  async reset(key: string): Promise<void> {
    if (typeof this.redis.del === "function") {
      await this.redis.del(key);
    }
  }

  private async getTtlSeconds(
    key: string,
    windowSeconds: number
  ): Promise<number> {
    if (typeof this.redis.ttl !== "function") {
      return windowSeconds;
    }

    const ttl = await this.redis.ttl(key);
    if (ttl < 0) {
      return windowSeconds;
    }

    return ttl;
  }

  private buildResult(
    options: FixedWindowRateLimitOptions,
    count: number,
    ttlSeconds: number
  ): FixedWindowRateLimitResult {
    return {
      allowed: count <= options.limit,
      count,
      limit: options.limit,
      remaining: Math.max(0, options.limit - count),
      retryAfterSeconds: Math.max(1, ttlSeconds),
      resetAt: Date.now() + Math.max(1, ttlSeconds) * 1000,
    };
  }
}

export function getClientIp(headers: {
  forwardedFor?: string;
  realIp?: string;
}): string {
  const forwarded = headers.forwardedFor?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) {
    return forwarded;
  }

  const realIp = headers.realIp?.trim().toLowerCase();
  if (realIp) {
    return realIp;
  }

  return "unknown";
}
