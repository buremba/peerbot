/**
 * Sentry Integration for MCP Tool Monitoring
 *
 * Sentry.init() lives in instrument.ts (imported first in server.ts).
 * This module provides the MCP tool call tracking wrapper.
 */

import * as Sentry from '@sentry/node';
import { ToolUserError } from './utils/errors';

/**
 * Track an MCP tool call with Sentry
 * Captures tool name, arguments, response, and execution time
 */
export async function trackMCPToolCall<T>(
  toolName: string,
  args: unknown,
  handler: () => Promise<T>
): Promise<T> {
  return await Sentry.startSpan(
    {
      name: `MCP Tool Call: ${toolName}`,
      op: 'mcp.tool.call',
      attributes: {
        'mcp.tool.name': toolName,
      },
    },
    async (span) => {
      try {
        // Execute the tool handler
        const result = await handler();

        // Set success attributes on span
        span?.setAttributes({
          'mcp.tool.status': 'success',
          'mcp.tool.arguments': JSON.stringify(sanitizeArguments(args)),
        });

        return result;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // 4xx-class outcomes raised by the tool itself (bad path, not found,
        // schema validation) aren't operational errors — annotate the span
        // but skip Sentry capture to keep the alert feed clean.
        const isUserError = error instanceof ToolUserError;

        if (!isUserError) {
          Sentry.captureException(error, {
            tags: {
              tool_name: toolName,
              status: 'error',
            },
            extra: {
              arguments: sanitizeArguments(args),
              error_message: errorMessage,
            },
          });
        }

        span?.setAttributes({
          'mcp.tool.status': isUserError ? 'user_error' : 'error',
          'mcp.tool.error': errorMessage,
        });

        throw error;
      }
    }
  );
}

/**
 * Sanitize arguments to avoid sending sensitive data to Sentry
 * Redacts common sensitive field names
 */
function sanitizeArguments(args: unknown): unknown {
  const sensitiveFieldTokens = [
    'password',
    'token',
    'api_key',
    'apikey',
    'secret',
    'authorization',
    'refresh_token',
    'access_token',
    'client_secret',
    'code_verifier',
    'session_state',
    'cookie',
    'credential',
  ];

  const seen = new WeakSet<object>();

  function isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    return sensitiveFieldTokens.some((token) =>
      normalized.includes(token.replace(/[^a-z0-9_]/g, ''))
    );
  }

  function sanitize(value: unknown): unknown {
    if (value === null || value === undefined || typeof value !== 'object') {
      return value;
    }

    if (seen.has(value as object)) {
      return '[CIRCULAR]';
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = isSensitiveKey(key) ? '[REDACTED]' : sanitize(nestedValue);
    }
    return sanitized;
  }

  return sanitize(args);
}
