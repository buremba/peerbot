#!/usr/bin/env bun
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlackEventHandlers = void 0;
const core_runner_1 = require("@claude-code-slack/core-runner");
class SlackEventHandlers {
    app;
    jobManager;
    repoManager;
    config;
    activeSessions = new Map();
    userMappings = new Map(); // slackUserId -> githubUsername
    constructor(app, jobManager, repoManager, config) {
        this.app = app;
        this.jobManager = jobManager;
        this.repoManager = repoManager;
        this.config = config;
        this.setupEventHandlers();
    }
    /**
     * Setup Slack event handlers
     */
    setupEventHandlers() {
        // Handle app mentions
        this.app.event("app_mention", async ({ event, client, say }) => {
            try {
                const context = this.extractSlackContext(event);
                // Check permissions
                if (!this.isUserAllowed(context.userId)) {
                    await say({
                        thread_ts: context.threadTs,
                        text: "Sorry, you don't have permission to use this bot.",
                    });
                    return;
                }
                // Extract user request (remove bot mention)
                const userRequest = this.extractUserRequest(context.text);
                await this.handleUserRequest(context, userRequest, client);
            }
            catch (error) {
                console.error("Error handling app mention:", error);
                await say({
                    thread_ts: event.thread_ts,
                    text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
                });
            }
        });
        // Handle direct messages
        this.app.message(async ({ message, client, say }) => {
            // Only handle direct messages, not channel messages
            if (message.channel_type !== "im")
                return;
            try {
                const context = this.extractSlackContext(message);
                // Check permissions
                if (!this.isUserAllowed(context.userId)) {
                    await say("Sorry, you don't have permission to use this bot.");
                    return;
                }
                const userRequest = context.text;
                await this.handleUserRequest(context, userRequest, client);
            }
            catch (error) {
                console.error("Error handling direct message:", error);
                await say(`❌ Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`);
            }
        });
    }
    /**
     * Handle user request by routing to appropriate worker
     */
    async handleUserRequest(context, userRequest, client) {
        // Generate session key (thread-based or new)
        const sessionKey = core_runner_1.SessionManager.generateSessionKey({
            platform: "slack",
            channelId: context.channelId,
            userId: context.userId,
            userDisplayName: context.userDisplayName,
            teamId: context.teamId,
            threadTs: context.threadTs,
            messageTs: context.messageTs,
        });
        console.log(`Handling request for session: ${sessionKey}`);
        // Check if session is already active
        const existingSession = this.activeSessions.get(sessionKey);
        if (existingSession && existingSession.status === "running") {
            await client.chat.postMessage({
                channel: context.channelId,
                thread_ts: context.threadTs,
                text: "⏳ I'm already working on this thread. Please wait for the current task to complete.",
            });
            return;
        }
        try {
            // Get or create user's GitHub username mapping
            const username = await this.getOrCreateUserMapping(context.userId, client);
            // Ensure user repository exists
            const repository = await this.repoManager.ensureUserRepository(username);
            // Post initial response
            const initialResponse = await client.chat.postMessage({
                channel: context.channelId,
                thread_ts: context.threadTs,
                text: this.formatInitialResponse(sessionKey, username, repository.repositoryUrl),
            });
            // Create thread session
            const threadSession = {
                sessionKey,
                threadTs: context.threadTs,
                channelId: context.channelId,
                userId: context.userId,
                username,
                repositoryUrl: repository.repositoryUrl,
                lastActivity: Date.now(),
                status: "pending",
                createdAt: Date.now(),
            };
            this.activeSessions.set(sessionKey, threadSession);
            // Prepare worker job request
            const jobRequest = {
                sessionKey,
                userId: context.userId,
                username,
                channelId: context.channelId,
                threadTs: context.threadTs,
                userPrompt: userRequest,
                repositoryUrl: repository.repositoryUrl,
                slackResponseChannel: context.channelId,
                slackResponseTs: initialResponse.ts,
                claudeOptions: {
                    ...this.config.claude,
                    timeoutMinutes: this.config.sessionTimeoutMinutes.toString(),
                },
                recoveryMode: !!context.threadTs, // Recover if this is a thread
            };
            // Start worker job
            const jobName = await this.jobManager.createWorkerJob(jobRequest);
            // Update session with job info
            threadSession.jobName = jobName;
            threadSession.status = "starting";
            console.log(`Created worker job ${jobName} for session ${sessionKey}`);
        }
        catch (error) {
            console.error(`Failed to handle request for session ${sessionKey}:`, error);
            // Post error message
            await client.chat.postMessage({
                channel: context.channelId,
                thread_ts: context.threadTs,
                text: `❌ **Error:** ${error instanceof Error ? error.message : "Unknown error occurred"}`,
            });
            // Clean up session
            this.activeSessions.delete(sessionKey);
        }
    }
    /**
     * Extract Slack context from event
     */
    extractSlackContext(event) {
        return {
            channelId: event.channel,
            userId: event.user,
            teamId: event.team || "",
            threadTs: event.thread_ts,
            messageTs: event.ts,
            text: event.text || "",
        };
    }
    /**
     * Extract user request from mention text
     */
    extractUserRequest(text) {
        // Remove bot mention and clean up text
        const triggerPhrase = this.config.slack.triggerPhrase || "@peerbotai";
        // Remove the trigger phrase and clean up
        let cleaned = text.replace(new RegExp(`<@[^>]+>|${triggerPhrase}`, "gi"), "").trim();
        if (!cleaned) {
            return "Hello! How can I help you today?";
        }
        return cleaned;
    }
    /**
     * Check if user is allowed to use the bot
     */
    isUserAllowed(userId) {
        const { allowedUsers, blockedUsers } = this.config.slack;
        // Check blocked users first
        if (blockedUsers?.includes(userId)) {
            return false;
        }
        // If allowedUsers is specified, user must be in the list
        if (allowedUsers && allowedUsers.length > 0) {
            return allowedUsers.includes(userId);
        }
        // Default to allow if no restrictions specified
        return true;
    }
    /**
     * Get or create GitHub username mapping for Slack user
     */
    async getOrCreateUserMapping(slackUserId, client) {
        // Check if mapping already exists
        const existingMapping = this.userMappings.get(slackUserId);
        if (existingMapping) {
            return existingMapping;
        }
        // Get user info from Slack
        try {
            const userInfo = await client.users.info({ user: slackUserId });
            const user = userInfo.user;
            // Try to use Slack display name or real name as GitHub username
            let username = user.profile?.display_name || user.profile?.real_name || user.name;
            // Clean up username for GitHub (remove spaces, special chars, etc.)
            username = username.toLowerCase()
                .replace(/[^a-z0-9-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "");
            // Ensure username is valid and unique
            username = `user-${username}`;
            // Store mapping
            this.userMappings.set(slackUserId, username);
            console.log(`Created user mapping: ${slackUserId} -> ${username}`);
            return username;
        }
        catch (error) {
            console.error(`Failed to get user info for ${slackUserId}:`, error);
            // Fallback to generic username
            const fallbackUsername = `user-${slackUserId.substring(0, 8)}`;
            this.userMappings.set(slackUserId, fallbackUsername);
            return fallbackUsername;
        }
    }
    /**
     * Format initial response message
     */
    formatInitialResponse(sessionKey, username, repositoryUrl) {
        const workerId = `claude-worker-${sessionKey.substring(0, 8)}`;
        return `🤖 **Claude is working on your request...**

**Worker Environment:**
• Pod: \`${workerId}\`
• Namespace: \`${this.config.kubernetes.namespace}\`
• CPU: \`${this.config.kubernetes.cpu}\` Memory: \`${this.config.kubernetes.memory}\`
• Timeout: \`${this.config.sessionTimeoutMinutes} minutes\`
• Repository: \`${username}\`

**GitHub Workspace:**
• Repository: [${username}](${repositoryUrl})
• 📝 [Edit on GitHub.dev](${repositoryUrl.replace('github.com', 'github.dev')})
• 🔄 [Compare & PR](${repositoryUrl}/compare)

*Progress updates will appear below...*`;
    }
    /**
     * Handle job completion notification
     */
    async handleJobCompletion(sessionKey, success, message) {
        const session = this.activeSessions.get(sessionKey);
        if (!session)
            return;
        session.status = success ? "completed" : "error";
        session.lastActivity = Date.now();
        // Log completion
        console.log(`Job completed for session ${sessionKey}: ${success ? "success" : "failure"}`);
        // Clean up session after some time
        setTimeout(() => {
            this.activeSessions.delete(sessionKey);
        }, 60000); // Clean up after 1 minute
    }
    /**
     * Handle job timeout
     */
    async handleJobTimeout(sessionKey) {
        const session = this.activeSessions.get(sessionKey);
        if (!session)
            return;
        session.status = "timeout";
        session.lastActivity = Date.now();
        console.log(`Job timed out for session ${sessionKey}`);
        // Clean up immediately
        this.activeSessions.delete(sessionKey);
    }
    /**
     * Get active sessions for monitoring
     */
    getActiveSessions() {
        return Array.from(this.activeSessions.values());
    }
    /**
     * Get session count
     */
    getActiveSessionCount() {
        return this.activeSessions.size;
    }
    /**
     * Cleanup all sessions
     */
    cleanup() {
        this.activeSessions.clear();
        this.userMappings.clear();
    }
}
exports.SlackEventHandlers = SlackEventHandlers;
//# sourceMappingURL=event-handlers.js.map