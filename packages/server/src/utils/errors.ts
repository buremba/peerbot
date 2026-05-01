export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Error class for client-input failures inside MCP/REST tools (bad path,
 * not-found, validation errors). Carries an HTTP status so the REST proxy
 * can return the right code, and is recognised by `trackMCPToolCall` to
 * avoid noisy Sentry alerts on 4xx-class outcomes.
 */
export class ToolUserError extends Error {
  readonly httpStatus: number;

  constructor(message: string, httpStatus = 400) {
    super(message);
    this.name = 'ToolUserError';
    this.httpStatus = httpStatus;
  }
}

/**
 * Thrown when a tool name reaches `executeTool` but is not registered. Indicates
 * registry/frontend drift (e.g. frontend `apiCall('foo', …)` references a name
 * the backend no longer registers) — the kind of regression that produced a
 * silent prod outage when `list_watchers` was removed without migrating the
 * frontend. The REST proxy captures this to Sentry so the next drift surfaces
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
