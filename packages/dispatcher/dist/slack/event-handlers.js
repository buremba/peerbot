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
                // Check if we have a valid user ID
                if (!context.userId) {
                    console.error("No user ID found in app_mention event:", event);
                    await say({
                        thread_ts: context.threadTs,
                        text: "❌ Error: Unable to identify user. Please try again.",
                    });
                    return;
                }
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
                // Check if we have a valid user ID
                if (!context.userId) {
                    console.error("No user ID found in message event:", message);
                    await say("❌ Error: Unable to identify user. Please try again.");
                    return;
                }
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
            // Update the initial message with job details
            const updatedMessage = this.formatInitialResponse(sessionKey, username, repository.repositoryUrl, jobName);
            await client.chat.update({
                channel: context.channelId,
                ts: initialResponse.ts,
                text: updatedMessage,
            });
        }
        catch (error) {
            console.error(`Failed to handle request for session ${sessionKey}:`, error);
            // Format error message with debugging info
            let errorMessage = `❌ **Error:** ${error instanceof Error ? error.message : "Unknown error occurred"}`;
            // If we have a job name, add debugging commands
            const session = this.activeSessions.get(sessionKey);
            if (session?.jobName) {
                errorMessage += `\n\n${this.formatKubectlCommands(session.jobName, this.config.kubernetes.namespace)}`;
            }
            // Add generic debugging tips
            errorMessage += `\n\n**💡 Troubleshooting Tips:**
• Check dispatcher logs: \`kubectl logs -n ${this.config.kubernetes.namespace} -l app.kubernetes.io/component=dispatcher --tail=100\`
• Check events: \`kubectl get events -n ${this.config.kubernetes.namespace} --sort-by='.lastTimestamp'\`
• Check job quota: \`kubectl describe resourcequota -n ${this.config.kubernetes.namespace}\``;
            // Post error message
            await client.chat.postMessage({
                channel: context.channelId,
                thread_ts: context.threadTs,
                text: errorMessage,
            });
            // Clean up session
            this.activeSessions.delete(sessionKey);
        }
    }
    /**
     * Extract Slack context from event
     */
    extractSlackContext(event) {
        // Debug log to understand the event structure
        console.log("Slack event structure:", JSON.stringify({
            type: event.type,
            subtype: event.subtype,
            user: event.user,
            channel: event.channel,
            channel_type: event.channel_type,
            bot_id: event.bot_id,
            text: event.text?.substring(0, 50) + "..."
        }));
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
        const triggerPhrase = "@peerbotai";
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
        // Handle undefined user ID
        if (!slackUserId) {
            console.error("Slack user ID is undefined");
            return "user-unknown";
        }
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
            const fallbackUsername = slackUserId ? `user-${slackUserId.substring(0, 8)}` : "user-unknown";
            if (slackUserId) {
                this.userMappings.set(slackUserId, fallbackUsername);
            }
            return fallbackUsername;
        }
    }
    /**
     * Format initial response message
     */
    formatInitialResponse(sessionKey, username, repositoryUrl, jobName) {
        const workerId = jobName || `claude-worker-${sessionKey.substring(0, 8)}`;
        const namespace = this.config.kubernetes.namespace;
        // Get commit ID from environment or use a default
        const commitId = process.env.GITHUB_SHA?.substring(0, 7) || process.env.GIT_COMMIT?.substring(0, 7) || 'unknown';
        let message = `🤖 **Claude is working on your request...**

**Worker Environment:**
• Pod: \`${workerId}\`
• Namespace: \`${namespace}\`
• CPU: \`${this.config.kubernetes.cpu}\` Memory: \`${this.config.kubernetes.memory}\`
• Timeout: \`${this.config.sessionTimeoutMinutes} minutes\`
• Repository: \`${username}\`
• Commit: \`${commitId}\`

**GitHub Workspace:**
• Repository: [${username}](${repositoryUrl})
• 📝 [Edit on GitHub.dev](${repositoryUrl.replace('github.com', 'github.dev')})
• 🔄 [Compare & PR](${repositoryUrl}/compare)`;
        if (jobName) {
            message += `

**📊 Monitor Progress:**
• \`kubectl logs -n ${namespace} job/${jobName} -f\`
• \`kubectl describe job/${jobName} -n ${namespace}\`
• \`kubectl get pods -n ${namespace} -l job-name=${jobName}\``;
            // Add Google Cloud Console link if on GKE
            const projectId = process.env.GOOGLE_CLOUD_PROJECT || "spile-461023";
            message += `

**🔗 Quick Links:**
• [GKE Workloads](https://console.cloud.google.com/kubernetes/workload/overview?project=${projectId}&pageState=(%22savedViews%22:(%22i%22:%225d96be3b8e484ad689354ab3fe0f7b4f%22,%22c%22:%5B%5D,%22n%22:%5B%22${namespace}%22%5D)))
• [Cloud Logging](https://console.cloud.google.com/logs/query;query=resource.type%3D%22k8s_pod%22%0Aresource.labels.namespace_name%3D%22${namespace}%22%0Aresource.labels.pod_name%3D~%22${jobName}.*%22?project=${projectId})`;
        }
        message += `

*Progress updates will appear below...*`;
        return message;
    }
    /**
     * Format kubectl commands for debugging
     */
    formatKubectlCommands(jobName, namespace) {
        return `
**🛠️ Debugging Commands:**
\`\`\`bash
# Watch job logs in real-time
kubectl logs -n ${namespace} job/${jobName} -f

# Get job status
kubectl get job/${jobName} -n ${namespace} -o wide

# Get pod details
kubectl get pods -n ${namespace} -l job-name=${jobName} -o wide

# Describe job for events
kubectl describe job/${jobName} -n ${namespace}

# Get pod logs if job failed
kubectl logs -n ${namespace} -l job-name=${jobName} --tail=100
\`\`\``;
    }
    /**
     * Handle job completion notification
     */
    async handleJobCompletion(sessionKey, success) {
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