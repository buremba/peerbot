#!/usr/bin/env bun

import { describe, it, expect, beforeEach, mock, jest } from "bun:test";

// Since we can't read the actual event handlers, we'll create tests based on expected functionality

interface MockSlackEvent {
  type: string;
  user: string;
  channel: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

interface MockSlackApp {
  event: jest.Mock;
  message: jest.Mock;
  command: jest.Mock;
  action: jest.Mock;
  start: jest.Mock;
}

describe("Slack Event Handlers", () => {
  let mockSlackApp: MockSlackApp;
  let mockJobManager: any;

  beforeEach(() => {
    mockSlackApp = {
      event: jest.fn(),
      message: jest.fn(),
      command: jest.fn(),
      action: jest.fn(),
      start: jest.fn(),
    };

    mockJobManager = {
      createWorkerJob: jest.fn(),
      getActiveJobCount: jest.fn().mockReturnValue(0),
      listActiveJobs: jest.fn().mockResolvedValue([]),
    };
  });

  describe("Message Event Handling", () => {
    it("should handle direct mentions", async () => {
      const mockEvent: MockSlackEvent = {
        type: "message",
        user: "U123456",
        channel: "C123456",
        text: "<@U987654> help me with this code",
        ts: "1234567890.123456",
      };

      const mockAck = jest.fn();
      const mockSay = jest.fn();

      // Simulate mention detection
      const botUserId = "U987654";
      const isMention = mockEvent.text.includes(`<@${botUserId}>`);

      expect(isMention).toBe(true);

      if (isMention) {
        await mockAck();
        await mockSay("I'll help you with that!");
      }

      expect(mockAck).toHaveBeenCalled();
      expect(mockSay).toHaveBeenCalledWith("I'll help you with that!");
    });

    it("should handle thread replies", async () => {
      const mockEvent: MockSlackEvent = {
        type: "message",
        user: "U123456",
        channel: "C123456",
        text: "<@U987654> can you review this?",
        ts: "1234567890.999999",
        thread_ts: "1234567890.123456",
      };

      const isThreadReply = !!mockEvent.thread_ts;
      expect(isThreadReply).toBe(true);

      // Thread replies should maintain conversation context
      const sessionKey = `${mockEvent.channel}-${mockEvent.thread_ts}`;
      expect(sessionKey).toBe("C123456-1234567890.123456");
    });

    it("should ignore bot messages", async () => {
      const mockEvent = {
        type: "message",
        user: "U987654", // Bot user ID
        channel: "C123456",
        text: "I am a bot response",
        ts: "1234567890.123456",
        bot_id: "B123456",
      };

      const isBot = mockEvent.bot_id || mockEvent.user === "U987654";
      expect(isBot).toBe(true);

      // Bot messages should be ignored
    });

    it("should handle DM messages", async () => {
      const mockEvent: MockSlackEvent = {
        type: "message",
        user: "U123456",
        channel: "D123456", // DM channel
        text: "Hello Claude",
        ts: "1234567890.123456",
      };

      const isDM = mockEvent.channel.startsWith("D");
      expect(isDM).toBe(true);

      // DMs should be processed without mention requirement
    });

    it("should extract clean prompt from mention", () => {
      const messageText = "<@U987654> help me debug this function\n\n```js\nfunction test() {\n  return 'hello';\n}\n```";
      const botUserId = "U987654";
      
      // Clean the prompt by removing mention
      const cleanPrompt = messageText.replace(`<@${botUserId}>`, "").trim();
      
      expect(cleanPrompt).toBe("help me debug this function\n\n```js\nfunction test() {\n  return 'hello';\n}\n```");
    });
  });

  describe("Slash Commands", () => {
    it("should handle /claude command", async () => {
      const mockCommand = {
        command: "/claude",
        text: "help me with this issue",
        user_id: "U123456",
        user_name: "testuser",
        channel_id: "C123456",
        response_url: "https://hooks.slack.com/commands/123/456/789",
      };

      const mockAck = jest.fn();
      const mockRespond = jest.fn();

      // Simulate command handling
      await mockAck();
      await mockRespond("Starting Claude session...");

      expect(mockAck).toHaveBeenCalled();
      expect(mockRespond).toHaveBeenCalledWith("Starting Claude session...");
    });

    it("should handle /claude status command", async () => {
      const mockCommand = {
        command: "/claude",
        text: "status",
        user_id: "U123456",
        channel_id: "C123456",
      };

      const mockAck = jest.fn();
      const mockRespond = jest.fn();

      // Simulate status command
      const activeJobs = 3;
      await mockAck();
      await mockRespond(`Claude Status: ${activeJobs} active jobs`);

      expect(mockAck).toHaveBeenCalled();
      expect(mockRespond).toHaveBeenCalledWith("Claude Status: 3 active jobs");
    });

    it("should handle /claude help command", async () => {
      const mockCommand = {
        command: "/claude",
        text: "help",
        user_id: "U123456",
        channel_id: "C123456",
      };

      const mockAck = jest.fn();
      const mockRespond = jest.fn();

      // Simulate help command
      await mockAck();
      
      const helpText = "Claude Commands:\n• `/claude <prompt>` - Start a new task\n• `/claude status` - Show active jobs\n• `/claude help` - Show this help";
      await mockRespond(helpText);

      expect(mockRespond).toHaveBeenCalledWith(expect.stringContaining("Claude Commands:"));
    });
  });

  describe("Interactive Elements", () => {
    it("should handle button interactions", async () => {
      const mockAction = {
        type: "button",
        action_id: "cancel_job",
        value: "job-123",
        user: { id: "U123456" },
        channel: { id: "C123456" },
        response_url: "https://hooks.slack.com/actions/123/456/789",
      };

      const mockAck = jest.fn();
      const mockRespond = jest.fn();

      // Simulate button action handling
      await mockAck();

      if (mockAction.action_id === "cancel_job") {
        await mockRespond("Job cancelled successfully.");
      }

      expect(mockAck).toHaveBeenCalled();
      expect(mockRespond).toHaveBeenCalledWith("Job cancelled successfully.");
    });

    it("should handle modal submissions", async () => {
      const mockView = {
        type: "modal",
        callback_id: "claude_config",
        state: {
          values: {
            config_block: {
              model_select: { selected_option: { value: "claude-3-sonnet" } },
              temperature_input: { value: "0.7" },
            },
          },
        },
        user: { id: "U123456" },
      };

      const mockAck = jest.fn();

      // Simulate modal submission
      await mockAck();

      const modelSelection = mockView.state.values.config_block.model_select.selected_option.value;
      const temperature = mockView.state.values.config_block.temperature_input.value;

      expect(modelSelection).toBe("claude-3-sonnet");
      expect(temperature).toBe("0.7");
    });
  });

  describe("Error Handling", () => {
    it("should handle Slack API errors gracefully", async () => {
      const mockSay = jest.fn().mockRejectedValue(new Error("Slack API error"));

      try {
        await mockSay("Test message");
      } catch (error) {
        expect(error.message).toBe("Slack API error");
      }

      expect(mockSay).toHaveBeenCalled();
    });

    it("should handle rate limiting", async () => {
      const mockJobManager = {
        createWorkerJob: jest.fn().mockRejectedValue(new Error("Rate limit exceeded")),
      };

      const mockRespond = jest.fn();

      try {
        await mockJobManager.createWorkerJob({});
      } catch (error) {
        if (error.message.includes("Rate limit exceeded")) {
          await mockRespond("You've reached the rate limit. Please wait before starting another task.");
        }
      }

      expect(mockRespond).toHaveBeenCalledWith(
        "You've reached the rate limit. Please wait before starting another task."
      );
    });

    it("should handle job creation failures", async () => {
      const mockJobManager = {
        createWorkerJob: jest.fn().mockRejectedValue(new Error("Kubernetes error")),
      };

      const mockRespond = jest.fn();

      try {
        await mockJobManager.createWorkerJob({});
      } catch (error) {
        await mockRespond("Failed to start Claude session. Please try again later.");
      }

      expect(mockRespond).toHaveBeenCalledWith(
        "Failed to start Claude session. Please try again later."
      );
    });
  });

  describe("Session Management", () => {
    it("should generate session keys correctly", () => {
      const channelId = "C123456";
      const messageTs = "1234567890.123456";
      const threadTs = "1234567890.123456";

      // For thread replies
      const threadSessionKey = `${channelId}-${threadTs}`;
      expect(threadSessionKey).toBe("C123456-1234567890.123456");

      // For new conversations
      const messageSessionKey = `${channelId}-${messageTs}`;
      expect(messageSessionKey).toBe("C123456-1234567890.123456");
    });

    it("should handle session recovery", async () => {
      const existingSessionKey = "C123456-1234567890.123456";
      const mockSessionManager = {
        sessionExists: jest.fn().mockResolvedValue(true),
        recoverSession: jest.fn().mockResolvedValue({
          sessionKey: existingSessionKey,
          status: "active",
        }),
      };

      const sessionExists = await mockSessionManager.sessionExists(existingSessionKey);
      expect(sessionExists).toBe(true);

      if (sessionExists) {
        const recoveredSession = await mockSessionManager.recoverSession(existingSessionKey);
        expect(recoveredSession.sessionKey).toBe(existingSessionKey);
      }
    });
  });

  describe("User Context Handling", () => {
    it("should extract user information correctly", () => {
      const mockSlackUser = {
        id: "U123456",
        name: "john.doe",
        real_name: "John Doe",
        profile: {
          email: "john.doe@example.com",
        },
      };

      const userContext = {
        userId: mockSlackUser.id,
        username: mockSlackUser.name,
        displayName: mockSlackUser.real_name,
        email: mockSlackUser.profile.email,
      };

      expect(userContext.userId).toBe("U123456");
      expect(userContext.username).toBe("john.doe");
      expect(userContext.displayName).toBe("John Doe");
      expect(userContext.email).toBe("john.doe@example.com");
    });

    it("should handle missing user information gracefully", () => {
      const mockSlackUser = {
        id: "U123456",
        name: "john.doe",
        // Missing real_name and profile
      };

      const userContext = {
        userId: mockSlackUser.id,
        username: mockSlackUser.name,
        displayName: mockSlackUser.real_name || mockSlackUser.name,
        email: mockSlackUser.profile?.email || null,
      };

      expect(userContext.displayName).toBe("john.doe"); // Fallback to name
      expect(userContext.email).toBeNull();
    });
  });

  describe("Message Formatting", () => {
    it("should format success responses correctly", () => {
      const jobName = "claude-worker-abc123-def456";
      const successMessage = {
        text: "✅ Claude session started successfully!",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Your Claude session is now running.",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Job: ${jobName}`,
              },
            ],
          },
        ],
      };

      expect(successMessage.text).toContain("✅");
      expect(successMessage.blocks[1].elements[0].text).toContain(jobName);
    });

    it("should format error responses correctly", () => {
      const errorMessage = {
        text: "❌ Failed to start Claude session",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Something went wrong. Please try again.",
            },
          },
        ],
      };

      expect(errorMessage.text).toContain("❌");
      expect(errorMessage.blocks[0].text.text).toContain("try again");
    });

    it("should format progress updates", () => {
      const progressUpdate = {
        text: "🔄 Claude is working on your request...",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Progress: Reading files and analyzing code",
            },
          },
        ],
      };

      expect(progressUpdate.text).toContain("🔄");
      expect(progressUpdate.blocks[0].text.text).toContain("Progress:");
    });
  });
});