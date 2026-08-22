import { createHash } from 'node:crypto';
import { currentMcpActivityAttribution } from '../lobu/stores/mcp-client-conversations';
import type { ToolContext } from '../tools/registry';

type BrowserActionContext = {
  id: string;
  title: string;
  flow_id: string;
  kind: 'automation' | 'conversation' | 'mcp' | 'run';
};

function shortDigest(parts: Array<string | null | undefined>): string {
  return createHash('sha256')
    .update(parts.map((part) => part ?? '').join('\0'))
    .digest('hex')
    .slice(0, 12);
}

function positiveRunId(value: unknown): number | null {
  const runId = Number(value);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

export function runScopedBrowserActionContext(runIdValue: unknown): BrowserActionContext {
  const runId = positiveRunId(runIdValue);
  if (runId == null) throw new Error('Browser action context requires a positive run id.');
  return {
    id: `run:${runId}`,
    title: `Owletto · Run ${runId}`,
    flow_id: String(runId),
    kind: 'run',
  };
}

export function browserContextWithFlow(
  context: BrowserActionContext,
  runIdValue: unknown
): BrowserActionContext {
  const runId = positiveRunId(runIdValue);
  if (runId == null) throw new Error('Browser flow ownership requires a positive run id.');
  return { ...context, flow_id: String(runId) };
}

export function browserActionContextFromMetadata(
  metadata: unknown
): BrowserActionContext | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).browser_context;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.title !== 'string' ||
    !record.title ||
    typeof record.flow_id !== 'string' ||
    !record.flow_id ||
    !['automation', 'conversation', 'mcp', 'run'].includes(String(record.kind))
  ) {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    flow_id: record.flow_id,
    kind: record.kind as BrowserActionContext['kind'],
  };
}

export function deriveBrowserActionContext(ctx: ToolContext): BrowserActionContext | null {
  const automationId = positiveRunId(ctx.actingAutomationId);
  const actingRunId = positiveRunId(ctx.actingRunId);
  if (automationId != null && actingRunId != null) {
    return {
      id: `automation:${actingRunId}`,
      title: `Owletto · Automation ${automationId} · Run ${actingRunId}`,
      flow_id: String(actingRunId),
      kind: 'automation',
    };
  }

  const sourceConversationId = ctx.sourceContext?.conversationId?.trim();
  if (sourceConversationId) {
    const digest = shortDigest([
      ctx.organizationId,
      ctx.sourceContext?.platform,
      ctx.sourceContext?.connectionId,
      ctx.sourceContext?.teamId,
      ctx.sourceContext?.channelId,
      sourceConversationId,
    ]);
    const id = `conversation:${digest}`;
    return {
      id,
      title: `Owletto · Conversation ${digest}`,
      flow_id: id,
      kind: 'conversation',
    };
  }

  const activity = currentMcpActivityAttribution(ctx);
  if (activity) {
    const digest = shortDigest([
      ctx.organizationId,
      activity.clientIdentity,
      activity.activityKind,
      activity.activityId,
    ]);
    const id = `mcp:${digest}`;
    return {
      id,
      title: `Owletto · MCP ${digest}`,
      flow_id: id,
      kind: 'mcp',
    };
  }

  return null;
}

export function trustedChromeActionInput(
  input: Record<string, unknown>,
  context: BrowserActionContext
): Record<string, unknown> {
  const trusted = { ...input };
  delete trusted.browser_context_id;
  delete trusted.browser_context_title;
  delete trusted.browser_flow_id;
  delete trusted.holder_run_id;
  delete trusted.parent_run_id;
  return {
    ...trusted,
    browser_context_id: context.id,
    browser_context_title: context.title,
    browser_flow_id: context.flow_id,
    holder_run_id: context.flow_id,
  };
}
