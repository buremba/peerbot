import { generateWorkerToken } from "@lobu/core";
import { AUTOMATION_RUN_SOURCE } from "../automation-run-session.js";

export interface AutomationRunWorkerAccess {
  conversationId: string;
  token: string;
  expiresAt: number;
}

function workerTokenTtlMs(): number {
  const raw = Number.parseInt(process.env.WORKER_TOKEN_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 60 * 1000;
}

/**
 * Mint the exact WorkerToken identity used by a verified Automation Agent API
 * session. Device-pinned Automations use this same identity for lobu-memory MCP
 * access; the device PAT remains poll/lifecycle-only and never crosses orgs.
 */
export function buildAutomationRunWorkerAccess(args: {
  agentId: string;
  automationId: number;
  runId: number;
  organizationId: string;
  conversationId?: string;
}): AutomationRunWorkerAccess {
  const expectedConversationId = `${args.agentId}_automation_${args.automationId}_run_${args.runId}`;
  const conversationId = args.conversationId ?? expectedConversationId;
  if (conversationId !== expectedConversationId) {
    throw new Error(
      `Automation conversation mismatch: expected ${expectedConversationId}, got ${conversationId}`
    );
  }

  const userId = `automation_${args.automationId}`;
  const channelId = `api_${userId}`;
  const deploymentName = `api-${args.agentId.slice(0, 8)}`;

  const issuedAt = Date.now();
  return {
    conversationId,
    expiresAt: issuedAt + workerTokenTtlMs(),
    token: generateWorkerToken(args.agentId, conversationId, deploymentName, {
      channelId,
      agentId: args.agentId,
      organizationId: args.organizationId,
      platform: "api",
      source: AUTOMATION_RUN_SOURCE,
      sessionKey: userId,
    }),
  };
}
