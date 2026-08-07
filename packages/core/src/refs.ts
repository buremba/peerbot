/**
 * LobuRef — one portable, typed reference to any first-class object the UI can
 * point at: an entity, entity type, connection, connector, feed, behavior,
 * member, metric, skill, event, or an inline SQL query. The reference picker
 * emits these, the chat composer serializes them into a message so an agent
 * turn can be told "this is about <that object>", and the Behavior create path
 * compiles the source-bearing ones into `sources[]`.
 *
 * Inline wire form (rides inside an ordinary message `content` string — no new
 * API field):
 *
 *   @[entity:42:Spotify](/acme/company/spotify)
 *   @[entity_type:company:Companies](/acme/company)
 *   @[sql:recent:Recent events](#sql=SELECT%20…)
 *
 * `kind`  — object family (drives worker-side expansion and source compilation).
 * `id`    — stable id as a string (entity id, connection id, behavior uuid,
 *           connector key, feed_key, entity-type slug, `type.measure`).
 * `path`  — frontend route to the object; makes the chip clickable and lets the
 *           ref be re-resolved. For `sql` it is the query payload, not a route.
 * `label` — display name captured at pick time (what the chip shows).
 *
 * THIS FILE IS THE ONLY COPY. It used to exist three times — owletto's
 * `lib/references.ts`, the server's `watchers/source-refs.ts`, and an inline
 * strip-regex in owletto's `lib/behavior-skills.ts` — kept in sync by hand
 * because "the server cannot import the owletto submodule". That reasoning
 * skipped the obvious third option: both already depend on `@lobu/core`, so
 * the grammar belongs here. The duplication was not theoretical — adding the
 * `entity_type` kind meant widening the kind group to allow `_`, and a token
 * that fails to match is dropped SILENTLY (you get `[]`, never an error), so
 * the copy that got missed lost every entity-type chip without complaining.
 */

export type LobuRefKind =
  | "entity"
  | "entity_type"
  | "connection"
  | "connector"
  | "feed"
  | "behavior"
  | "member"
  | "metric"
  | "sql"
  | "skill"
  | "event";

export const LOBU_REF_KINDS: readonly LobuRefKind[] = [
  "entity",
  "entity_type",
  "connection",
  "connector",
  "feed",
  "behavior",
  "member",
  "metric",
  "sql",
  "skill",
  "event",
] as const;

export interface LobuRef {
  kind: LobuRefKind;
  id: string;
  path: string;
  label: string;
}

/** `{name, query}` — one entry of a Behavior's `sources[]`. */
export interface BehaviorSource {
  name: string;
  query: string;
}

export function isLobuRefKind(value: string): value is LobuRefKind {
  return (LOBU_REF_KINDS as readonly string[]).includes(value);
}

/**
 * One inline ref token: `@[kind:id:label](path)`.
 *
 * Groups: kind, id, label, path.
 * - kind  — lowercase letters plus `_`, so multi-word kinds (`entity_type`)
 *           lex. Narrowing this to `[a-z]+` does not throw; it silently stops
 *           matching, which is how a whole chip kind disappears unnoticed.
 * - id    — any char except `:` / `]` (a controlled slug).
 * - label — any char except `]`.
 * - path  — any char except `)` / whitespace, 0+, so an empty `()` is valid:
 *           the synthetic "write a SQL query" menu action carries no path.
 */
export const REF_TOKEN = /@\[([a-z_]+):([^:\]]*):([^\]]*)\]\(([^)\s]*)\)/g;

/** A fresh, non-global matcher for the same grammar — for callers that want a
 *  one-shot `.replace()`/`.test()` without inheriting `lastIndex` state. */
export function refTokenPattern(flags = "g"): RegExp {
  return new RegExp(REF_TOKEN.source, flags);
}

/** Serialize one ref to its inline token. Brackets/colons are stripped from the
 *  label so the token stays unambiguous. */
export function serializeRef(ref: LobuRef): string {
  const safeLabel = ref.label.replace(/[[\]]/g, "").trim();
  const safeId = ref.id.replace(/[[\]:]/g, "");
  return `@[${ref.kind}:${safeId}:${safeLabel}](${ref.path})`;
}

/**
 * Parse every ref token out of a text body, in order. Unknown kinds are skipped
 * rather than thrown, so arbitrary user text containing `@[...]` never breaks
 * send.
 */
export function parseRefs(text: string): LobuRef[] {
  const out: LobuRef[] = [];
  for (const match of text.matchAll(REF_TOKEN)) {
    const [, kind, id, label, path] = match;
    if (!kind || !isLobuRefKind(kind) || !path) continue;
    out.push({ kind, id: id ?? "", label: (label ?? "").trim(), path });
  }
  return out;
}

/** Text with every ref token removed — what the author actually typed. */
export function stripRefTokens(text: string): string {
  return text.replace(refTokenPattern(), " ").trim();
}

// ── SQL payload codec ───────────────────────────────────────────────────────

/**
 * SQL is the one kind with no first-class object to point at — the query is
 * authored inline and lives nowhere but the token itself. So a `sql` ref carries
 * its whole query in the `path` slot, URL-encoded behind a `#sql=` marker.
 * Encoding turns spaces/parens/newlines into `%xx`, so the token's `path` group
 * (no space, no `)`) stays satisfied and the query survives the round-trip
 * verbatim. The `#` marks the path as a payload, not a route — so chip/pill
 * click opens the edit dialog instead of navigating.
 */
const SQL_PATH_PREFIX = "#sql=";

/** `encodeURIComponent` leaves `( ) ' ! * ~` unescaped, but the token's path
 *  group forbids `)` (it closes the `(...)`) — so we additionally percent-encode
 *  those sub-delims. `decodeURIComponent` reverses all of it. */
function encodeSqlPayload(query: string): string {
  return encodeURIComponent(query).replace(
    /[()'!*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Build the `path` for a `sql` ref: `#sql=<urlencoded query>`. */
export function sqlRefPath(query: string): string {
  return `${SQL_PATH_PREFIX}${encodeSqlPayload(query)}`;
}

/** Recover the raw query from a `sql` ref's `path`, or null if it isn't one. */
export function sqlQueryFromPath(path: string): string | null {
  if (!path.startsWith(SQL_PATH_PREFIX)) return null;
  try {
    return decodeURIComponent(path.slice(SQL_PATH_PREFIX.length));
  } catch {
    return null;
  }
}

/** True if a path is a SQL payload rather than a navigable route. */
export function isSqlRefPath(path: string): boolean {
  return path.startsWith(SQL_PATH_PREFIX);
}

// ── Behavior source compilation ─────────────────────────────────────────────

/**
 * Which chip kinds compile to a Behavior source, and the `@mode:` each uses.
 *
 * `entity_type` maps to mode `entity` because the source grammar has always
 * spelled it `@entity:<type_slug>` (every row of one type). The chip kind
 * cannot ALSO be called `entity`: an `@[entity:…]` chip is an entity *instance*
 * that scopes the Behavior, and sending an instance id where a type slug
 * belongs resolves to nothing. Same word, two meanings; the kind keeps them
 * apart — which is exactly why `entity` is absent from this map.
 *
 * `sql` is handled separately (its query rides inline in the path).
 * `skill`, `behavior`, `member` and `event` are never sources.
 */
export const SOURCE_KIND_TO_MODE: Readonly<Record<string, string>> = {
  feed: "feed",
  connection: "connection",
  connector: "connector",
  channel: "channel",
  metric: "metric",
  entity_type: "entity",
};

/** Slugify a label into a safe output-field name. */
export function sourceFieldName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "source"
  );
}

/**
 * Append `{name, query}` unless the query is already present, uniquifying the
 * derived name with a numeric suffix. Shared by the chip codec and the Behavior
 * sources editor so both name and dedupe identically.
 */
function appendBehaviorSource(
  sources: BehaviorSource[],
  seenQueries: Set<string>,
  usedNames: Set<string>,
  label: string,
  fallback: string,
  query: string
): void {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || seenQueries.has(normalizedQuery)) return;
  seenQueries.add(normalizedQuery);
  let name = sourceFieldName(label || fallback);
  if (usedNames.has(name)) {
    let suffix = 2;
    while (usedNames.has(`${name}_${suffix}`)) suffix += 1;
    name = `${name}_${suffix}`;
  }
  usedNames.add(name);
  sources.push({ name, query: normalizedQuery });
}

/**
 * The source a single reference stands for, appended to `existing`. Returns
 * `existing` unchanged when the ref carries no query or already appears — the
 * caller can compare lengths to tell whether anything was added.
 */
export function behaviorSourcesWithRef(
  ref: LobuRef,
  existing: BehaviorSource[]
): BehaviorSource[] {
  const sources = [...existing];
  const seenQueries = new Set(existing.map((source) => source.query.trim()));
  const usedNames = new Set(existing.map((source) => source.name));
  if (ref.kind === "sql") {
    const query = sqlQueryFromPath(ref.path);
    if (query) {
      appendBehaviorSource(
        sources,
        seenQueries,
        usedNames,
        ref.label,
        "sql_source",
        query
      );
    }
    return sources;
  }
  const mode = SOURCE_KIND_TO_MODE[ref.kind];
  const value = ref.id.trim();
  if (mode && value) {
    appendBehaviorSource(
      sources,
      seenQueries,
      usedNames,
      ref.label,
      value,
      `@${mode}:${value}`
    );
  }
  return sources;
}

/**
 * Derive Behavior `sources[]` from the `@`-mention tokens in a prompt. Each
 * source-bearing token becomes `{ name, query: '@mode:id' }`; a `sql` token
 * carries its raw query URL-encoded in the path (`#sql=…`), decoded here to the
 * SELECT itself. Entity INSTANCES are excluded (they scope the Behavior).
 *
 * Returns [] for a prompt with no source tokens. Malformed tokens are skipped
 * rather than thrown — the server's `assertWatcherSourcesResolve` is what
 * enforces that every derived source actually resolves against the org.
 */
export function behaviorSourcesFromPrompt(
  text: string,
  explicit: BehaviorSource[] = []
): BehaviorSource[] {
  const sources = [...explicit];
  const seenQueries = new Set(explicit.map((source) => source.query.trim()));
  const usedNames = new Set(explicit.map((source) => source.name));

  const push = (label: string, fallback: string, query: string) =>
    appendBehaviorSource(
      sources,
      seenQueries,
      usedNames,
      label,
      fallback,
      query
    );

  for (const match of text.matchAll(REF_TOKEN)) {
    const [, kind, id, label, path] = match;
    if (!kind) continue;
    if (kind === "sql") {
      const query = sqlQueryFromPath(path ?? "");
      if (query) push(label ?? "", "sql_source", query.trim());
      continue;
    }
    const mode = SOURCE_KIND_TO_MODE[kind];
    const value = (id ?? "").trim();
    if (mode && value) push(label ?? "", value, `@${mode}:${value}`);
  }

  return sources;
}

/**
 * Names referenced by `@[skill:<name>:<label>](…)` tokens in a prompt.
 *
 * Deliberately NOT part of `SOURCE_KIND_TO_MODE` — a skill is not a source.
 * De-duped, order preserved; malformed tokens are skipped.
 */
export function skillNamesFromPrompt(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(REF_TOKEN)) {
    const [, kind, id] = match;
    if (kind !== "skill") continue;
    const name = (id ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Merge prompt-derived sources into an explicit list, de-duping by query and
 * keeping output-field names unique. Explicit sources win (they keep their
 * names and order); prompt sources fill in the rest.
 */
export function mergePromptSources(
  explicit: BehaviorSource[],
  fromPrompt: BehaviorSource[]
): BehaviorSource[] {
  const merged = [...explicit];
  const seenQuery = new Set(explicit.map((s) => s.query.trim()));
  const usedNames = new Set(explicit.map((s) => s.name));
  for (const src of fromPrompt) {
    if (seenQuery.has(src.query.trim())) continue;
    seenQuery.add(src.query.trim());
    let name = src.name;
    if (usedNames.has(name)) {
      let i = 2;
      while (usedNames.has(`${name}_${i}`)) i += 1;
      name = `${name}_${i}`;
    }
    usedNames.add(name);
    merged.push({ name, query: src.query });
  }
  return merged;
}
