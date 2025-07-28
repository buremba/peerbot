#!/usr/bin/env bun

import { writeFile, mkdir } from "fs/promises";
import path from "path";

export interface SlackMcpConfig {
  mcpServers: {
    [serverName: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
}

export interface SlackMcpServerOptions {
  slackToken: string;
  trackingChannelId?: string;
  trackingMessageTs?: string;
  includeGitHubFileOps?: boolean;
  includedAdditionalServers?: Record<string, any>;
  customServerConfigs?: Record<string, any>;
}

/**
 * Generate MCP configuration for Slack environment
 */
export function generateSlackMcpConfig(options: SlackMcpServerOptions): SlackMcpConfig {
  const config: SlackMcpConfig = {
    mcpServers: {},
  };

  // Add Slack message server
  config.mcpServers["slack-message"] = {
    command: "bun",
    args: [path.join(__dirname, "slack-message-server.ts")],
    env: {
      SLACK_BOT_TOKEN: options.slackToken,
      ...(options.trackingChannelId && {
        SLACK_TRACKING_CHANNEL_ID: options.trackingChannelId,
      }),
      ...(options.trackingMessageTs && {
        SLACK_TRACKING_MESSAGE_TS: options.trackingMessageTs,
      }),
    },
  };

  // Optionally include GitHub file operations (if Git integration is still needed)
  if (options.includeGitHubFileOps) {
    const githubToken = process.env.GITHUB_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (githubToken) {
      config.mcpServers["github-file-ops"] = {
        command: "bun", 
        args: [path.join(__dirname, "../../mcp/github-file-ops-server.ts")],
        env: {
          GITHUB_TOKEN: githubToken,
        },
      };
    }
  }

  // Add any additional custom servers
  if (options.includedAdditionalServers) {
    Object.assign(config.mcpServers, options.includedAdditionalServers);
  }

  // Apply custom server configurations
  if (options.customServerConfigs) {
    for (const [serverName, customConfig] of Object.entries(options.customServerConfigs)) {
      if (config.mcpServers[serverName]) {
        config.mcpServers[serverName] = {
          ...config.mcpServers[serverName],
          ...customConfig,
        };
      }
    }
  }

  return config;
}

/**
 * Create and write MCP configuration file for Slack
 */
export async function createSlackMcpConfigFile(
  options: SlackMcpServerOptions,
  outputPath?: string,
): Promise<string> {
  const config = generateSlackMcpConfig(options);
  
  // Default output path
  const configPath = outputPath || path.join(
    process.env.RUNNER_TEMP || "/tmp",
    "slack-mcp-config.json"
  );

  // Ensure directory exists
  await mkdir(path.dirname(configPath), { recursive: true });

  // Write configuration file
  await writeFile(configPath, JSON.stringify(config, null, 2));

  console.log(`Slack MCP configuration written to: ${configPath}`);
  return configPath;
}

/**
 * Get environment variables for Slack MCP configuration
 */
export function getSlackMcpEnvironment(
  options: SlackMcpServerOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    SLACK_BOT_TOKEN: options.slackToken,
  };

  if (options.trackingChannelId) {
    env.SLACK_TRACKING_CHANNEL_ID = options.trackingChannelId;
  }

  if (options.trackingMessageTs) {
    env.SLACK_TRACKING_MESSAGE_TS = options.trackingMessageTs;
  }

  if (options.includeGitHubFileOps) {
    const githubToken = process.env.GITHUB_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (githubToken) {
      env.GITHUB_TOKEN = githubToken;
    }
  }

  return env;
}

/**
 * Validate Slack MCP configuration
 */
export function validateSlackMcpConfig(config: SlackMcpConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.mcpServers) {
    errors.push("Missing mcpServers configuration");
    return { valid: false, errors };
  }

  // Check for required Slack message server
  if (!config.mcpServers["slack-message"]) {
    errors.push("Missing required 'slack-message' server configuration");
  } else {
    const slackServer = config.mcpServers["slack-message"];
    if (!slackServer.command) {
      errors.push("Slack message server missing 'command' field");
    }
    if (!slackServer.env?.SLACK_BOT_TOKEN) {
      errors.push("Slack message server missing 'SLACK_BOT_TOKEN' environment variable");
    }
  }

  // Validate other servers
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if (!serverConfig.command) {
      errors.push(`Server '${serverName}' missing 'command' field`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get default Slack MCP server options from environment
 */
export function getDefaultSlackMcpOptions(): Partial<SlackMcpServerOptions> {
  return {
    slackToken: process.env.SLACK_BOT_TOKEN || process.env.SLACK_TOKEN || "",
    trackingChannelId: process.env.SLACK_TRACKING_CHANNEL_ID,
    trackingMessageTs: process.env.SLACK_TRACKING_MESSAGE_TS,
    includeGitHubFileOps: process.env.INCLUDE_GITHUB_FILE_OPS === "true",
  };
}

/**
 * Create MCP configuration with validation
 */
export async function setupSlackMcpConfiguration(
  options: Partial<SlackMcpServerOptions> = {},
): Promise<{ configPath: string; config: SlackMcpConfig }> {
  // Merge with defaults
  const defaultOptions = getDefaultSlackMcpOptions();
  const mergedOptions = { ...defaultOptions, ...options } as SlackMcpServerOptions;

  // Validate required options
  if (!mergedOptions.slackToken) {
    throw new Error("Slack token is required for MCP configuration");
  }

  // Generate configuration
  const config = generateSlackMcpConfig(mergedOptions);

  // Validate configuration
  const validation = validateSlackMcpConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid MCP configuration: ${validation.errors.join(", ")}`);
  }

  // Create configuration file
  const configPath = await createSlackMcpConfigFile(mergedOptions);

  return { configPath, config };
}

/**
 * Update MCP configuration with new tracking information
 */
export async function updateSlackMcpTracking(
  configPath: string,
  channelId: string,
  messageTs: string,
): Promise<void> {
  try {
    // Read existing configuration
    const configContent = await Bun.file(configPath).text();
    const config: SlackMcpConfig = JSON.parse(configContent);

    // Update Slack message server environment
    if (config.mcpServers["slack-message"]) {
      config.mcpServers["slack-message"].env = {
        ...config.mcpServers["slack-message"].env,
        SLACK_TRACKING_CHANNEL_ID: channelId,
        SLACK_TRACKING_MESSAGE_TS: messageTs,
      };

      // Write updated configuration
      await writeFile(configPath, JSON.stringify(config, null, 2));
      console.log(`Updated MCP tracking info: ${channelId}/${messageTs}`);
    }
  } catch (error) {
    console.error("Failed to update MCP tracking info:", error);
    // Don't throw, as this is not critical for operation
  }
}