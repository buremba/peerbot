#!/usr/bin/env bun

import { describe, it, expect, beforeEach, mock, jest } from "bun:test";
import { Storage } from "@google-cloud/storage";
import { GcsStorage } from "../storage/gcs";
import type { SessionState, GcsConfig, ConversationMetadata } from "../types";

// Mock Google Cloud Storage
jest.mock("@google-cloud/storage");
const MockedStorage = Storage as jest.MockedClass<typeof Storage>;

describe("GcsStorage", () => {
  let gcsStorage: GcsStorage;
  let mockStorage: jest.Mocked<Storage>;
  let mockBucket: any;
  let mockFile: any;

  const mockConfig: GcsConfig = {
    bucketName: "test-bucket",
    projectId: "test-project",
    keyFile: "/path/to/key.json",
  };

  const mockSessionState: SessionState = {
    sessionKey: "test-session-123",
    context: {
      platform: "slack",
      userId: "U123456",
      username: "testuser",
      channelId: "C123456",
      messageTs: "1234567890.123456",
      threadTs: "1234567890.123456",
    },
    conversation: [
      { role: "user", content: "Hello", timestamp: Date.now() },
      { role: "assistant", content: "Hi there", timestamp: Date.now() },
    ],
    createdAt: Date.now() - 1000,
    lastActivity: Date.now(),
    status: "active",
  };

  beforeEach(() => {
    // Reset all mocks
    MockedStorage.mockClear();

    // Setup mock file
    mockFile = {
      save: jest.fn().mockResolvedValue(undefined),
      download: jest.fn().mockResolvedValue([JSON.stringify(mockSessionState)]),
      exists: jest.fn().mockResolvedValue([true]),
      delete: jest.fn().mockResolvedValue(undefined),
      metadata: { timeCreated: new Date().toISOString() },
      name: "test-file.json",
    };

    // Setup mock bucket
    mockBucket = {
      file: jest.fn().mockReturnValue(mockFile),
      getFiles: jest.fn().mockResolvedValue([[mockFile]]),
    };

    // Setup mock storage
    mockStorage = {
      bucket: jest.fn().mockReturnValue(mockBucket),
    } as any;

    MockedStorage.mockImplementation(() => mockStorage);

    gcsStorage = new GcsStorage(mockConfig);
  });

  describe("Session Key Validation", () => {
    it("should validate session keys in path generation methods", () => {
      const maliciousKeys = [
        "../../../etc/passwd",
        "session\\with\\backslashes", 
        "session/with/slashes",
        "session with spaces",
        "session<>invalid",
      ];

      for (const key of maliciousKeys) {
        expect(() => {
          (gcsStorage as any).getSessionPath(key);
        }).toThrow();

        expect(() => {
          (gcsStorage as any).getConversationPath(key);
        }).toThrow();

        expect(() => {
          (gcsStorage as any).getMetadataPath(key);
        }).toThrow();
      }
    });

    it("should accept valid session keys", () => {
      const validKeys = [
        "C123456-1234567890.123456",
        "valid-session-key",
        "session_with_underscores",
        "session.with.dots",
        "UPPERCASE123",
      ];

      for (const key of validKeys) {
        expect(() => {
          (gcsStorage as any).getSessionPath(key);
          (gcsStorage as any).getConversationPath(key);
          (gcsStorage as any).getMetadataPath(key);
        }).not.toThrow();
      }
    });
  });

  describe("Path Generation", () => {
    it("should generate correct session path", () => {
      const sessionKey = "test-session-123";
      const path = (gcsStorage as any).getSessionPath(sessionKey);
      
      expect(path).toMatch(/^conversations\/\d{4}\/\d{2}\/\d{2}\/test-session-123\/state\.json$/);
    });

    it("should generate correct conversation path", () => {
      const sessionKey = "test-session-123";
      const path = (gcsStorage as any).getConversationPath(sessionKey);
      
      expect(path).toMatch(/^conversations\/\d{4}\/\d{2}\/\d{2}\/test-session-123\/conversation\.json$/);
    });

    it("should generate correct metadata path", () => {
      const sessionKey = "test-session-123";
      const path = (gcsStorage as any).getMetadataPath(sessionKey);
      
      expect(path).toMatch(/^conversations\/\d{4}\/\d{2}\/\d{2}\/test-session-123\/metadata\.json$/);
    });

    it("should organize files by date", () => {
      const sessionKey = "test-session";
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      
      const path = (gcsStorage as any).getSessionPath(sessionKey);
      expect(path).toContain(`conversations/${year}/${month}/${day}/`);
    });
  });

  describe("Session State Operations", () => {
    it("should save session state successfully", async () => {
      const expectedPath = expect.stringMatching(/conversations\/\d{4}\/\d{2}\/\d{2}\/test-session-123\/state\.json/);
      
      const result = await gcsStorage.saveSessionState(mockSessionState);

      expect(mockStorage.bucket).toHaveBeenCalledWith(mockConfig.bucketName);
      expect(mockBucket.file).toHaveBeenCalledTimes(3); // state, conversation, metadata
      expect(mockFile.save).toHaveBeenCalledTimes(3);
      expect(result).toEqual(expectedPath);
    });

    it("should save session state without conversation in main file", async () => {
      await gcsStorage.saveSessionState(mockSessionState);

      const saveCall = mockFile.save.mock.calls[0];
      const savedData = JSON.parse(saveCall[0]);
      
      expect(savedData.conversation).toEqual([]);
      expect(savedData.sessionKey).toBe(mockSessionState.sessionKey);
      expect(savedData.context).toEqual(mockSessionState.context);
    });

    it("should save conversation separately", async () => {
      await gcsStorage.saveSessionState(mockSessionState);

      const conversationSaveCall = mockFile.save.mock.calls[1];
      const savedConversation = JSON.parse(conversationSaveCall[0]);
      
      expect(savedConversation).toEqual(mockSessionState.conversation);
    });

    it("should save metadata with correct structure", async () => {
      await gcsStorage.saveSessionState(mockSessionState);

      const metadataSaveCall = mockFile.save.mock.calls[2];
      const savedMetadata = JSON.parse(metadataSaveCall[0]);
      
      expect(savedMetadata).toMatchObject({
        sessionKey: mockSessionState.sessionKey,
        createdAt: mockSessionState.createdAt,
        lastActivity: mockSessionState.lastActivity,
        messageCount: mockSessionState.conversation.length,
        platform: mockSessionState.context.platform,
        userId: mockSessionState.context.userId,
        channelId: mockSessionState.context.channelId,
        status: mockSessionState.status,
      });
    });

    it("should handle save errors gracefully", async () => {
      mockFile.save.mockRejectedValue(new Error("GCS write failed"));

      await expect(
        gcsStorage.saveSessionState(mockSessionState)
      ).rejects.toThrow("Failed to save session test-session-123 to GCS");
    });
  });

  describe("Session State Loading", () => {
    it("should load session state successfully", async () => {
      const stateData = { ...mockSessionState, conversation: [] };
      const conversationData = mockSessionState.conversation;

      mockFile.download
        .mockResolvedValueOnce([JSON.stringify(stateData)])
        .mockResolvedValueOnce([JSON.stringify(conversationData)]);

      const result = await gcsStorage.loadSessionState("test-session-123");

      expect(result).toEqual(mockSessionState);
      expect(mockFile.download).toHaveBeenCalledTimes(2);
    });

    it("should return null for non-existent session", async () => {
      mockFile.exists.mockResolvedValue([false]);

      const result = await gcsStorage.loadSessionState("non-existent");

      expect(result).toBeNull();
      expect(mockFile.download).not.toHaveBeenCalled();
    });

    it("should load session without conversation if conversation file missing", async () => {
      const stateData = { ...mockSessionState, conversation: [] };

      mockFile.exists
        .mockResolvedValueOnce([true])   // state file exists
        .mockResolvedValueOnce([false]); // conversation file doesn't exist

      mockFile.download.mockResolvedValueOnce([JSON.stringify(stateData)]);

      const result = await gcsStorage.loadSessionState("test-session-123");

      expect(result?.conversation).toEqual([]);
    });

    it("should handle load errors gracefully", async () => {
      mockFile.download.mockRejectedValue(new Error("GCS read failed"));

      await expect(
        gcsStorage.loadSessionState("test-session-123")
      ).rejects.toThrow("Failed to load session test-session-123 from GCS");
    });
  });

  describe("Session Existence Check", () => {
    it("should return true for existing session", async () => {
      mockFile.exists.mockResolvedValue([true]);

      const exists = await gcsStorage.sessionExists("test-session-123");

      expect(exists).toBe(true);
      expect(mockFile.exists).toHaveBeenCalled();
    });

    it("should return false for non-existent session", async () => {
      mockFile.exists.mockResolvedValue([false]);

      const exists = await gcsStorage.sessionExists("non-existent");

      expect(exists).toBe(false);
    });

    it("should handle existence check errors gracefully", async () => {
      mockFile.exists.mockRejectedValue(new Error("GCS access failed"));

      const exists = await gcsStorage.sessionExists("test-session");

      expect(exists).toBe(false);
    });
  });

  describe("Session Deletion", () => {
    it("should delete all session files", async () => {
      await gcsStorage.deleteSession("test-session-123");

      expect(mockBucket.file).toHaveBeenCalledTimes(3); // state, conversation, metadata
      expect(mockFile.delete).toHaveBeenCalledTimes(3);
    });

    it("should handle deletion errors gracefully", async () => {
      mockFile.delete.mockRejectedValue(new Error("GCS delete failed"));

      await expect(
        gcsStorage.deleteSession("test-session-123")
      ).rejects.toThrow("Failed to delete session test-session-123 from GCS");
    });
  });

  describe("User Session Listing", () => {
    const mockMetadata: ConversationMetadata = {
      sessionKey: "test-session",
      createdAt: Date.now() - 1000,
      lastActivity: Date.now(),
      messageCount: 5,
      platform: "slack",
      userId: "U123456",
      channelId: "C123456",
      status: "completed",
    };

    it("should list user sessions successfully", async () => {
      const metadataFile = {
        ...mockFile,
        name: "conversations/2024/01/01/test-session/metadata.json",
        download: jest.fn().mockResolvedValue([JSON.stringify(mockMetadata)]),
      };

      mockBucket.getFiles.mockResolvedValue([[metadataFile]]);

      const sessions = await gcsStorage.listUserSessions("U123456");

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toEqual(mockMetadata);
    });

    it("should filter sessions by user ID", async () => {
      const metadataOtherUser = { ...mockMetadata, userId: "U999999" };
      
      const metadataFile1 = {
        ...mockFile,
        name: "conversations/2024/01/01/session1/metadata.json",
        download: jest.fn().mockResolvedValue([JSON.stringify(mockMetadata)]),
      };
      
      const metadataFile2 = {
        ...mockFile,
        name: "conversations/2024/01/01/session2/metadata.json",
        download: jest.fn().mockResolvedValue([JSON.stringify(metadataOtherUser)]),
      };

      mockBucket.getFiles.mockResolvedValue([[metadataFile1, metadataFile2]]);

      const sessions = await gcsStorage.listUserSessions("U123456");

      expect(sessions).toHaveLength(1);
      expect(sessions[0].userId).toBe("U123456");
    });

    it("should sort sessions by last activity (most recent first)", async () => {
      const session1 = { ...mockMetadata, sessionKey: "session1", lastActivity: 1000 };
      const session2 = { ...mockMetadata, sessionKey: "session2", lastActivity: 2000 };
      const session3 = { ...mockMetadata, sessionKey: "session3", lastActivity: 1500 };

      const files = [
        { ...mockFile, name: "conversations/2024/01/01/session1/metadata.json", download: jest.fn().mockResolvedValue([JSON.stringify(session1)]) },
        { ...mockFile, name: "conversations/2024/01/01/session2/metadata.json", download: jest.fn().mockResolvedValue([JSON.stringify(session2)]) },
        { ...mockFile, name: "conversations/2024/01/01/session3/metadata.json", download: jest.fn().mockResolvedValue([JSON.stringify(session3)]) },
      ];

      mockBucket.getFiles.mockResolvedValue([files]);

      const sessions = await gcsStorage.listUserSessions("U123456");

      expect(sessions).toHaveLength(3);
      expect(sessions[0].sessionKey).toBe("session2");
      expect(sessions[1].sessionKey).toBe("session3");
      expect(sessions[2].sessionKey).toBe("session1");
    });

    it("should handle listing errors gracefully", async () => {
      mockBucket.getFiles.mockRejectedValue(new Error("GCS list failed"));

      await expect(
        gcsStorage.listUserSessions("U123456")
      ).rejects.toThrow("Failed to list sessions for user U123456");
    });
  });

  describe("Session Cleanup", () => {
    it("should clean up old sessions", async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago
      const oldFile = {
        ...mockFile,
        metadata: { timeCreated: oldDate.toISOString() },
        delete: jest.fn().mockResolvedValue(undefined),
      };

      const recentFile = {
        ...mockFile,
        metadata: { timeCreated: new Date().toISOString() },
        delete: jest.fn().mockResolvedValue(undefined),
      };

      mockBucket.getFiles.mockResolvedValue([[oldFile, recentFile]]);

      const deletedCount = await gcsStorage.cleanupOldSessions(30);

      expect(deletedCount).toBe(1);
      expect(oldFile.delete).toHaveBeenCalled();
      expect(recentFile.delete).not.toHaveBeenCalled();
    });

    it("should handle cleanup errors gracefully", async () => {
      mockBucket.getFiles.mockRejectedValue(new Error("GCS cleanup failed"));

      await expect(
        gcsStorage.cleanupOldSessions(30)
      ).rejects.toThrow("Failed to cleanup old sessions");
    });
  });
});