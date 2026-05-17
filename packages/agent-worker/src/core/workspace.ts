import { mkdir } from "node:fs/promises";
import {
  createLogger,
  sanitizeConversationId,
  WorkspaceError,
} from "@lobu/core";
import type { WorkspaceInfo, WorkspaceSetupConfig } from "./types";

const logger = createLogger("workspace");

/**
 * Workspace layout:
 *   baseDirectory/                      ← agent-level root (e.g. /workspace)
 *   baseDirectory/{conversationId}/     ← thread-specific working directory
 *
 * VCS operations (git, etc.) are handled by modules via hooks.
 */
export class WorkspaceManager {
  private config: WorkspaceSetupConfig;
  private workspaceInfo?: WorkspaceInfo;

  constructor(config: WorkspaceSetupConfig) {
    this.config = config;
  }

  async setupWorkspace(
    username: string,
    sessionKey?: string
  ): Promise<WorkspaceInfo> {
    const conversationId =
      process.env.CONVERSATION_ID || sessionKey || username || "default";

    logger.info(
      `Setting up workspace directory for ${username}, conversation: ${conversationId}...`
    );

    const sanitized = sanitizeConversationId(conversationId);
    const userDirectory = `${this.config.baseDirectory}/${sanitized}`;

    try {
      await mkdir(this.config.baseDirectory, { recursive: true });
      await mkdir(userDirectory, { recursive: true });
    } catch (error) {
      throw new WorkspaceError(
        "setupWorkspace",
        `Failed to setup workspace directory`,
        error as Error
      );
    }

    this.workspaceInfo = {
      baseDirectory: this.config.baseDirectory,
      userDirectory,
    };

    logger.info(
      `Workspace directory setup completed for ${username} (conversation: ${conversationId}) at ${userDirectory}`
    );

    return this.workspaceInfo;
  }

  getCurrentWorkingDirectory(): string {
    return this.workspaceInfo?.userDirectory || this.config.baseDirectory;
  }
}
