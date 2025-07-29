#!/usr/bin/env bun
import type { SessionContext, ConversationMessage } from "./types";
export interface PromptContext {
    platform: string;
    channelId: string;
    userId: string;
    userDisplayName?: string;
    threadContext?: boolean;
    workingDirectory?: string;
    repositoryUrl?: string;
    customInstructions?: string;
}
/**
 * Create prompt file with conversation context
 */
export declare function createPromptFile(context: SessionContext, conversation?: ConversationMessage[]): Promise<string>;
/**
 * Create simple prompt file for basic requests (backward compatibility)
 */
export declare function createSimplePromptFile(userRequest: string): Promise<string>;
//# sourceMappingURL=prompt-generation.d.ts.map