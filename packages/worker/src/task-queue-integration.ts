#!/usr/bin/env bun

import PgBoss from "pg-boss";
import { execSync } from "child_process";
import logger from "./logger";

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface ThreadResponsePayload {
  messageId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  content?: string;
  isDone: boolean;
  error?: string;
  timestamp: number;
  originalMessageTs?: string; // User's original message timestamp for reactions
  gitBranch?: string; // Current git branch for Edit button URLs
  botResponseTs?: string; // Bot's response message timestamp for updates
  envChanges?: boolean; // Flag indicating environment was modified
  modifiedFiles?: string[]; // Files changed (e.g. [".devcontainer/devcontainer.json"])
  currentCommit?: string; // Current git HEAD after changes
  repositoryUrl?: string; // Repository URL for rebuild context
}

export class QueueIntegration {
  private pgBoss: PgBoss;
  private isConnected = false;
  private responseChannel: string;
  private responseTs: string;
  private messageId: string;
  private botResponseTs?: string; // Track bot's response message timestamp
  private lastUpdateTime = 0;
  private updateQueue: string[] = [];
  private isProcessingQueue = false;
  private currentTodos: TodoItem[] = [];
  private currentToolExecution: string = "";
  // private lastToolUpdate: number = 0;
  // @ts-ignore - Used in showStopButton() and hideStopButton() methods
  private stopButtonVisible: boolean = false;
  private deploymentName?: string;
  private workspaceManager?: any; // WorkspaceManager dependency

  constructor(config: { 
    databaseUrl: string;
    responseChannel?: string; 
    responseTs?: string;
    messageId?: string;
    botResponseTs?: string;
    workspaceManager?: any;
  }) {
    this.pgBoss = new PgBoss(config.databaseUrl);
    this.workspaceManager = config.workspaceManager;
    
    // Get response location from config or environment
    this.responseChannel = config.responseChannel || process.env.SLACK_RESPONSE_CHANNEL!;
    this.responseTs = config.responseTs || process.env.INITIAL_SLACK_RESPONSE_TS || process.env.SLACK_RESPONSE_TS!;
    this.messageId = config.messageId || process.env.INITIAL_SLACK_MESSAGE_ID || process.env.SLACK_MESSAGE_ID!;
    this.botResponseTs = config.botResponseTs || process.env.BOT_RESPONSE_TS; // Bot's response message timestamp from config or env
    
    // Get deployment name from environment for stop button
    this.deploymentName = process.env.DEPLOYMENT_NAME;
    
    // Validate required values
    if (!this.responseChannel || !this.responseTs || !this.messageId) {
      const error = new Error(
        `Missing required response location - channel: "${this.responseChannel}", ts: "${this.responseTs}", messageId: "${this.messageId}"`
      );
      logger.error(`QueueIntegration initialization failed: ${error.message}`);
      throw error;
    }
    
    logger.info(`QueueIntegration initialized - channel: ${this.responseChannel}, ts: ${this.responseTs}, messageId: ${this.messageId}`);
  }

  /**
   * Start the queue connection
   */
  async start(): Promise<void> {
    try {
      await this.pgBoss.start();
      this.isConnected = true;
      
      // Create the thread_response queue if it doesn't exist
      await this.pgBoss.createQueue('thread_response');
      logger.info("✅ Queue integration started successfully");
    } catch (error) {
      logger.error("Failed to start queue integration:", error);
      throw error;
    }
  }

  /**
   * Stop the queue connection
   */
  async stop(): Promise<void> {
    try {
      this.isConnected = false;
      await this.pgBoss.stop();
      logger.info("✅ Queue integration stopped");
    } catch (error) {
      logger.error("Error stopping queue integration:", error);
      throw error;
    }
  }

  /**
   * Update progress message via queue
   */
  async updateProgress(content: string): Promise<void> {
    try {
      // Ensure we always have content to update with
      if (!content || content.trim() === "") {
        logger.warn("updateProgress called with empty content, using default message");
        content = "✅ Task completed";
      }
      
      // Rate limiting: don't update more than once every 2 seconds
      const now = Date.now();
      if (now - this.lastUpdateTime < 2000) {
        // Queue the update
        this.updateQueue.push(content);
        this.processQueue();
        return;
      }

      await this.performUpdate(content);
      this.lastUpdateTime = now;

    } catch (error) {
      logger.error("Failed to send progress update to queue:", error);
      // Don't throw - worker should continue even if queue updates fail
    }
  }

  /**
   * Update progress with optional environment change detection
   */
  async updateProgressWithEnvCheck(content: string, checkForEnvChanges: boolean = false): Promise<void> {
    try {
      // Ensure we always have content to update with
      if (!content || content.trim() === "") {
        logger.warn("updateProgressWithEnvCheck called with empty content, using default message");
        content = "✅ Task completed";
      }
      
      // Check for devcontainer changes if requested
      let envChangeInfo = null;
      if (checkForEnvChanges) {
        envChangeInfo = await this.detectDevcontainerChanges();
      }

      // Rate limiting: don't update more than once every 2 seconds
      const now = Date.now();
      if (now - this.lastUpdateTime < 2000) {
        // Queue the update with environment info
        this.updateQueue.push(JSON.stringify({ content, envChangeInfo }));
        this.processQueue();
        return;
      }

      await this.performUpdateWithEnv(content, envChangeInfo);
      this.lastUpdateTime = now;

    } catch (error) {
      logger.error("Failed to send progress update with env check to queue:", error);
      // Don't throw - worker should continue even if queue updates fail
    }
  }

  /**
   * Stream progress updates (for real-time Claude output)
   */
  async streamProgress(data: any): Promise<void> {
    try {
      // Handle both string and object data
      let dataToCheck: string;
      
      if (typeof data === "string" && data.trim()) {
        dataToCheck = data;
      } else if (typeof data === "object") {
        dataToCheck = JSON.stringify(data);
        logger.info(`📊 StreamProgress received object data: ${dataToCheck.substring(0, 200)}...`);
      } else {
        return;
      }
      
      // Priority 1: TodoWrite updates (full todo list refresh)
      const todoData = this.extractTodoList(dataToCheck);
      if (todoData) {
        this.currentTodos = todoData;
        this.currentToolExecution = ""; // Clear tool execution on todo update
        await this.updateProgressWithTodos();
        return;
      }
      
      // Priority 2: Tool execution tracking (between todo updates)
      const toolExecution = this.extractToolExecution(dataToCheck);
      if (toolExecution && toolExecution !== this.currentToolExecution) {
        logger.info(`🔧 Detected tool execution: ${toolExecution}`);
        this.currentToolExecution = toolExecution;
        // this.lastToolUpdate = Date.now();
        // Update with todos if available, otherwise show just the tool execution
        if (this.currentTodos.length > 0) {
          logger.info(`📝 Updating progress with todos + tool execution`);
          await this.updateProgressWithTodos();
        } else {
          logger.info(`🔧 Showing tool execution without todos: ${toolExecution}`);
          await this.updateProgress(toolExecution);
        }
        return;
      }
      
      // Priority 3: Regular content streaming
      if (typeof data === "string") {
        await this.updateProgress(data);
      } else if (typeof data === "object" && data.content) {
        await this.updateProgress(data.content);
      }
    } catch (error) {
      logger.error("Failed to stream progress:", error);
    }
  }

  /**
   * Process queued updates
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.updateQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      // Wait for rate limit, then send the latest update
      const delay = Math.max(0, 2000 - (Date.now() - this.lastUpdateTime));
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Get the latest update from queue
      const latestUpdate = this.updateQueue.pop();
      this.updateQueue = []; // Clear queue

      if (latestUpdate) {
        // Handle both string and JSON updates (for environment changes)
        try {
          const updateObj = JSON.parse(latestUpdate);
          if (updateObj.content && updateObj.envChangeInfo !== undefined) {
            await this.performUpdateWithEnv(updateObj.content, updateObj.envChangeInfo);
          } else {
            await this.performUpdate(latestUpdate);
          }
        } catch {
          // Not JSON, treat as regular string update
          await this.performUpdate(latestUpdate);
        }
        this.lastUpdateTime = Date.now();
      }

    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Get the current git branch name only if the session has made changes
   */
  private async getCurrentGitBranch(): Promise<string | undefined> {
    try {
      // If no workspace manager, fall back to old behavior
      if (!this.workspaceManager) {
        return this.getFallbackGitBranch();
      }

      // Check repository status
      const status = await this.workspaceManager.getRepositoryStatus();
      
      // Show Edit button if either:
      // 1. There are pending changes, OR
      // 2. We're on a session branch (claude/*) which means work was done
      const isSessionBranch = status.branch && status.branch.startsWith('claude/');
      
      if (status.hasChanges || isSessionBranch) {
        return status.branch;
      } else {
        logger.debug(`Git branch ${status.branch} has no changes and is not a session branch, skipping Edit button`);
        return undefined;
      }
      
    } catch (error) {
      logger.warn('Could not get git branch status from workspace manager:', error);
      return this.getFallbackGitBranch();
    }
  }

  /**
   * Fallback method for getting git branch (old behavior)
   */
  private getFallbackGitBranch(): string | undefined {
    try {
      // Use the workspace directory if USER_ID is available, otherwise fall back to process.cwd()
      const workspaceDir = process.env.USER_ID ? `/workspace/${process.env.USER_ID}` : process.cwd();
      
      const branch = execSync('git branch --show-current', { 
        encoding: 'utf-8',
        cwd: workspaceDir
      }).trim();
      
      if (!branch) {
        return undefined;
      }
      
      // Show Edit button if either:
      // 1. The branch has commits, OR  
      // 2. It's a session branch (claude/*) which indicates work was done
      const isSessionBranch = branch.startsWith('claude/');
      
      try {
        execSync('git log -1 --oneline', {
          encoding: 'utf-8',
          cwd: workspaceDir,
          stdio: 'pipe' // Suppress output
        });
        
        // Branch has commits
        logger.info(`Git branch: ${branch} (hasCommits: true, isSessionBranch: ${isSessionBranch})`);
        return branch;
      } catch (logError) {
        // No commits yet, but still show Edit button for session branches
        if (isSessionBranch) {
          return branch;
        } else {
          logger.debug(`Git branch ${branch} has no commits and is not a session branch, skipping Edit button`);
          return undefined;
        }
      }
      
    } catch (error) {
      logger.warn('Could not get current git branch:', error);
      return undefined;
    }
  }

  /**
   * Perform the actual queue update
   */
  private async performUpdate(content: string): Promise<void> {
    await this.performUpdateWithEnv(content, null);
  }

  /**
   * Perform queue update with optional environment change information
   */
  private async performUpdateWithEnv(content: string, envChangeInfo: { modifiedFiles: string[], currentCommit: string, repositoryUrl?: string } | null): Promise<void> {
    if (!this.isConnected) {
      logger.warn("Queue not connected, skipping update");
      return;
    }

    try {
      // Final safety check - ensure we have content
      if (!content || content.trim() === "") {
        logger.warn("performUpdateWithEnv called with empty content, using fallback");
        content = "✅ Task completed";
      }
      
      const payload: ThreadResponsePayload = {
        messageId: this.messageId,
        channelId: this.responseChannel,
        threadTs: this.responseTs,
        userId: process.env.USER_ID || 'unknown',
        content: content,
        isDone: false, // Agent is still running
        timestamp: Date.now(),
        originalMessageTs: process.env.ORIGINAL_MESSAGE_TS, // User's original message for reactions
        gitBranch: await this.getCurrentGitBranch(), // Current git branch for Edit button URLs
        botResponseTs: this.botResponseTs // Bot's response message for updates
      };

      // Add environment change information if present
      if (envChangeInfo) {
        payload.envChanges = true;
        payload.modifiedFiles = envChangeInfo.modifiedFiles;
        payload.currentCommit = envChangeInfo.currentCommit;
        payload.repositoryUrl = envChangeInfo.repositoryUrl;
        logger.info(`Including environment changes in progress update: ${envChangeInfo.modifiedFiles.join(', ')}`);
      }

      // Send to thread_response queue
      const priority = envChangeInfo ? 10 : 0; // Higher priority for environment changes
      const jobId = await this.pgBoss.send('thread_response', payload, {
        priority,
        retryLimit: 3,
        retryDelay: 5,
        expireInHours: 1,
      });

      const logMessage = envChangeInfo ? 
        `Sent progress update with env changes to queue with job id: ${jobId} - files: ${envChangeInfo.modifiedFiles.join(', ')}` :
        `Sent progress update to queue with job id: ${jobId}`;
      logger.info(logMessage);

    } catch (error: any) {
      logger.error("Failed to send update to thread_response queue:", error);
      throw error;
    }
  }

  // Reaction methods removed - dispatcher now handles reactions directly based on isDone status

  /**
   * Send typing indicator via queue
   */
  async sendTyping(): Promise<void> {
    try {
      // Show current todos if available, otherwise show thinking message
      if (this.currentTodos.length > 0) {
        await this.updateProgressWithTodos();
      } else {
        await this.updateProgress("💭 Peerbot is thinking...");
      }

    } catch (error) {
      logger.error("Failed to send typing indicator:", error);
    }
  }

  /**
   * Signal that the agent is done processing
   */
  async signalDone(finalMessage?: string): Promise<void> {
    if (!this.isConnected) {
      logger.warn("Queue not connected, skipping done signal");
      return;
    }

    try {
      const payload: ThreadResponsePayload = {
        messageId: this.messageId,
        channelId: this.responseChannel,
        threadTs: this.responseTs,
        userId: process.env.USER_ID || 'unknown',
        content: finalMessage,
        isDone: true, // Agent is done
        timestamp: Date.now(),
        originalMessageTs: process.env.ORIGINAL_MESSAGE_TS, // User's original message for reactions
        gitBranch: await this.getCurrentGitBranch(), // Current git branch for Edit button URLs
        botResponseTs: this.botResponseTs // Bot's response message for updates
      };

      const jobId = await this.pgBoss.send('thread_response', payload, {
        priority: 1, // Higher priority for completion signals
        retryLimit: 5,
        retryDelay: 5,
        expireInHours: 1,
      });
      
      logger.info(`Sent completion signal to queue with job id: ${jobId}`);

    } catch (error: any) {
      logger.error("Failed to send completion signal to queue:", error);
      throw error;
    }
  }

  /**
   * Signal that an error occurred
   */
  async signalError(error: Error): Promise<void> {
    if (!this.isConnected) {
      logger.warn("Queue not connected, skipping error signal");
      return;
    }

    try {
      const payload: ThreadResponsePayload = {
        messageId: this.messageId,
        channelId: this.responseChannel,
        threadTs: this.responseTs,
        userId: process.env.USER_ID || 'unknown',
        error: error.message,
        isDone: true, // Agent is done due to error
        timestamp: Date.now(),
        originalMessageTs: process.env.ORIGINAL_MESSAGE_TS, // User's original message for reactions
        gitBranch: await this.getCurrentGitBranch(), // Current git branch for Edit button URLs
        botResponseTs: this.botResponseTs // Bot's response message for updates
      };

      const jobId = await this.pgBoss.send('thread_response', payload, {
        priority: 1, // Higher priority for error signals
        retryLimit: 5,
        retryDelay: 5,
        expireInHours: 1,
      });
      
      logger.info(`Sent error signal to queue with job id: ${jobId}`);

    } catch (sendError: any) {
      logger.error("Failed to send error signal to queue:", sendError);
      // Don't throw here - we're already handling an error
    }
  }



  /**
   * Extract todo list from Claude's JSON output
   */
  private extractTodoList(data: string): TodoItem[] | null {
    try {
      const lines = data.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          const parsed = JSON.parse(line);
          
          // Check if this is a tool_use for TodoWrite
          if (parsed.type === "assistant" && parsed.message?.content) {
            for (const content of parsed.message.content) {
              if (content.type === "tool_use" && content.name === "TodoWrite" && content.input?.todos) {
                return content.input.todos;
              }
            }
          }
          
          // Check if this is a tool_result from TodoWrite
          if (parsed.type === "user" && parsed.message?.content) {
            for (const content of parsed.message.content) {
              if (content.type === "tool_result" && content.content?.includes("Todos have been modified successfully")) {
                // Try to extract todos from previous context
                return null; // Let the assistant message handle this
              }
            }
          }
        }
      }
    } catch (error) {
      // Not JSON or parsing failed
    }
    return null;
  }

  /**
   * Extract tool execution details from Claude's JSON output
   */
  private extractToolExecution(data: string): string | null {
    try {
      const lines = data.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          const parsed = JSON.parse(line);
          
          // Detect tool usage
          if (parsed.type === "assistant" && parsed.message?.content) {
            for (const content of parsed.message.content) {
              if (content.type === "tool_use") {
                return this.formatToolExecution(content);
              }
            }
          }
        }
      }
    } catch (e) {
      // Silently continue - not all lines are valid JSON
    }
    return null;
  }

  /**
   * Format tool execution for user-friendly display
   */
  private formatToolExecution(toolUse: any): string {
    const toolName = toolUse.name;
    const params = toolUse.input || {};
    
    switch (toolName) {
      case "Write":
        return `✏️ **Writing file:** \`${params.file_path}\``;
      case "Edit":
        return `✏️ **Editing file:** \`${params.file_path}\``;
      case "Bash":
        const command = params.command || params.description || "command";
        return `🔧 **Running:** \`${command.length > 50 ? command.substring(0, 50) + '...' : command}\``;
      case "Read":
        return `📖 **Reading file:** \`${params.file_path}\``;
      case "Grep":
        return `🔍 **Searching:** "${params.pattern}"`;
      case "TodoWrite":
        return "📝 **Updating task list...**";
      default:
        return `🔧 **Using tool:** ${toolName}`;
    }
  }

  /**
   * Update progress with todo list display
   */
  private async updateProgressWithTodos(): Promise<void> {
    if (this.currentTodos.length === 0) {
      await this.updateProgress("📝 Task list updated");
      return;
    }

    const todoDisplay = this.formatTodoList(this.currentTodos);
    await this.updateProgress(todoDisplay);
  }

  /**
   * Format todo list for display
   */
  private formatTodoList(todos: TodoItem[]): string {
    const todoLines = todos.map(todo => {
      const checkbox = todo.status === "completed" ? "☑️" : "☐";
      if(todo.status === "in_progress") {
        return `🪚 *${todo.content}*`;
      }
      return `${checkbox} ${todo.content}`;
    });

    let content = `📝 **Task Progress**\n\n${todoLines.join('\n')}`;
    
    // Add current tool execution if available
    if (this.currentToolExecution) {
      content += `\n\n${this.currentToolExecution}`;
    }
    
    return content;
  }

  /**
   * Show stop button in messages
   * Called when Claude worker starts processing
   */
  showStopButton(): void {
    this.stopButtonVisible = true;
    logger.info("Stop button enabled for deployment:", this.deploymentName);
  }

  /**
   * Hide stop button from messages
   * Called when Claude worker finishes or times out
   */
  hideStopButton(): void {
    this.stopButtonVisible = false;
    logger.info("Stop button disabled for deployment:", this.deploymentName);
  }

  /**
   * Cleanup queue integration
   */
  cleanup(): void {
    // Hide stop button before cleanup
    this.hideStopButton();
    
    // Clear any pending updates
    this.updateQueue = [];
    this.isProcessingQueue = false;
    this.currentTodos = [];
    this.currentToolExecution = "";
  }

  /**
   * Signal environment changes that require rebuild
   */
  async signalEnvironmentChange(modifiedFiles: string[], repositoryUrl?: string): Promise<void> {
    if (!this.isConnected) {
      logger.warn("Queue not connected, skipping environment change signal");
      return;
    }

    try {
      // Get current commit ID
      const currentCommit = await this.getCurrentCommitId();
      if (!currentCommit) {
        logger.warn("Could not determine current commit ID, skipping environment change signal");
        return;
      }

      const payload: ThreadResponsePayload = {
        messageId: `env-change-${Date.now()}`,
        channelId: this.responseChannel,
        threadTs: this.responseTs,
        userId: process.env.USER_ID || 'unknown',
        isDone: false,
        timestamp: Date.now(),
        envChanges: true,
        modifiedFiles,
        currentCommit,
        repositoryUrl: repositoryUrl || process.env.REPOSITORY_URL,
        originalMessageTs: process.env.ORIGINAL_MESSAGE_TS,
        botResponseTs: this.botResponseTs
      };

      const jobId = await this.pgBoss.send('thread_response', payload, {
        priority: 10, // Very high priority for environment changes
        retryLimit: 5,
        retryDelay: 5,
        expireInHours: 1,
      });
      
      logger.info(`Sent environment change signal to queue with job id: ${jobId} - files: ${modifiedFiles.join(', ')}`);

    } catch (error: any) {
      logger.error("Failed to send environment change signal to queue:", error);
      // Don't throw - worker should continue even if signal fails
    }
  }

  /**
   * Detect devcontainer changes and return change info (without sending separate signal)
   */
  async detectDevcontainerChanges(): Promise<{ modifiedFiles: string[], currentCommit: string, repositoryUrl?: string } | null> {
    try {
      const devcontainerFiles = [
        '.devcontainer/devcontainer.json',
        '.devcontainer.json',
        'devcontainer.json'
      ];

      const modifiedFiles: string[] = [];

      // Check if any devcontainer files were modified
      for (const file of devcontainerFiles) {
        if (await this.isFileRecentlyModified(file)) {
          logger.info(`Devcontainer change detected in ${file}`);
          modifiedFiles.push(file);
        }
      }

      if (modifiedFiles.length === 0) {
        return null;
      }

      // Get current commit ID
      const currentCommit = await this.getCurrentCommitId();
      if (!currentCommit) {
        logger.warn("Could not determine current commit ID for devcontainer changes");
        return null;
      }

      return {
        modifiedFiles,
        currentCommit,
        repositoryUrl: process.env.REPOSITORY_URL
      };

    } catch (error) {
      logger.warn('Failed to detect devcontainer changes:', error);
      return null;
    }
  }

  /**
   * Check for devcontainer changes and signal if needed (deprecated - use updateProgressWithEnvCheck)
   */
  async checkAndSignalDevcontainerChanges(): Promise<void> {
    try {
      const envChangeInfo = await this.detectDevcontainerChanges();
      if (envChangeInfo) {
        await this.signalEnvironmentChange(envChangeInfo.modifiedFiles, envChangeInfo.repositoryUrl);
      }
    } catch (error) {
      logger.warn('Failed to check for devcontainer changes:', error);
    }
  }

  /**
   * Get current git commit ID
   */
  private async getCurrentCommitId(): Promise<string | null> {
    try {
      const workspaceDir = process.env.USER_ID ? `/workspace/${process.env.USER_ID}` : process.cwd();
      
      const commitId = execSync('git rev-parse HEAD', { 
        encoding: 'utf-8',
        cwd: workspaceDir
      }).trim();
      
      return commitId || null;
    } catch (error) {
      logger.warn('Could not get current commit ID:', error);
      return null;
    }
  }

  /**
   * Check if a file was recently modified (within the last session)
   */
  private async isFileRecentlyModified(filePath: string): Promise<boolean> {
    try {
      const workspaceDir = process.env.USER_ID ? `/workspace/${process.env.USER_ID}` : process.cwd();
      const fullPath = `${workspaceDir}/${filePath}`;
      
      // Check if file exists
      try {
        await import('fs').then(fs => fs.promises.access(fullPath));
      } catch {
        return false; // File doesn't exist
      }

      // Check git status to see if file has uncommitted changes
      const status = execSync(`git status --porcelain "${filePath}"`, {
        encoding: 'utf-8',
        cwd: workspaceDir,
        stdio: 'pipe'
      }).trim();

      // File is modified if it appears in git status
      return status.length > 0;
      
    } catch (error) {
      logger.debug(`Could not check modification status for ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Check if queue integration is connected
   */
  isHealthy(): boolean {
    return this.isConnected;
  }
}