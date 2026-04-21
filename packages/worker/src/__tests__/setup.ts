/**
 * Test setup and configuration for worker tests.
 *
 * Shared mocks live in @lobu/core fixtures.
 * This file re-exports them and adds worker-specific helpers.
 */

import { afterAll, beforeAll } from "bun:test";
import {
  createWorkerConfig,
  mockFetch as sharedMockFetch,
} from "@lobu/core/testing";

export const mockWorkerConfig = createWorkerConfig();

// Mock environment variables for testing
const mockEnvVars: Record<string, string> = {
  DISPATCHER_URL: "https://test-dispatcher.example.com",
  WORKER_TOKEN: "test-worker-token-123",
  CONVERSATION_ID: "1234567890.123456",
  WORKER_SESSION_KEY: "test-session-key",
  WORKER_USER_ID: "U1234567890",
  WORKER_CHANNEL_ID: "C1234567890",
  WORKER_USER_PROMPT: Buffer.from("Test user prompt").toString("base64"),
  WORKER_RESPONSE_CHANNEL: "C1234567890",
  WORKER_RESPONSE_TS: "1234567890.123457",
  WORKER_CLAUDE_OPTIONS: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
  }),
  WORKER_TEAM_ID: "T1234567890",
  WORKER_WORKSPACE_BASE_DIRECTORY: "/tmp/test-workspace",
};

export class TestHelpers {
  static mockFetch(responses?: Record<string, any>): () => void {
    return sharedMockFetch(responses);
  }

  static createMockProgressUpdate(
    type: "output" | "completion" | "error",
    data: any
  ) {
    return { type, data, timestamp: Date.now() };
  }

  static async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static mockEventSource() {
    class MockEventSource {
      url: string;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          if (this.onopen) this.onopen(new Event("open"));
        }, 10);
      }

      close() {
        this.readyState = 2;
      }

      simulateMessage(data: any) {
        if (this.onmessage) {
          this.onmessage(
            new MessageEvent("message", { data: JSON.stringify(data) })
          );
        }
      }

      simulateError() {
        if (this.onerror) this.onerror(new Event("error"));
      }
    }

    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as any;
    return () => {
      globalThis.EventSource = originalEventSource;
    };
  }
}

// Global test setup
beforeAll(() => {
  for (const [key, value] of Object.entries(mockEnvVars)) {
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const key of Object.keys(mockEnvVars)) {
    delete process.env[key];
  }
});
