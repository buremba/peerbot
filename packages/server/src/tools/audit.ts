import { createHash, randomUUID } from 'node:crypto';
import { deepRedactSecrets } from '@lobu/core';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { AUDIT_SEMANTIC_TYPE } from './constants';
import type { ToolContext } from './registry';

const MAX_PREVIEW_CHARS = 500;
// The value alternatives must consume the COMPLETE credential: a quoted string
// up to its closing quote (spaces included), otherwise an unquoted run that
// does not stop at commas — stopping early leaks the remainder into the
// preview. Over-consumption is fine here (previews are display-only; identity
// comes from the hash), partial redaction is not.
const SENSITIVE_ASSIGNMENT_RE =
  /(api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s'"}]+)/gi;
const AUTH_SCHEME_RE = /\b(bearer|basic|digest)\s+[a-z0-9._~+/=:-]+/gi;

interface ToolInvocationAuditParams {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  durationMs: number;
  ctx: ToolContext;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redactSensitiveText(value: string): string {
  return value
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, key: string) => `${key}=[redacted]`);
}

function redactPreview(value: string): string {
  return redactSensitiveText(value.slice(0, MAX_PREVIEW_CHARS));
}

function stringifyRedacted(value: unknown): string {
  return JSON.stringify(deepRedactSecrets(value), (_key, nestedValue) =>
    typeof nestedValue === 'string' ? redactSensitiveText(nestedValue) : nestedValue
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorPayload(
  error: unknown,
  fallbackName: string = 'Error'
): Record<string, unknown> | null {
  if (!error) return null;
  if (error instanceof Error) {
    return { name: error.name, message: redactPreview(error.message) };
  }
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : fallbackName,
      message:
        typeof record.message === 'string'
          ? redactPreview(record.message)
          : stringifyRedacted(record).slice(0, MAX_PREVIEW_CHARS),
    };
  }
  return { name: fallbackName, message: redactPreview(String(error)) };
}

function buildPayload(params: ToolInvocationAuditParams): Record<string, unknown> | null {
  const result = asObject(params.result);
  const toolError = params.error ? errorPayload(params.error) : null;

  if (params.toolName === 'run_sdk') {
    const script = typeof params.args.script === 'string' ? params.args.script : '';
    const resultError = errorPayload(result.error);
    return {
      tool_name: params.toolName,
      dry_run: params.args.dry_run === true,
      script_sha256: script ? sha256(script) : null,
      script_preview_redacted: script ? redactPreview(script) : null,
      sdk_call_count: typeof result.sdk_calls === 'number' ? result.sdk_calls : null,
      sdk_call_trace: Array.isArray(result.sdk_call_trace) ? result.sdk_call_trace : [],
      side_effect_preview: Array.isArray(result.side_effect_preview)
        ? result.side_effect_preview
        : [],
      side_effect_count: Array.isArray(result.side_effect_preview)
        ? result.side_effect_preview.length
        : 0,
      success: toolError ? false : result.success === true,
      error: toolError ?? resultError,
      duration_ms: params.durationMs,
    };
  }

  if (params.toolName === 'query_sql') {
    const sql = typeof params.args.sql === 'string' ? params.args.sql : '';
    const resultError =
      typeof result.error === 'string'
        ? { name: 'QuerySqlError', message: redactPreview(result.error) }
        : null;
    return {
      tool_name: params.toolName,
      sql_sha256: sql ? sha256(sql) : null,
      sql_preview_redacted: sql ? redactPreview(sql) : null,
      // The event stays in the bound org, so retain the requested target.
      org_slug: typeof params.args.org_slug === 'string' ? params.args.org_slug : null,
      sort_by: typeof params.args.sort_by === 'string' ? params.args.sort_by : null,
      sort_order: params.args.sort_order === 'desc' ? 'desc' : 'asc',
      limit: typeof params.args.limit === 'number' ? params.args.limit : null,
      offset: typeof params.args.offset === 'number' ? params.args.offset : null,
      row_count: Array.isArray(result.rows) ? result.rows.length : 0,
      total_count: typeof result.total_count === 'number' ? result.total_count : null,
      success: !(toolError || resultError),
      error: toolError ?? resultError,
      duration_ms: params.durationMs,
    };
  }

  // Browser-session and anonymous reads would generate an event per page view;
  // only externally authenticated calls belong in the client activity ledger.
  if (params.ctx.tokenType !== 'oauth' && params.ctx.tokenType !== 'pat') {
    return null;
  }
  // Hash the REDACTED serialization: the raw one would persist an unsalted
  // credential-derived digest whenever args carry a secret (manage_connections
  // tokens etc.), letting a candidate secret be verified against the ledger.
  // The hash identifies the call shape, so redacted input serves it fully.
  const redactedArgsJson = stringifyRedacted(params.args ?? {});
  const resultError = errorPayload(result.error, 'ToolError');
  const reportedFailure =
    result.success === false ||
    result.status === 'failed' ||
    result.status === 'error' ||
    result.status === 'timeout';
  const softError =
    resultError ??
    (reportedFailure
      ? errorPayload(
          result.error_message ?? result.message ?? 'Tool reported failure',
          'ToolError'
        )
      : null);
  return {
    tool_name: params.toolName,
    args_sha256: sha256(redactedArgsJson),
    args_preview_redacted: redactedArgsJson.slice(0, MAX_PREVIEW_CHARS),
    success: !(toolError || softError),
    error: toolError ?? softError,
    duration_ms: params.durationMs,
  };
}

export async function recordToolInvocationAudit(
  params: ToolInvocationAuditParams
): Promise<void> {
  try {
    const payload = buildPayload(params);
    if (!payload) return;
    const success = payload.success === true;
    await insertEvent({
      entityIds: [],
      organizationId: params.ctx.organizationId,
      originId: `tool_invocation:${params.toolName}:${Date.now()}:${randomUUID()}`,
      title: `${params.toolName} ${success ? 'completed' : 'failed'}`,
      payloadType: 'empty',
      payloadData: payload,
      semanticType: AUDIT_SEMANTIC_TYPE,
      originType: 'tool_invocation',
      metadata: {
        category: 'audit',
        event_type: 'tool_invocation.completed',
        tool_name: params.toolName,
        token_type: params.ctx.tokenType,
        agent_id: params.ctx.agentId ?? null,
        mcp_session_id: params.ctx.mcpSessionId ?? null,
      },
      createdBy: params.ctx.userId ?? null,
      clientId: params.ctx.clientId ?? null,
    });
  } catch (auditError) {
    logger.warn(
      { err: auditError, toolName: params.toolName },
      'Failed to record tool invocation audit event'
    );
  }
}
