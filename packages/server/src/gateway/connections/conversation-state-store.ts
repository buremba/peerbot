import { createLogger, DEFAULTS } from "@lobu/core";
import type { StateAdapter } from "chat";
import type { ThreadSession } from "../session.js";

const logger = createLogger("conversation-state-store");

interface SessionThreadIndex {
  sessionKey: string;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  authorName?: string;
  timestamp: number;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  name?: string;
}

type HistoryChannelIndex = Record<string, number>;

export const MAX_HISTORY_MESSAGES = 10;
export const HISTORY_TTL_MS = 86_400_000; // 24 hours
const SESSION_TTL_MS = DEFAULTS.SESSION_TTL_MS;
const HISTORY_INDEX_LOCK_TTL_MS = 5_000;

function historyKey(connectionId: string, channelId: string): string {
  return `history:${connectionId}:${channelId}`;
}

export function historyIndexKey(connectionId: string): string {
  return `history_index:${connectionId}`;
}

export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function threadIndexKey(channelId: string, threadTs: string): string {
  return `conversation_index:${channelId}:${threadTs}`;
}

/**
 * Unified conversation-scoped state backed by the Chat SDK StateAdapter.
 * Owns both sliding-window history and thread session metadata so chat
 * state lives behind a single abstraction over the underlying store.
 */
export class ConversationStateStore {
  constructor(private readonly state: StateAdapter) {}

  async getSession(sessionId: string): Promise<ThreadSession | null> {
    return (await this.state.get<ThreadSession>(sessionKey(sessionId))) ?? null;
  }

  async setSession(
    sessionId: string,
    session: ThreadSession,
    ttlMs: number = SESSION_TTL_MS
  ): Promise<void> {
    await Promise.all([
      this.state.set(sessionKey(sessionId), session, ttlMs),
      this.state.set(
        threadIndexKey(session.channelId, session.conversationId),
        { sessionKey: sessionId } satisfies SessionThreadIndex,
        ttlMs
      ),
    ]);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    await this.state.delete(sessionKey(sessionId));

    if (session?.conversationId) {
      await this.state.delete(
        threadIndexKey(session.channelId, session.conversationId)
      );
    }
  }

  async getSessionByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null> {
    const index = await this.state.get<SessionThreadIndex>(
      threadIndexKey(channelId, threadTs)
    );
    if (!index?.sessionKey) {
      return null;
    }
    return this.getSession(index.sessionKey);
  }

  async getHistory(
    connectionId: string,
    channelId: string
  ): Promise<HistoryMessage[]> {
    const entries = await this.getEntries(connectionId, channelId);

    return entries.slice(-MAX_HISTORY_MESSAGES).map((entry) => ({
      role: entry.role,
      content: entry.content,
      name: entry.authorName,
    }));
  }

  async getEntries(
    connectionId: string,
    channelId: string
  ): Promise<HistoryEntry[]> {
    return this.state.getList<HistoryEntry>(
      historyKey(connectionId, channelId)
    );
  }

  async appendHistory(
    connectionId: string,
    channelId: string,
    entry: HistoryEntry
  ): Promise<void> {
    await Promise.all([
      this.trackHistoryChannel(connectionId, channelId),
      this.state.appendToList(historyKey(connectionId, channelId), entry, {
        maxLength: MAX_HISTORY_MESSAGES,
        ttlMs: HISTORY_TTL_MS,
      }),
    ]);
  }

  async clearHistory(connectionId: string, channelId: string): Promise<void> {
    await Promise.all([
      this.state.delete(historyKey(connectionId, channelId)),
      this.removeHistoryChannel(connectionId, channelId),
    ]);
  }

  async hasHistory(connectionId: string, channelId: string): Promise<boolean> {
    const entries = await this.getEntries(connectionId, channelId);
    return entries.length > 0;
  }

  /**
   * Atomic "first time we've seen this thread" marker. Returns true on the
   * first call per (connectionId, threadId) within HISTORY_TTL_MS, false
   * thereafter. Used to ensure thread-history backfill from the platform
   * runs at most once per thread per TTL window, even if multiple events
   * race in.
   *
   * Pair with `releaseThreadBackfill` so a failed backfill (rate limit,
   * transient network error) clears the marker and the next event can
   * retry — otherwise a single failure poisons the thread for 24h.
   */
  async claimThreadBackfill(
    connectionId: string,
    threadId: string
  ): Promise<boolean> {
    return this.state.setIfNotExists(
      this.threadBackfillKey(connectionId, threadId),
      1,
      HISTORY_TTL_MS
    );
  }

  async releaseThreadBackfill(
    connectionId: string,
    threadId: string
  ): Promise<void> {
    await this.state.delete(this.threadBackfillKey(connectionId, threadId));
  }

  private threadBackfillKey(connectionId: string, threadId: string): string {
    return `thread-backfilled:${connectionId}:${threadId}`;
  }

  async listHistoryChannels(connectionId: string): Promise<string[]> {
    const index = await this.state.get<HistoryChannelIndex>(
      historyIndexKey(connectionId)
    );
    if (!index) return [];
    return Object.keys(index);
  }

  async clearAllHistory(connectionId: string): Promise<number> {
    const channels = await this.listHistoryChannels(connectionId);
    await Promise.all([
      ...channels.map((channelId) =>
        this.state.delete(historyKey(connectionId, channelId))
      ),
      this.state.delete(historyIndexKey(connectionId)),
    ]);
    return channels.length;
  }

  private async trackHistoryChannel(
    connectionId: string,
    channelId: string
  ): Promise<void> {
    await this.updateHistoryIndex(connectionId, (index) => {
      index[channelId] = Date.now();
      return index;
    });
  }

  private async removeHistoryChannel(
    connectionId: string,
    channelId: string
  ): Promise<void> {
    await this.updateHistoryIndex(connectionId, (index) => {
      delete index[channelId];
      return index;
    });
  }

  private async updateHistoryIndex(
    connectionId: string,
    update: (index: HistoryChannelIndex) => HistoryChannelIndex
  ): Promise<void> {
    const lockId = `lock:${historyIndexKey(connectionId)}`;
    // Retry briefly if the lock is contended; only fall through to an
    // unlocked write if the state adapter itself is unavailable. Silently
    // dropping to an unlocked path on transient contention is what allowed
    // two concurrent appends to clobber each other's index updates.
    let lock: Awaited<ReturnType<typeof this.state.acquireLock>> = null;
    let lockError: unknown = null;
    for (let attempt = 0; attempt < 3 && !lock; attempt++) {
      try {
        lock = await this.state.acquireLock(lockId, HISTORY_INDEX_LOCK_TTL_MS);
      } catch (error) {
        lockError = error;
        break;
      }
      if (!lock) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    if (!lock) {
      logger.warn(
        { connectionId, error: lockError ? String(lockError) : "contended" },
        "Updating history index without lock — another writer holds it or the state adapter is unavailable"
      );
    }

    try {
      const current =
        (await this.state.get<HistoryChannelIndex>(
          historyIndexKey(connectionId)
        )) ?? {};
      const next = update({ ...current });
      if (Object.keys(next).length === 0) {
        await this.state.delete(historyIndexKey(connectionId));
      } else {
        await this.state.set(
          historyIndexKey(connectionId),
          next,
          HISTORY_TTL_MS
        );
      }
    } finally {
      if (lock) {
        await this.state.releaseLock(lock).catch(() => undefined);
      }
    }
  }
}
