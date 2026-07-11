/**
 * Unified fetch mock for testing.
 * Replaces TestHelpers.mockFetch from worker setup.ts.
 */

/**
 * Install a mock global.fetch that returns pre-configured responses.
 * Returns a cleanup function that restores the original fetch.
 *
 * @param responses - Map of URL → response body (JSON-serialisable).
 *                    Unmatched URLs return `{ success: true }`.
 */
export function mockFetch(responses: Record<string, any> = {}): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (
    url: string | URL | Request,
    _options?: RequestInit
  ) => {
    const urlString = url instanceof Request ? url.url : url.toString();

    const body = responses[urlString] ?? { success: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}
