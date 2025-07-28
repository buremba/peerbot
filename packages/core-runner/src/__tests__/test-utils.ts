#!/usr/bin/env bun

/**
 * Test utilities for core-runner package
 */

import type { SessionContext, SessionState, ConversationMessage, GcsConfig } from "../types";

/**
 * Factory for creating mock session contexts
 */
export function createMockSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    platform: "slack",
    userId: "U123456789",
    username: "testuser",
    channelId: "C123456789",
    messageTs: "1234567890.123456",
    threadTs: "1234567890.123456",
    customInstructions: "You are a helpful assistant.",
    ...overrides,
  };
}

/**
 * Factory for creating mock session states
 */
export function createMockSessionState(overrides: Partial<SessionState> = {}): SessionState {
  const now = Date.now();
  return {
    sessionKey: "test-session-key",
    context: createMockSessionContext(),
    conversation: [],
    createdAt: now - 1000,
    lastActivity: now,
    status: "active",
    ...overrides,
  };
}

/**
 * Factory for creating mock conversation messages
 */
export function createMockMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    role: "user",
    content: "Test message",
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Factory for creating mock GCS config
 */
export function createMockGcsConfig(overrides: Partial<GcsConfig> = {}): GcsConfig {
  return {
    bucketName: "test-bucket",
    projectId: "test-project",
    keyFile: "/path/to/test-key.json",
    ...overrides,
  };
}

/**
 * Mock implementations for testing
 */
export const mockImplementations = {
  /**
   * Mock GCS Storage implementation
   */
  gcsStorage: {
    saveSessionState: jest.fn().mockResolvedValue("/mock/path/to/session"),
    loadSessionState: jest.fn().mockResolvedValue(null),
    sessionExists: jest.fn().mockResolvedValue(false),
    deleteSession: jest.fn().mockResolvedValue(undefined),
    listUserSessions: jest.fn().mockResolvedValue([]),
    cleanupOldSessions: jest.fn().mockResolvedValue(0),
  },

  /**
   * Mock child process for Claude execution
   */
  childProcess: {
    spawn: jest.fn(),
    stdout: {
      on: jest.fn(),
      pipe: jest.fn(),
    },
    stderr: {
      on: jest.fn(),
      pipe: jest.fn(),
    },
    on: jest.fn(),
    kill: jest.fn(),
    pid: 12345,
  },
};

/**
 * Helper for creating mock conversations
 */
export function createMockConversation(messageCount: number = 3): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  
  for (let i = 0; i < messageCount; i++) {
    const isUser = i % 2 === 0;
    messages.push({
      role: isUser ? "user" : "assistant",
      content: isUser ? `User message ${i + 1}` : `Assistant response ${i + 1}`,
      timestamp: Date.now() - (messageCount - i) * 1000,
    });
  }
  
  return messages;
}

/**
 * Helper for generating test session keys
 */
export function generateTestSessionKey(prefix: string = "test"): string {
  return `${prefix}-session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Helper for creating progress update mocks
 */
export function createMockProgressUpdate(type: "progress" | "completion" | "error" = "progress") {
  return {
    type,
    message: `Mock ${type} update`,
    timestamp: Date.now(),
  };
}

/**
 * Test timeout utilities
 */
export const timeouts = {
  short: 100,
  medium: 500,
  long: 2000,
};

/**
 * Async helper for waiting in tests
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper for testing async error scenarios
 */
export async function expectAsyncError(
  asyncFn: () => Promise<any>,
  expectedError: string | RegExp
): Promise<void> {
  try {
    await asyncFn();
    throw new Error("Expected function to throw an error");
  } catch (error) {
    if (typeof expectedError === "string") {
      expect(error.message).toContain(expectedError);
    } else {
      expect(error.message).toMatch(expectedError);
    }
  }
}

/**
 * Mock timer utilities for testing timeouts
 */
export class MockTimer {
  private timers: Set<NodeJS.Timeout> = new Set();

  setTimeout(callback: () => void, delay: number): NodeJS.Timeout {
    const timer = setTimeout(callback, delay);
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  clearAll(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

/**
 * Security test helpers
 */
export const securityTestCases = {
  maliciousSessionKeys: [
    "../../../etc/passwd",
    "..\\windows\\system32",
    "session/../../../secret",
    "normal..malicious",
    "session/with/slashes",
    "session\\with\\backslashes",
    "session with spaces",
    "session<with>brackets",
    "session:with:colons",
    'session"with"quotes',
    "session|with|pipes",
    "session?with?questions",
    "session*with*asterisks",
    "session\x00with\x00nulls",
  ],
  
  validSessionKeys: [
    "C123456-1234567890.123456",
    "user-session-123",
    "valid_key.with-dots",
    "UPPERCASE123",
    "simple123",
    "session.with.multiple.dots",
    "session_with_underscores",
    "session-with-hyphens",
  ],
};

/**
 * Performance test utilities
 */
export class PerformanceMonitor {
  private start: number = 0;
  
  startTimer(): void {
    this.start = performance.now();
  }
  
  endTimer(): number {
    return performance.now() - this.start;
  }
  
  expectUnderThreshold(thresholdMs: number): void {
    const duration = this.endTimer();
    expect(duration).toBeLessThan(thresholdMs);
  }
}

/**
 * Memory leak detection utilities
 */
export function detectMemoryLeaks<T>(
  factory: () => T,
  cleanup: (instance: T) => void,
  iterations: number = 100
): void {
  const instances: T[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const instance = factory();
    instances.push(instance);
  }
  
  // Cleanup all instances
  for (const instance of instances) {
    cleanup(instance);
  }
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
}