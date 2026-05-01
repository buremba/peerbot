/**
 * Tests for SessionManager and StateAdapterSessionStore.
 * Session state now lives in the shared conversation state layer used by the
 * Chat SDK-backed history store.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  ConversationStateStore,
  sessionKey as stateSessionKey,
  threadIndexKey,
} from "../connections/conversation-state-store.js";
import {
  SessionManager,
  StateAdapterSessionStore,
} from "../services/session-manager.js";
import { computeSessionKey, type ThreadSession } from "../session.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";

function createHarness() {
  const state = new InMemoryStateAdapter();
  const conversations = new ConversationStateStore(state);
  const store = new StateAdapterSessionStore(conversations);
  const manager = new SessionManager(store);
  return { state, conversations, store, manager };
}

describe("SessionManager", () => {
  let state: InMemoryStateAdapter;
  let manager: SessionManager;

  beforeEach(() => {
    const harness = createHarness();
    state = harness.state;
    manager = harness.manager;
  });

  test("creates and retrieves session", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "1234567890.123456",
      threadCreator: "U123",
      status: "pending",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);

    const sessionId = computeSessionKey(session);
    const retrieved = await manager.getSession(sessionId);
    expect(retrieved).toMatchObject({
      userId: "U123",
      channelId: "C123",
      conversationId: "1234567890.123456",
      threadCreator: "U123",
      status: "pending",
    });
  });

  test("deletes both session and thread index", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "1234567890.123456",
      status: "completed",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);
    const sessionId = computeSessionKey(session);
    await manager.deleteSession(sessionId);

    expect(await manager.getSession(sessionId)).toBeNull();
    expect(
      await manager.findSessionByThread("C123", "1234567890.123456")
    ).toBeNull();
  });

  test("finds session by thread index", async () => {
    const session: ThreadSession = {
      channelId: "C789",
      userId: "U789",
      conversationId: "1111111111.111111",
      status: "running",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);

    const found = await manager.findSessionByThread(
      "C789",
      "1111111111.111111"
    );
    expect(found?.userId).toBe("U789");
  });

  test("updates thread ownership checks", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "1234567890.123456",
      threadCreator: "U123",
      status: "running",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);

    await expect(
      manager.validateThreadOwnership("C123", "1234567890.123456", "U123")
    ).resolves.toEqual({ allowed: true, owner: "U123" });

    await expect(
      manager.validateThreadOwnership("C123", "1234567890.123456", "U999")
    ).resolves.toEqual({ allowed: false, owner: "U123" });
  });

  test("touchSession updates lastActivity without dropping other fields", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "activity.123456",
      threadCreator: "U123",
      status: "running",
      createdAt: Date.now(),
      lastActivity: Date.now() - 1_000,
    };

    await manager.setSession(session);
    const sessionId = computeSessionKey(session);
    const before = await manager.getSession(sessionId);
    const beforeActivity = before!.lastActivity;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.touchSession(sessionId);

    const after = await manager.getSession(sessionId);
    expect(after?.lastActivity).toBeGreaterThan(beforeActivity);
    expect(after).toMatchObject({
      channelId: "C123",
      userId: "U123",
      conversationId: "activity.123456",
      status: "running",
    });
  });

  test("createSession stores a session using computed key", async () => {
    const created = await manager.createSession(
      "C123",
      "U123",
      "1234567890.123456",
      "U123"
    );

    const stored = await manager.getSession(computeSessionKey(created));
    expect(stored?.threadCreator).toBe("U123");
  });

  test("cleanupExpired returns 0 because TTL is adapter-managed", async () => {
    await expect(manager.cleanupExpired(3600)).resolves.toBe(0);
  });

  test("stores session and thread index in shared conversation state", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "state.123456",
      status: "pending",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);
    const sessionId = computeSessionKey(session);

    expect(await state.get(stateSessionKey(sessionId))).toEqual(session);
    expect(await state.get(threadIndexKey("C123", "state.123456"))).toEqual({
      sessionKey: sessionId,
    });
  });

  test("handles API sessions where channelId equals conversationId", async () => {
    const agentId = "agent-123";
    const session: ThreadSession = {
      channelId: agentId,
      userId: "U123",
      conversationId: agentId,
      status: "pending",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);

    const sessionId = computeSessionKey(session);
    expect(sessionId).toBe(agentId);
    expect(await manager.getSession(sessionId)).toMatchObject({
      conversationId: agentId,
      channelId: agentId,
    });
  });

  test("handles concurrent updates with last write winning semantics", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "concurrent.123456",
      status: "pending",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    const sessionId = computeSessionKey(session);

    await Promise.all([
      manager.setSession({ ...session, status: "running" }),
      manager.setSession({ ...session, status: "completed" }),
    ]);

    const retrieved = await manager.getSession(sessionId);
    expect(retrieved).not.toBeNull();
    expect(["running", "completed"]).toContain(retrieved?.status);
  });
});
