import { createHash, randomUUID } from 'node:crypto';
import { REDACTED_SENTINEL } from '@lobu/core';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { AUDIT_SEMANTIC_TYPE } from './constants';
import {
  captureRequestSnapshot,
  KNOWN_SECRET_SHAPE_RE,
  persistRequestSnapshot,
  REQUEST_SNAPSHOT_TOOLS,
} from './invocation-snapshot';
import { getTool, type ToolContext } from './registry';

const MAX_PREVIEW_CHARS = 500;
// Redaction principle: consume the COMPLETE credential. Over-consumption is
// fine (previews are display-only; identity comes from the hash of the
// redacted form), partial redaction is not — a stop at the first space,
// comma, or scheme word leaks the remainder.
//
// Header-named credentials carry STRUCTURED values (scheme + params, cookie
// lists), so everything after the separator is credential material — consume
// to the end of the string/line.
const HEADER_CREDENTIAL_RE =
  /\b(authorization|proxy-authorization|www-authenticate|set-cookie|cookie)\s*["']?\s*[:=]\s*[^\n]+/gi;
// Bare scheme credentials: Digest takes a comma-delimited key=value list
// (quoted values included); token schemes take a single blob.
const AUTH_SCHEME_RE =
  /\b(bearer|basic|digest)\s+(?:[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,]+)(?:\s*,\s*[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,]+))*|[a-z0-9._~+/=:-]+)/gi;
// Denylisted key assignments: a quoted string up to its closing quote (spaces
// included), otherwise an unquoted run that does not stop at commas.
const SENSITIVE_ASSIGNMENT_RE =
  /(api[_-]?key|credential|password|private[_-]?key|secret|token)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s'"}]+)/gi;

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
    .replace(HEADER_CREDENTIAL_RE, (_match, key: string) => `${key}=[redacted]`)
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, key: string) => `${key}=[redacted]`)
    .replace(KNOWN_SECRET_SHAPE_RE, '[redacted]');
}

function redactPreview(value: string): string {
  // Redact BEFORE truncating: slicing first can split a quoted credential and
  // the unbalanced quote defeats the pattern, leaking the visible fragment.
  return redactSensitiveText(value).slice(0, MAX_PREVIEW_CHARS);
}

/**
 * Generic audit summaries persist the SHAPE of a call, never its content.
 * Nothing caller-controlled survives: values are sentineled except
 * booleans/nulls (provably structural — one bit), and property NAMES are kept
 * only when the tool's own input schema declares them at the top level —
 * audit also fires on FAILED validation, so arbitrary pasted text can arrive
 * as a value of an enum-typed key or even AS a key, and identifier-shaped
 * secrets (`sk-live-…`) are indistinguishable from slugs. Repeated sentinel
 * keys merge; that collapse is part of recording shape, not content.
 */
function schemaPropertyNames(toolName: string): Set<string> {
  const schema = getTool(toolName)?.inputSchema as
    | {
        properties?: Record<string, unknown>;
        anyOf?: Array<{ properties?: Record<string, unknown> } | undefined>;
      }
    | undefined;
  const names = new Set<string>();
  for (const props of [schema?.properties, ...(schema?.anyOf ?? []).map((v) => v?.properties)]) {
    if (props) for (const key of Object.keys(props)) names.add(key);
  }
  return names;
}

function sanitizeArgLeaves(
  value: unknown,
  trustedKeys: ReadonlySet<string>,
  topLevel: boolean
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeArgLeaves(item, trustedKeys, false));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        topLevel && trustedKeys.has(key) ? key : REDACTED_SENTINEL,
        sanitizeArgLeaves(nested, trustedKeys, false),
      ])
    );
  }
  if (typeof value === 'boolean' || value === null || value === undefined) return value;
  return REDACTED_SENTINEL;
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
          : fallbackName,
    };
  }
  return { name: fallbackName, message: redactPreview(String(error)) };
}

/**
 * Error shape for GENERIC audit entries: the class name (and `code` when the
 * error carries one) only. Handler-supplied message text can echo user values
 * in shapes no pattern enumerates, so it never reaches the append-only ledger
 * — the caller already received the full error on the live response.
 */
function errorNameOnly(error: unknown, fallbackName: string): Record<string, unknown> | null {
  if (!error) return null;
  const record =
    typeof error === 'object' ? (error as Record<string, unknown>) : ({} as Record<string, unknown>);
  const name =
    error instanceof Error ? error.name
    : typeof record.name === 'string' ? record.name
    : fallbackName;
  return typeof record.code === 'string' ? { name, code: record.code } : { name };
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

  // Browser-session and anonymous generic reads stay out of Activity. Power
  // tools are retained because their invocation history is the audit product.
  if (
    !REQUEST_SNAPSHOT_TOOLS.has(params.toolName) &&
    params.ctx.tokenType !== 'oauth' &&
    params.ctx.tokenType !== 'pat'
  ) {
    return null;
  }
  // The preview and hash are built from the SANITIZED args: every string leaf
  // becomes the sentinel unless its key is a known structural discriminator.
  // A raw or pattern-redacted serialization would persist free-text values
  // (and an unsalted credential-derived digest) whenever a secret hides in a
  // shape no pattern enumerates — the ledger records the call's shape, never
  // its content.
  const sanitizedArgsJson = JSON.stringify(
    sanitizeArgLeaves(params.args ?? {}, schemaPropertyNames(params.toolName), true)
  );
  const reportedFailure =
    result.error != null ||
    result.success === false ||
    result.status === 'failed' ||
    result.status === 'error' ||
    result.status === 'timeout';
  const softError = reportedFailure ? errorNameOnly(result.error, 'ToolError') ?? { name: 'ToolError' } : null;
  const thrownError = errorNameOnly(params.error, 'Error');
  return {
    tool_name: params.toolName,
    args_sha256: sha256(sanitizedArgsJson),
    args_preview_redacted: sanitizedArgsJson.slice(0, MAX_PREVIEW_CHARS),
    success: !(thrownError || softError),
    error: thrownError ?? softError,
    duration_ms: params.durationMs,
  };
}

export async function recordToolInvocationAudit(
  params: ToolInvocationAuditParams
): Promise<void> {
  try {
    const payload = buildPayload(params);
    if (!payload) return;
    const snapshot = captureRequestSnapshot(params);
    if (snapshot) Object.assign(payload, snapshot.fields);
    const success = payload.success === true;
    const event = await insertEvent({
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
    if (snapshot?.body) {
      await persistRequestSnapshot({ eventId: event.id, body: snapshot.body });
    }
  } catch (auditError) {
    logger.warn(
      { err: auditError, toolName: params.toolName },
      'Failed to record tool invocation audit event'
    );
  }
}
