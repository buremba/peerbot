#!/usr/bin/env bun

import { Storage } from "@google-cloud/storage";
import type { 
  GcsConfig, 
  SessionState, 
  ConversationMetadata,
  GcsError 
} from "../types";

export class GcsStorage {
  private storage: Storage;
  private bucketName: string;

  constructor(config: GcsConfig) {
    this.bucketName = config.bucketName;
    
    // Initialize Google Cloud Storage
    this.storage = new Storage({
      projectId: config.projectId,
      keyFilename: config.keyFile,
    });
  }

  /**
   * Generate GCS path for session data
   */
  private getSessionPath(sessionKey: string): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `conversations/${year}/${month}/${day}/${sessionKey}/state.json`;
  }

  /**
   * Generate GCS path for conversation history
   */
  private getConversationPath(sessionKey: string): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `conversations/${year}/${month}/${day}/${sessionKey}/conversation.json`;
  }

  /**
   * Generate GCS path for metadata
   */
  private getMetadataPath(sessionKey: string): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `conversations/${year}/${month}/${day}/${sessionKey}/metadata.json`;
  }

  /**
   * Save session state to GCS
   */
  async saveSessionState(sessionState: SessionState): Promise<string> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const sessionPath = this.getSessionPath(sessionState.sessionKey);
      const conversationPath = this.getConversationPath(sessionState.sessionKey);
      const metadataPath = this.getMetadataPath(sessionState.sessionKey);

      // Save session state (without conversation to keep it smaller)
      const stateData = {
        ...sessionState,
        conversation: [], // Stored separately
      };
      
      const stateFile = bucket.file(sessionPath);
      await stateFile.save(JSON.stringify(stateData, null, 2), {
        metadata: {
          contentType: 'application/json',
          cacheControl: 'no-cache',
        },
      });

      // Save conversation history separately
      const conversationFile = bucket.file(conversationPath);
      await conversationFile.save(JSON.stringify(sessionState.conversation, null, 2), {
        metadata: {
          contentType: 'application/json',
          cacheControl: 'no-cache',
        },
      });

      // Save metadata for indexing
      const metadata: ConversationMetadata = {
        sessionKey: sessionState.sessionKey,
        createdAt: sessionState.createdAt,
        lastActivity: sessionState.lastActivity,
        messageCount: sessionState.conversation.length,
        platform: sessionState.context.platform,
        userId: sessionState.context.userId,
        channelId: sessionState.context.channelId,
        status: sessionState.status,
      };

      const metadataFile = bucket.file(metadataPath);
      await metadataFile.save(JSON.stringify(metadata, null, 2), {
        metadata: {
          contentType: 'application/json',
          cacheControl: 'no-cache',
        },
      });

      console.log(`Session ${sessionState.sessionKey} saved to GCS at ${sessionPath}`);
      return sessionPath;

    } catch (error) {
      const gcsError = new GcsError(
        "saveSessionState",
        `Failed to save session ${sessionState.sessionKey} to GCS`,
        error as Error
      );
      console.error(gcsError.message, error);
      throw gcsError;
    }
  }

  /**
   * Load session state from GCS
   */
  async loadSessionState(sessionKey: string): Promise<SessionState | null> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const sessionPath = this.getSessionPath(sessionKey);
      const conversationPath = this.getConversationPath(sessionKey);

      // Load session state
      const stateFile = bucket.file(sessionPath);
      const [stateExists] = await stateFile.exists();
      
      if (!stateExists) {
        console.log(`Session ${sessionKey} not found in GCS`);
        return null;
      }

      const [stateData] = await stateFile.download();
      const sessionState = JSON.parse(stateData.toString()) as SessionState;

      // Load conversation history
      const conversationFile = bucket.file(conversationPath);
      const [conversationExists] = await conversationFile.exists();
      
      if (conversationExists) {
        const [conversationData] = await conversationFile.download();
        sessionState.conversation = JSON.parse(conversationData.toString());
      } else {
        sessionState.conversation = [];
      }

      console.log(`Session ${sessionKey} loaded from GCS with ${sessionState.conversation.length} messages`);
      return sessionState;

    } catch (error) {
      const gcsError = new GcsError(
        "loadSessionState",
        `Failed to load session ${sessionKey} from GCS`,
        error as Error
      );
      console.error(gcsError.message, error);
      throw gcsError;
    }
  }

  /**
   * Check if session exists in GCS
   */
  async sessionExists(sessionKey: string): Promise<boolean> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const sessionPath = this.getSessionPath(sessionKey);
      const file = bucket.file(sessionPath);
      const [exists] = await file.exists();
      return exists;
    } catch (error) {
      console.error(`Error checking if session ${sessionKey} exists:`, error);
      return false;
    }
  }

  /**
   * Delete session from GCS
   */
  async deleteSession(sessionKey: string): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const sessionPath = this.getSessionPath(sessionKey);
      const conversationPath = this.getConversationPath(sessionKey);
      const metadataPath = this.getMetadataPath(sessionKey);

      // Delete all files (ignore errors if files don't exist)
      await Promise.allSettled([
        bucket.file(sessionPath).delete(),
        bucket.file(conversationPath).delete(),
        bucket.file(metadataPath).delete(),
      ]);

      console.log(`Session ${sessionKey} deleted from GCS`);

    } catch (error) {
      const gcsError = new GcsError(
        "deleteSession",
        `Failed to delete session ${sessionKey} from GCS`,
        error as Error
      );
      console.error(gcsError.message, error);
      throw gcsError;
    }
  }

  /**
   * List sessions for a user (for debugging/admin purposes)
   */
  async listUserSessions(userId: string, limit: number = 50): Promise<ConversationMetadata[]> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const [files] = await bucket.getFiles({
        prefix: 'conversations/',
        delimiter: '/',
        maxResults: limit * 3, // Account for multiple files per session
      });

      const sessions: ConversationMetadata[] = [];
      
      for (const file of files) {
        if (file.name.endsWith('/metadata.json')) {
          try {
            const [data] = await file.download();
            const metadata = JSON.parse(data.toString()) as ConversationMetadata;
            
            if (metadata.userId === userId) {
              sessions.push(metadata);
            }
          } catch (error) {
            console.warn(`Failed to parse metadata file ${file.name}:`, error);
          }
        }
      }

      // Sort by last activity, most recent first
      sessions.sort((a, b) => b.lastActivity - a.lastActivity);
      
      return sessions.slice(0, limit);

    } catch (error) {
      const gcsError = new GcsError(
        "listUserSessions",
        `Failed to list sessions for user ${userId}`,
        error as Error
      );
      console.error(gcsError.message, error);
      throw gcsError;
    }
  }

  /**
   * Clean up old sessions (for maintenance)
   */
  async cleanupOldSessions(olderThanDays: number = 30): Promise<number> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
      
      const [files] = await bucket.getFiles({
        prefix: 'conversations/',
      });

      let deletedCount = 0;
      
      for (const file of files) {
        const createdTime = new Date(file.metadata.timeCreated!).getTime();
        
        if (createdTime < cutoffTime) {
          await file.delete();
          deletedCount++;
        }
      }

      console.log(`Cleaned up ${deletedCount} old session files`);
      return deletedCount;

    } catch (error) {
      const gcsError = new GcsError(
        "cleanupOldSessions",
        `Failed to cleanup old sessions`,
        error as Error
      );
      console.error(gcsError.message, error);
      throw gcsError;
    }
  }
}