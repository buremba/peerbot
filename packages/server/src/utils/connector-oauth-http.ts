import { readResponseTextWithLimit } from './bounded-response';

export const CONNECTOR_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_CONNECTOR_OAUTH_RESPONSE_BYTES = 1024 * 1024;

/** Keep the deadline active through both headers and response-body consumption. */
export async function withConnectorOAuthDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = CONNECTOR_OAUTH_REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(new Error(`Connector OAuth request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function readConnectorOAuthResponse(response: Response): Promise<string> {
  return readResponseTextWithLimit(
    response,
    MAX_CONNECTOR_OAUTH_RESPONSE_BYTES,
    'Connector OAuth response too large'
  );
}
