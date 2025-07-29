#!/usr/bin/env bun
export interface ClaudeExecutionOptions {
    allowedTools?: string;
    disallowedTools?: string;
    maxTurns?: string;
    mcpConfig?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    claudeEnv?: string;
    fallbackModel?: string;
    timeoutMinutes?: string;
    model?: string;
}
export interface ClaudeExecutionResult {
    success: boolean;
    exitCode: number;
    output: string;
    executionFile?: string;
    error?: string;
}
export interface ProgressUpdate {
    type: "output" | "completion" | "error";
    data: any;
    timestamp: number;
}
export type ProgressCallback = (update: ProgressUpdate) => Promise<void>;
export interface SessionContext {
    platform: "slack" | "github";
    channelId: string;
    userId: string;
    userDisplayName?: string;
    teamId?: string;
    threadTs?: string;
    messageTs: string;
    repositoryUrl?: string;
    workingDirectory?: string;
    customInstructions?: string;
}
export interface ConversationMessage {
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: number;
    metadata?: {
        messageTs?: string;
        threadTs?: string;
        userId?: string;
        progressUpdate?: ProgressUpdate;
    };
}
export interface SessionState {
    sessionKey: string;
    context: SessionContext;
    conversation: ConversationMessage[];
    createdAt: number;
    lastActivity: number;
    status: "active" | "idle" | "completed" | "error" | "timeout";
    workspaceInfo?: {
        repositoryUrl: string;
        branch: string;
        workingDirectory: string;
    };
    progress?: {
        currentStep?: string;
        totalSteps?: number;
        lastUpdate?: ProgressUpdate;
    };
}
export interface GcsConfig {
    bucketName: string;
    keyFile?: string;
    projectId?: string;
}
export interface ConversationMetadata {
    sessionKey: string;
    createdAt: number;
    lastActivity: number;
    messageCount: number;
    platform: string;
    userId: string;
    channelId: string;
    status: SessionState["status"];
}
export interface ThreadSession {
    sessionKey: string;
    threadTs: string;
    channelId: string;
    userId: string;
    workerId?: string;
    lastActivity: number;
    status: "pending" | "running" | "completed" | "error";
}
export interface WorkerConfig {
    workerId: string;
    namespace: string;
    image: string;
    cpu: string;
    memory: string;
    timeoutSeconds: number;
    env: Record<string, string>;
}
export interface WorkerJobSpec {
    sessionKey: string;
    userId: string;
    channelId: string;
    threadTs?: string;
    repositoryUrl: string;
    workingDirectory: string;
    userPrompt: string;
    claudeOptions: ClaudeExecutionOptions;
    slackResponseChannel: string;
    slackResponseTs: string;
}
export declare class SessionError extends Error {
    sessionKey: string;
    code: string;
    cause?: Error | undefined;
    constructor(sessionKey: string, code: string, message: string, cause?: Error | undefined);
}
export declare class GcsError extends Error {
    operation: string;
    cause?: Error | undefined;
    constructor(operation: string, message: string, cause?: Error | undefined);
}
export declare class WorkerError extends Error {
    workerId: string;
    operation: string;
    cause?: Error | undefined;
    constructor(workerId: string, operation: string, message: string, cause?: Error | undefined);
}
//# sourceMappingURL=types.d.ts.map