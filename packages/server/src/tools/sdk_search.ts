/**
 * Method discovery for the `ClientSDK`. Match order: exact path drill-down →
 * namespace prefix listing → substring on path + summary. Source of truth is
 * `method-metadata.ts`.
 */

import { type Static, Type } from "@sinclair/typebox";
import type { Env } from "../index";
import { METHOD_METADATA, type MethodMetadata } from "../sandbox/method-metadata";
import type { ToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";

/**
 * Namespace index derived from the metadata keys at module load — advertised
 * in the query description and the no-match hint so a cold client can
 * enumerate the SDK surface without guessing. Parity with the runtime SDK is
 * guarded by `sandbox/method-metadata.test.ts`, so this list can't drift.
 */
const NAMESPACES = [
  ...new Set(
    Object.keys(METHOD_METADATA)
      .filter((path) => path.includes("."))
      .map((path) => path.split(".")[0]),
  ),
].sort();

export const SdkSearchSchema = Type.Object({
  query: Type.String({
    description:
      `Method-discovery query. Use a namespace name (e.g. 'watchers') for a listing, a dotted path (e.g. 'watchers.create') for a drill-down, or a free-text term to substring-match across paths and summaries. Namespaces: ${NAMESPACES.join(", ")}.`,
    minLength: 1,
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Max matches to return. Default 20, max 100.",
      minimum: 1,
      maximum: 100,
    }),
  ),
});

type SdkSearchArgs = Static<typeof SdkSearchSchema>;

/**
 * Result of `search_sdk`. TypeBox is the single source of truth: the handler's
 * return type is derived from this via `Static<>`, and the same schema is handed
 * to the registry as the tool's `outputSchema` (so the listing, the result
 * shape, and the TS type can't drift).
 */
export const SdkSearchResultSchema = Type.Object({
  query: Type.String({ description: 'The query that was searched.' }),
  match_count: Type.Integer({
    description: 'Number of matches returned.',
  }),
  results: Type.Array(Type.String(), {
    description: 'Rendered method-documentation strings, one per match.',
  }),
  notes: Type.Optional(
    Type.String({
      description: 'Free-text hints (e.g. ambiguity, suggestions) when relevant.',
    })
  ),
});

export type SdkSearchResult = Static<typeof SdkSearchResultSchema>;

interface MatchRow {
  path: string;
  summary: string;
  access: MethodMetadata["access"];
}

/**
 * Render a one-line method entry for namespace listings.
 */
function renderListLine(path: string, meta: MethodMetadata): string {
  return `${path} — ${meta.summary}`;
}

/**
 * Render a multi-line drill-down for a single method.
 */
function renderDrillDown(path: string, meta: MethodMetadata): string {
  const lines: string[] = [];
  lines.push(path);
  lines.push(`  ${meta.summary}`);
  lines.push(`  access: ${meta.access}${meta.cost ? ` (cost: ${meta.cost})` : ""}`);
  if (meta.throws && meta.throws.length > 0) {
    lines.push(`  throws: ${meta.throws.join(", ")}`);
  }
  if (meta.example) {
    lines.push(`  example: ${meta.example}`);
  }
  if (meta.usageExample) {
    lines.push("  usage_example:");
    for (const exampleLine of meta.usageExample.split("\n")) {
      lines.push(`    ${exampleLine}`);
    }
  }
  return lines.join("\n");
}

export const sdkSearch = withValidatedArgs("search_sdk", SdkSearchSchema, sdkSearchImpl);

async function sdkSearchImpl(
  args: SdkSearchArgs,
  _env: Env,
  _ctx: ToolContext,
): Promise<SdkSearchResult> {
  const limit = Math.min(args.limit ?? 20, 100);
  const query = args.query.trim();
  const lower = query.toLowerCase();

  const all: Array<[string, MethodMetadata]> = Object.entries(METHOD_METADATA);

  // Tier 1: exact path drill-down.
  if (lower in METHOD_METADATA) {
    const meta = METHOD_METADATA[lower];
    return {
      query,
      match_count: 1,
      results: [renderDrillDown(lower, meta)],
    };
  }

  // Tier 2: namespace prefix listing.
  if (lower.indexOf(".") === -1) {
    const prefix = `${lower}.`;
    const ns = all.filter(([p]) => p.startsWith(prefix));
    // Top-level methods (no dot) live as bare paths — match those too.
    const topLevel = all.filter(([p]) => p === lower);
    const combined = [...topLevel, ...ns];
    if (combined.length > 0) {
      return {
        query,
        match_count: combined.length,
        results: combined
          .slice(0, limit)
          .map(([p, m]) => renderListLine(p, m)),
        notes:
          combined.length > limit
            ? `${combined.length - limit} more matches; raise \`limit\` or refine the query.`
            : undefined,
      };
    }
  }

  // Tier 3: substring on path + summary.
  const seen = new Set<string>();
  const matches: MatchRow[] = [];
  for (const [path, meta] of all) {
    if (path.toLowerCase().includes(lower)) {
      if (!seen.has(path)) {
        seen.add(path);
        matches.push({ path, summary: meta.summary, access: meta.access });
      }
    }
  }
  for (const [path, meta] of all) {
    if (meta.summary.toLowerCase().includes(lower) && !seen.has(path)) {
      seen.add(path);
      matches.push({ path, summary: meta.summary, access: meta.access });
    }
  }

  if (matches.length === 0) {
    return {
      query,
      match_count: 0,
      results: [],
      notes: `No matches. Try a namespace (${NAMESPACES.join(", ")}) or a verb (create, list, search).`,
    };
  }

  return {
    query,
    match_count: matches.length,
    results: matches
      .slice(0, limit)
      .map((m) =>
        renderListLine(m.path, {
          summary: m.summary,
          access: m.access,
        } as MethodMetadata),
      ),
    notes:
      matches.length > limit
        ? `${matches.length - limit} more matches; raise \`limit\` or refine the query.`
        : undefined,
  };
}
