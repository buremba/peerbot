/**
 * SseManager — owns per-agent Server-Sent Events fan-out.
 *
 * Extracted from `routes/public/agent.ts` so the route handler doesn't have
 * to track in-memory connection maps, TTL-pruned backlogs, and dead-connection
 * sweeps inline. A single instance is created in `core-services.ts` and
 * injected into the agent route and into any component that broadcasts
 * into SSE streams (API platform, response renderer, unified thread
 * consumer).
 *
 * Behavior notes (preserved exactly from the previous inline implementation):
 *  - Backlog is per-agentId, capped at `BACKLOG_LIMIT` most-recent entries.
 *  - Backlog entries older than `BACKLOG_TTL_MS` are pruned lazily on every
 *    read AND every write.
 *  - `broadcast` writes to every live connection; a connection is treated as
 *    dead when it reports `closed`/`destroyed`/`writableEnded` OR when a
 *    write throws — dead connections are removed silently (no throw, no log).
 *  - Backlog is ALWAYS remembered (even when no connections are attached) so
 *    a late subscriber can replay recent events.
 */

interface SseEvent {
  event: string;
  data: unknown;
  timestamp: number;
}

/**
 * Minimal shape of an SSE stream we can write to. Matches Hono's
 * `streamSSE` controller (the `writeSSE` path) and also falls back to a
 * raw Node-style writable for consumers that attach plain response
 * objects. Kept loose on purpose — SseManager doesn't own the connection
 * lifecycle, it just fans events out.
 */
export interface SseConnection {
  closed?: boolean;
  destroyed?: boolean;
  writableEnded?: boolean;
  writeSSE?(payload: { event: string; data: string }): unknown;
  write?(chunk: string): unknown;
}

export class SseManager {
  private readonly connections = new Map<string, Set<SseConnection>>();
  private readonly backlog = new Map<string, SseEvent[]>();

  constructor(
    private readonly backlogLimit = 100,
    private readonly backlogTtlMs = 2 * 60 * 1000
  ) {}

  /**
   * Append an event to the per-agent backlog and prune expired entries.
   *
   * Called from `broadcast` and is safe to call on its own for callers that
   * want to seed the backlog without an active connection.
   */
  rememberEvent(agentId: string, event: SseEvent): void {
    this.pruneExpired(event.timestamp);
    const existing = this.backlog.get(agentId) || [];
    const next = existing.concat(event).slice(-this.backlogLimit);
    this.backlog.set(agentId, next);
  }

  /**
   * Return the current fresh backlog for an agent. Always prunes expired
   * entries first so callers never observe stale events.
   *
   * The optional `since` timestamp filters entries with `timestamp > since`.
   * Without it, the full retained backlog is returned.
   */
  getRecentEvents(agentId: string, since?: number): SseEvent[] {
    this.pruneExpired();
    const entries = this.backlog.get(agentId) || [];
    if (typeof since === "number") {
      return entries.filter((entry) => entry.timestamp > since);
    }
    return entries;
  }

  /**
   * Remember the event, then write it to every live connection for `agentId`.
   * Dead connections (closed / ended / threw on write) are removed silently.
   * If the agent has no connections, only the backlog is updated.
   */
  broadcast(agentId: string, event: string, data: unknown): void {
    const entry: SseEvent = { event, data, timestamp: Date.now() };
    this.rememberEvent(agentId, entry);

    const connections = this.connections.get(agentId);
    if (!connections || connections.size === 0) return;

    const dead = new Set<SseConnection>();
    for (const res of connections) {
      try {
        if (res.closed || res.destroyed || res.writableEnded) {
          dead.add(res);
          continue;
        }
        if (typeof res.writeSSE === "function") {
          res.writeSSE({ event, data: JSON.stringify(data) });
        } else if (typeof res.write === "function") {
          const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          res.write(message);
        }
      } catch {
        dead.add(res);
      }
    }

    for (const deadRes of dead) {
      connections.delete(deadRes);
    }
    if (connections.size === 0) {
      this.connections.delete(agentId);
    }
  }

  /**
   * Register a live connection for fan-out. Caller is responsible for calling
   * `removeConnection` on disconnect — `broadcast` will also evict connections
   * it detects as dead during a write.
   */
  addConnection(agentId: string, connection: SseConnection): void {
    let set = this.connections.get(agentId);
    if (!set) {
      set = new Set();
      this.connections.set(agentId, set);
    }
    set.add(connection);
  }

  removeConnection(agentId: string, connection: SseConnection): void {
    const set = this.connections.get(agentId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(agentId);
    }
  }

  /**
   * True if `agentId` has at least one live connection registered.
   * Used by status endpoints that expose `hasActiveConnection`.
   */
  hasActiveConnection(agentId: string): boolean {
    const set = this.connections.get(agentId);
    return !!set && set.size > 0;
  }

  /**
   * Snapshot the number of live connections for an agent. Used for
   * per-agent connection-limit checks.
   */
  connectionCount(agentId: string): number {
    return this.connections.get(agentId)?.size ?? 0;
  }

  /** Total number of live connections across all agents. */
  totalConnections(): number {
    let total = 0;
    for (const set of this.connections.values()) total += set.size;
    return total;
  }

  /**
   * Close every connection for `agentId`, emitting a `closed` event with
   * `reason` first (best-effort — write errors are swallowed, matching the
   * previous inline DELETE /agents behavior). Also drops the backlog so a
   * later connection with the same key cannot replay stale completion
   * events from the deleted session.
   */
  closeAgent(agentId: string, reason: string): void {
    const connections = this.connections.get(agentId);
    if (connections) {
      for (const connection of connections) {
        try {
          if (typeof connection.writeSSE === "function") {
            connection.writeSSE({
              event: "closed",
              data: JSON.stringify({ reason }),
            });
          } else if (typeof connection.write === "function") {
            connection.write(
              `event: closed\ndata: ${JSON.stringify({ reason })}\n\n`
            );
          }
          (connection as { close?: () => void }).close?.();
          (connection as { end?: () => void }).end?.();
        } catch {
          // Ignore — connection is already dead.
        }
      }
      this.connections.delete(agentId);
    }
    this.backlog.delete(agentId);
  }

  private pruneExpired(now = Date.now()): void {
    for (const [agentId, entries] of this.backlog.entries()) {
      const fresh = entries.filter(
        (entry) => now - entry.timestamp <= this.backlogTtlMs
      );
      if (fresh.length === 0) {
        this.backlog.delete(agentId);
        continue;
      }
      this.backlog.set(agentId, fresh);
    }
  }
}
