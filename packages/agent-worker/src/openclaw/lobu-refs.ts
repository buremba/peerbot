/**
 * Worker-side parsing of the inline LobuRef tokens the owletto @-mention
 * composer serializes into a message. Kept as a small local mirror of the codec
 * in owletto (`src/lib/references.ts`) because the worker cannot import the
 * owletto submodule; the wire form is a stable contract between them.
 *
 *   @[entity:Spotify](/acme/company/spotify)
 *
 * This lightweight pass only turns the tokens into a plain-text context hint
 * appended before the agent's turn — it does NOT resolve the objects (that
 * would need gateway access threaded into the plugin hook; a planned
 * follow-up). The hint tells the agent which objects were referenced and their
 * paths so it can resolve them with its own tools (e.g. resolve_path).
 */

export interface ParsedLobuRef {
  kind: string;
  id: string;
  label: string;
  path: string;
}

// Token: `@[kind:id:label](path)` — mirrors owletto's serializeRef. This grammar
// is duplicated (submodule can't be imported) in owletto `lib/references.ts` and
// server `watchers/source-refs.ts`; keep all three in sync (path group is 0+).
const REF_TOKEN = /@\[([a-z]+):([^:\]]*):([^\]]*)\]\(([^)\s]*)\)/g;

const KNOWN_KINDS = new Set([
  "entity",
  "connection",
  "connector",
  "feed",
  "watcher",
  "member",
  "metric",
  "sql",
  "event",
]);

/** A `sql` ref carries its query URL-encoded in `path` behind `#sql=` (it has no
 *  route). Recover the raw query, or null if the path isn't a SQL payload. */
const SQL_PATH_PREFIX = "#sql=";
function sqlQueryFromPath(path: string): string | null {
  if (!path.startsWith(SQL_PATH_PREFIX)) return null;
  try {
    return decodeURIComponent(path.slice(SQL_PATH_PREFIX.length));
  } catch {
    return null;
  }
}

/** Parse every LobuRef token out of a message body, in order. */
export function parseLobuRefs(text: string): ParsedLobuRef[] {
  const out: ParsedLobuRef[] = [];
  for (const m of text.matchAll(REF_TOKEN)) {
    const [, kind, id, label, path] = m;
    if (!kind || !KNOWN_KINDS.has(kind) || !path) continue;
    out.push({ kind, id: id ?? "", label: (label ?? "").trim(), path });
  }
  return out;
}

/**
 * Build a short context block naming the referenced objects, or "" when the
 * message has none. Appended before the user's turn so the agent knows what
 * `@[...]` tokens point at without the tokens reading as opaque markdown.
 */
export function buildRefContextHint(text: string): string {
  const refs = parseLobuRefs(text);
  if (refs.length === 0) return "";
  const lines = refs.map((r) => {
    // A SQL ref has no route — surface its query inline instead of the opaque
    // `#sql=…` path so the agent sees the actual SELECT.
    const sqlQuery = r.kind === "sql" ? sqlQueryFromPath(r.path) : null;
    if (sqlQuery !== null) return `- sql "${r.label}": ${sqlQuery}`;
    return `- ${r.kind} "${r.label}" → ${r.path}`;
  });
  return [
    "The user referenced these objects in their message. Use your tools",
    "(e.g. resolve_path for entities, or the relevant read tool) to load any",
    "you need before answering:",
    ...lines,
  ].join("\n");
}
