/**
 * Parse one MCP Streamable HTTP response.
 *
 * A server may answer a JSON-RPC request as plain JSON or as one or more SSE
 * events. SSE streams may contain notifications before the response, so a
 * caller that sent an id must select the matching response instead of trusting
 * whichever event happened to arrive last.
 */
export async function parseJsonRpcResponse(
  response: Response,
  expectedId?: unknown
): Promise<unknown> {
  if (response.status === 202 || response.status === 204) {
    if (expectedId !== undefined) {
      throw new Error(`MCP response omitted JSON-RPC id ${String(expectedId)}`);
    }
    return { jsonrpc: '2.0', id: null, result: {} };
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    const value = (await response.json()) as unknown;
    return selectExpectedResponse([value], expectedId);
  }

  const text = await response.text();
  const values: unknown[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    values.push(JSON.parse(data));
  }

  if (values.length === 0) {
    throw new Error('SSE response contained no data payload');
  }
  return selectExpectedResponse(values, expectedId);
}

function selectExpectedResponse(values: unknown[], expectedId: unknown): unknown {
  if (expectedId === undefined) return values.at(-1);
  const match = values.find(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'id') &&
      Object.is((value as { id?: unknown }).id, expectedId)
  );
  if (match !== undefined) return match;
  throw new Error(`MCP response omitted JSON-RPC id ${String(expectedId)}`);
}
