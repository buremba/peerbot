#!/usr/bin/env bun

import type {
  CommandRegistry,
  InstructionProvider,
  UserSuggestion,
} from "@lobu/core";
import type { AgentMetadataStore } from "./auth/agent-metadata-store";
import type { McpProxy } from "./auth/mcp/proxy";
import type { ProviderOAuthStateStore } from "./auth/oauth/state-store";
import type { AgentSettingsStore } from "./auth/settings";
import type { ModelPreferenceStore } from "./auth/settings/model-preference-store";
import type { UserAgentsStore } from "./auth/user-agents-store";
import type { ChannelBindingService } from "./channels";
import type { WorkerGateway } from "./gateway";
import type { IMessageQueue, QueueProducer } from "./infrastructure/queue";
import type { InteractionService } from "./interactions";
import type { GrantStore } from "./permissions/grant-store";
import type { IFileHandler } from "./platform/file-handler";
import type { ResponseRenderer } from "./platform/response-renderer";
import type { SecretProxy } from "./proxy/secret-proxy";
import type { InstructionService } from "./services/instruction-service";
import type { TranscriptionService } from "./services/transcription-service";
import type { ISessionManager } from "./session";

// ============================================================================
// Core Services Interface
// ============================================================================

/**
 * Core services interface that platforms receive during initialization
 * This allows platforms to access shared infrastructure without tight coupling
 */
export interface CoreServices {
  getQueue(): IMessageQueue;
  getQueueProducer(): QueueProducer;
  getSecretProxy(): SecretProxy | undefined;
  getWorkerGateway(): WorkerGateway | undefined;
  getMcpProxy(): McpProxy | undefined;
  getModelPreferenceStore(): ModelPreferenceStore | undefined;
  getOAuthStateStore(): ProviderOAuthStateStore | undefined;
  getPublicGatewayUrl(): string;
  getSessionManager(): ISessionManager;
  getInstructionService(): InstructionService | undefined;
  getInteractionService(): InteractionService;
  getAgentSettingsStore(): AgentSettingsStore;
  getChannelBindingService(): ChannelBindingService;
  getTranscriptionService(): TranscriptionService | undefined;
  getUserAgentsStore(): UserAgentsStore;
  getAgentMetadataStore(): AgentMetadataStore;
  getCommandRegistry(): CommandRegistry;
  getGrantStore(): GrantStore | undefined;
}

// ============================================================================
// Platform Adapter Interface
// ============================================================================

/**
 * Interface that all platform adapters must implement
 * Platforms include: Slack, Discord, Teams, etc.
 *
 * Each platform adapter:
 * 1. Receives CoreServices during initialization
 * 2. Sets up platform-specific event handlers
 * 3. Manages its own platform client/connection
 * 4. Uses core services (MCP, Anthropic, Redis) provided by Gateway
 */
export interface PlatformAdapter {
  /**
   * Platform name
   */
  readonly name: string;

  /**
   * Initialize the platform with core services
   * This is called by Gateway after core services are initialized
   *
   * @param services - Core services provided by Gateway
   */
  initialize(services: CoreServices): Promise<void>;

  /**
   * Start the platform (connect to platform API, start event listeners)
   * This is called after initialization
   */
  start(): Promise<void>;

  /**
   * Stop the platform gracefully
   */
  stop(): Promise<void>;

  /**
   * Check if platform is healthy and running
   */
  isHealthy(): boolean;

  /**
   * Optionally provide platform-specific instruction provider
   * Returns null if platform doesn't have custom instructions
   */
  getInstructionProvider?(): InstructionProvider | null;

  /**
   * Build platform-specific deployment metadata
   * This metadata is used for deployment annotations (e.g., thread URLs, team IDs)
   *
   * @param conversationId - The conversation identifier
   * @param channelId - The channel identifier
   * @param platformMetadata - Platform-specific metadata from the queue payload
   * @returns Record of metadata key-value pairs for deployment annotations
   */
  buildDeploymentMetadata(
    conversationId: string,
    channelId: string,
    platformMetadata: Record<string, any>
  ): Record<string, string>;

  /**
   * Render non-blocking suggestions
   * Platform should display this as suggested prompts/quick replies
   *
   * @param suggestion - The suggestions to render
   */
  renderSuggestion?(suggestion: UserSuggestion): Promise<void>;

  /**
   * Set conversation status indicator
   * Used to show "is running...", "Waiting for approval...", etc.
   * Pass null/undefined to clear the status
   *
   * @param channelId - Channel identifier
   * @param conversationId - Conversation identifier
   * @param status - Status message to display, or null to clear
   */
  setThreadStatus?(
    channelId: string,
    conversationId: string,
    status: string | null
  ): Promise<void>;

  /**
   * Check if the provided token matches the platform's configured bot token
   * Used to detect self-messaging for direct queueing
   *
   * @param token - Token to check
   * @returns True if this is the platform's own bot token
   */
  isOwnBotToken?(token: string): boolean;

  /**
   * Send a message via the messaging API
   * Uses polymorphic routing info extracted from the request
   *
   * @param token - Auth token from request
   * @param message - Message text to send (use @me to mention the bot)
   * @param options - Routing and file options
   * @param options.agentId - Universal session identifier
   * @param options.channelId - Platform-specific channel (or agentId for API)
   * @param options.conversationId - Platform-specific conversation (or agentId for API)
   * @param options.teamId - Platform-specific team/workspace
   * @param options.files - Files to upload with the message (up to 10)
   * @returns Message metadata
   */
  sendMessage?(
    token: string,
    message: string,
    options: {
      agentId: string;
      channelId: string;
      conversationId?: string;
      teamId: string;
      files?: Array<{ buffer: Buffer; filename: string }>;
    }
  ): Promise<{
    messageId: string;
    eventsUrl?: string;
    queued?: boolean;
  }>;

  /**
   * Render authentication status for OAuth providers (MCP servers, Claude, etc.)
   * Displays connection status in platform-specific UI (e.g., Slack home tab)
   *
   * @param userId - User ID to render status for
   * @param providers - Array of OAuth providers with their connection status
   * @returns Promise that resolves when rendering is complete
   */
  renderAuthStatus?(
    userId: string,
    providers: Array<{
      id: string;
      name: string;
      isAuthenticated: boolean;
      loginUrl?: string;
      logoutUrl?: string;
      metadata?: Record<string, any>;
    }>
  ): Promise<void>;

  /**
   * Get the file handler for this platform.
   * Used by the file upload/download routes to route files
   * to the correct platform-specific handler.
   */
  getFileHandler?(): IFileHandler | undefined;

  /**
   * Get the response renderer for this platform.
   * Used by the unified thread response consumer to route responses
   * to platform-specific rendering logic.
   *
   * @returns ResponseRenderer instance or undefined if platform handles responses differently
   */
  getResponseRenderer?(): ResponseRenderer | undefined;

  /**
   * Check if a channel ID represents a group/channel vs a DM.
   * Used by space-resolver to determine space type.
   *
   * @param channelId - Channel identifier to check
   * @returns True if this is a group/channel, false if DM
   */
  isGroupChannel?(channelId: string): boolean;

  /**
   * Get display information for the platform.
   * Used in UI to show platform-specific icons and names.
   *
   * @returns Display info with name and icon (SVG or emoji)
   */
  getDisplayInfo?(): {
    /** Human-readable platform name */
    name: string;
    /** SVG icon markup or emoji */
    icon: string;
    /** Optional logo URL */
    logoUrl?: string;
  };

  /**
   * Extract routing info from platform-specific request body.
   * Used by messaging API to parse platform-specific fields.
   *
   * @param body - Request body with platform-specific fields
   * @returns Routing info or null if platform fields are missing/invalid
   */
  extractRoutingInfo?(body: Record<string, unknown>): {
    channelId: string;
    conversationId?: string;
    teamId?: string;
  } | null;

  /**
   * Get conversation history for a channel/thread.
   * Used by the GetChannelHistory tool to fetch past messages.
   *
   * @param channelId - Channel/chat identifier
   * @param conversationId - Conversation identifier (optional)
   * @param limit - Maximum number of messages to return
   * @param before - ISO timestamp cursor for pagination
   * @returns History response with messages and pagination info
   */
  getConversationHistory?(
    channelId: string,
    conversationId: string | undefined,
    limit: number,
    before: string | undefined
  ): Promise<{
    messages: Array<{
      timestamp: string;
      user: string;
      text: string;
      isBot?: boolean;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  }>;
}

// ============================================================================
// Platform Registry
// ============================================================================

/**
 * Global registry for platform adapters
 * Allows deployment managers and other services to access platform-specific functionality
 */
export class PlatformRegistry {
  private platforms: Map<string, PlatformAdapter> = new Map();

  /**
   * Register a platform adapter
   */
  register(platform: PlatformAdapter): void {
    this.platforms.set(platform.name, platform);
  }

  /**
   * Get a platform by name
   */
  get(name: string): PlatformAdapter | undefined {
    return this.platforms.get(name);
  }

  /**
   * Get list of available platform names
   */
  getAvailablePlatforms(): string[] {
    return Array.from(this.platforms.keys());
  }
}

/**
 * Global platform registry instance
 */
export const platformRegistry = new PlatformRegistry();
