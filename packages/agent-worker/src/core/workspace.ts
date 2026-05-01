import { mkdir } from "node:fs/promises";
import {
  createLogger,
  sanitizeConversationId,
  WorkspaceError,
} from "@lobu/core";
import type { WorkspaceInfo, WorkspaceSetupConfig } from "./types";

const logger = createLogger("workspace");

// ============================================================================
// WORKSPACE MANAGER
// ============================================================================

/**
 * Simplified WorkspaceManager - only handles directory creation.
 * All VCS operations (git, etc.) are handled by modules via hooks.
 *
 * Workspace layout:
 *   baseDirectory/                      ← agent-level root (e.g. /workspace)
 *   baseDirectory/{conversationId}/     ← thread-specific working directory
 */
export class WorkspaceManager {
  private config: WorkspaceSetupConfig;
  private workspaceInfo?: WorkspaceInfo;

  constructor(config: WorkspaceSetupConfig) {
    this.config = config;
  }

  /**
   * Setup workspace directory - creates thread-specific directory only.
   * VCS operations are handled by module hooks (e.g., GitHub module).
   */
  async setupWorkspace(
    username: string,
    sessionKey?: string
  ): Promise<WorkspaceInfo> {
    try {
      const conversationId =
        process.env.CONVERSATION_ID || sessionKey || username || "default";

      logger.info(
        `Setting up workspace directory for ${username}, conversation: ${conversationId}...`
      );

      const sanitized = sanitizeConversationId(conversationId);
      const userDirectory = `${this.config.baseDirectory}/${sanitized}`;

      // Ensure directories exist
      await this.ensureDirectory(this.config.baseDirectory);
      await this.ensureDirectory(userDirectory);

      this.workspaceInfo = {
        baseDirectory: this.config.baseDirectory,
        userDirectory,
      };

      logger.info(
        `Workspace directory setup completed for ${username} (conversation: ${conversationId}) at ${userDirectory}`
      );

      return this.workspaceInfo;
    } catch (error) {
      throw new WorkspaceError(
        "setupWorkspace",
        `Failed to setup workspace directory`,
        error as Error
      );
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  /**
   * Get current working directory (thread-specific).
   */
  getCurrentWorkingDirectory(): string {
    return this.workspaceInfo?.userDirectory || this.config.baseDirectory;
  }
}
