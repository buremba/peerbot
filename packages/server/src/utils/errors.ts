import type { ToolErrorCode } from '@lobu/core';
import { isRetryable } from '@lobu/core';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Error class for client-input failures inside MCP/REST tools (bad path,
 * not-found, validation errors). Carries an HTTP status so the REST proxy
 * can return the right code, and is recognised by `trackMCPToolCall` to
 * avoid noisy Sentry alerts on 4xx-class outcomes.
 *
 * Optionally carries a structured `ToolErrorCode` (lobu#2051 Item 2). When a
 * throw site supplies one, the MCP/REST boundaries surface `{ code, retryable,
 * call_id }` and the auto-retry wrapper can honor `retryable`. `callId` is
 * stamped at the `executeTool` boundary.
 */
export class ToolUserError extends Error {
  readonly httpStatus: number;
  readonly code?: ToolErrorCode;
  readonly retryable: boolean;
  callId?: string;

  constructor(message: string, httpStatus = 400, code?: ToolErrorCode) {
    super(message);
    this.name = 'ToolUserError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryable = code ? isRetryable(code) : false;
  }
}

/**
 * Thrown when a tool name reaches `executeTool` but is not registered. Indicates
 * registry/frontend drift (e.g. frontend `apiCall('foo', …)` references a name
 * the backend no longer registers). The REST proxy captures this to Sentry so
 * the next drift surfaces
 * as an alert rather than a 400 the page swallows.
 */
export class ToolNotRegisteredError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`);
    this.name = 'ToolNotRegisteredError';
    this.toolName = toolName;
  }
}
