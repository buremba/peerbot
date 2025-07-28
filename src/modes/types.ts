import type { ParsedGitHubContext } from "../github/context";
import type { GenericContext } from "../core/prompt";

export type ModeName = "tag" | "agent" | "slack";

export type ModeContext = {
  mode?: ModeName;
  githubContext?: ParsedGitHubContext;
  commentId?: number | string;
  baseBranch?: string;
  claudeBranch?: string;
  mcpConfigPath?: string;
  genericContext?: GenericContext;
  platform?: "github" | "slack";
  trackingInfo?: {
    channelId?: string;
    messageTs?: string;
    threadTs?: string;
  };
};

export type ModeData = {
  commentId?: number | string;
  baseBranch?: string;
  claudeBranch?: string;
  platform?: "github" | "slack";
};

/**
 * Mode interface for claude-code execution modes.
 * Each mode defines its own behavior for trigger detection, prompt generation,
 * and tracking comment/message creation.
 *
 * Current modes include:
 * - 'tag': Traditional GitHub implementation triggered by mentions/assignments
 * - 'agent': For GitHub automation with no trigger checking
 * - 'slack': For Slack integration with app mentions and message triggers
 */
export type Mode = {
  name: ModeName;
  description?: string;

  /**
   * Determines if this mode should trigger based on the context
   * For GitHub modes, this receives ParsedGitHubContext
   * For Slack modes, this is typically handled by event handlers
   */
  shouldTrigger?(context: any): Promise<boolean> | boolean;

  /**
   * Returns the list of tools that should be allowed for this mode
   */
  getAllowedTools(): string[];

  /**
   * Returns the list of tools that should be disallowed for this mode
   */
  getDisallowedTools(): string[];

  /**
   * Determines if this mode should create a tracking comment (GitHub only)
   */
  shouldCreateTrackingComment?(): boolean;
};
