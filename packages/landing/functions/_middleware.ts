/**
 * Cloudflare Pages Function middleware: content negotiation for agents.
 *
 * When a request's Accept header prefers `text/markdown`, rewrite to the
 * pre-rendered `<route>.md` twin emitted by scripts/gen-markdown-twins.ts.
 * Browsers (that accept `text/html`) continue to receive the HTML response.
 */

type PagesFunction = (context: {
  request: Request;
  next: () => Promise<Response>;
  env: Record<string, unknown>;
}) => Promise<Response> | Response;

function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const entries = accept
    .split(",")
    .map((part) => {
      const [type, ...params] = part
        .trim()
        .split(";")
        .map((s) => s.trim());
      const q = params.find((p) => p.startsWith("q="));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return {
        type: type.toLowerCase(),
        quality: Number.isFinite(quality) ? quality : 1,
      };
    })
    .filter((e) => e.type);

  const mdQ = Math.max(
    ...entries.filter((e) => e.type === "text/markdown").map((e) => e.quality),
    -1
  );
  if (mdQ < 0) return false;

  const htmlQ = Math.max(
    ...entries
      .filter((e) => e.type === "text/html" || e.type === "*/*")
      .map((e) => e.quality),
    0
  );
  return mdQ >= htmlQ;
}

function toMarkdownPath(pathname: string): string {
  if (pathname.endsWith(".md")) return pathname;
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "") return "/index.md";
  return `${trimmed}.md`;
}

export const onRequest: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.pathname.startsWith("/_astro") ||
    url.pathname.startsWith("/.well-known") ||
    /\.[a-z0-9]+$/i.test(url.pathname)
  ) {
    return next();
  }

  if (!prefersMarkdown(request.headers.get("accept"))) {
    return next();
  }

  const mdUrl = new URL(url.toString());
  mdUrl.pathname = toMarkdownPath(url.pathname);

  const mdResponse = await fetch(mdUrl.toString(), {
    headers: {
      "user-agent": request.headers.get("user-agent") ?? "lobu-md-negotiation",
    },
  });

  if (!mdResponse.ok) return next();

  const headers = new Headers(mdResponse.headers);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.set("Vary", "Accept");
  headers.set("X-Markdown-Negotiated", "true");

  return new Response(mdResponse.body, {
    status: mdResponse.status,
    statusText: mdResponse.statusText,
    headers,
  });
};
