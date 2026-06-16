/**
 * Shared factory functions for test data.
 *
 * All factories accept a partial override object so tests only specify
 * the fields they care about while getting sensible defaults for the rest.
 */

// Re-export WorkerConfig shape (worker package owns the interface).
// We duplicate a minimal version here to avoid a circular dependency.
interface TestWorkerConfig {
  sessionKey: string;
  userId: string;
  agentId: string;
  channelId: string;
  conversationId: string;
  userPrompt: string;
  responseChannel: string;
  responseId: string;
  platform: string;
  agentOptions: string;
  teamId?: string;
  workspace: { baseDirectory: string };
}

export function createWorkerConfig(
  overrides: Partial<TestWorkerConfig> = {}
): TestWorkerConfig {
  return {
    sessionKey: "test-session-key",
    userId: "U1234567890",
    agentId: "agent-test",
    channelId: "C1234567890",
    conversationId: "1234567890.123456",
    userPrompt: Buffer.from("Test user prompt").toString("base64"),
    responseChannel: "C1234567890",
    responseId: "1234567890.123457",
    platform: "slack",
    agentOptions: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
    }),
    teamId: "T1234567890",
    workspace: { baseDirectory: "/tmp/test-workspace" },
    ...overrides,
  };
}

export function createMockJob(overrides: Record<string, any> = {}): {
  id: string;
  data: Record<string, any>;
} {
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
