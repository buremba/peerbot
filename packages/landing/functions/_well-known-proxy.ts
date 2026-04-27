/**
 * Proxy OAuth discovery endpoints from `lobu.ai` to `app.lobu.ai`.
 *
 * Some MCP clients (RFC 9728) probe `<resource>/.well-known/oauth-protected-resource`
 * directly from the resource origin before issuing any MCP request. With
 * `lobu.ai/mcp` proxied to `app.lobu.ai/mcp`, those probes need to land on
 * the live backend metadata, not on stale static stubs.
 *
 * Path-relative discovery (`/mcp/.well-known/...`) is already covered by the
 * MCP proxy at `functions/mcp/[[path]].ts`.
 */

type PagesContext = {
  request: Request;
  next: () => Promise<Response>;
  env: Record<string, unknown>;
  params: Record<string, string | string[]>;
};

const UPSTREAM_ORIGIN_DEFAULT = "https://app.lobu.ai";

function logEvent(payload: Record<string, unknown>): void {
  try {
    console.log(
      JSON.stringify({ source: "lobu.well-known.proxy", ...payload })
    );
  } catch {
    /* logging must never throw */
  }
}

export async function proxyWellKnown(context: PagesContext): Promise<Response> {
  const { request, env } = context;

  const upstreamOrigin =
    (typeof env.MCP_UPSTREAM_ORIGIN === "string" && env.MCP_UPSTREAM_ORIGIN) ||
    UPSTREAM_ORIGIN_DEFAULT;

  const incoming = new URL(request.url);
  const upstreamUrl = `${upstreamOrigin}${incoming.pathname}${incoming.search}`;
  const traceId =
    request.headers.get("x-trace-id") ??
    (typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2));
  const startedAt = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        accept: request.headers.get("accept") ?? "application/json",
        "x-trace-id": traceId,
        "x-forwarded-host": incoming.host,
      },
      redirect: "manual",
    });
  } catch (error) {
    logEvent({
      level: "error",
      traceId,
      method: request.method,
      path: incoming.pathname,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    return new Response(JSON.stringify({ error: "bad_gateway", traceId }), {
      status: 502,
      headers: {
        "content-type": "application/json",
        "x-trace-id": traceId,
      },
    });
  }

  logEvent({
    traceId,
    method: request.method,
    path: incoming.pathname,
    upstreamStatus: upstream.status,
    durationMs: Date.now() - startedAt,
  });

  const headers = new Headers(upstream.headers);
  headers.set("x-trace-id", traceId);
  headers.append(
    "server-timing",
    `wellknown_upstream;dur=${Date.now() - startedAt}`
  );
  // Public discovery: agent scanners and browser-based clients fetch these
  // cross-origin. Upstream advertises CORS for app.lobu.ai only, which blocks
  // anyone else. Override to a public allowlist.
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.delete("access-control-allow-credentials");
  const existingVary = headers.get("vary");
  headers.set("vary", existingVary ? `${existingVary}, Accept` : "Accept");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
