/**
 * The canonical MCP App resource URI.
 *
 * The URI is the host's cache key for the template, and hosts cache both
 * successful and failed `resources/read` results under it. That is the only
 * reason a version is still in the id: bumping it is the escape hatch when a
 * host has cached something we need it to forget.
 *
 * A bump is NOT needed when the widget's code changes. The template is a thin
 * shell that pins each asset to a content digest (`assets/app.js?v=<digest>`),
 * and the asset route serves the *current* bytes for a stale digest — it just
 * declines to cache them (`no-store` instead of `immutable`). So a host holding
 * an old shell still renders today's app; only its caching degrades. Bump for a
 * change to the shell's own structure, or to evict a poisoned host cache.
 *
 * Retired URIs are not resolvable. The old alias table re-served 37 retired
 * ids, each pinned to the template it was issued with — 21 to a packed
 * self-contained one, 16 to the external one. The packed template is gone with
 * this change, and nothing current resolves through a retired id, so the table
 * was deleted rather than re-pointed. A host that still asks for one is reading
 * a chat transcript old enough that its own cache has since been evicted; that
 * card fails alone, and nothing current is affected.
 */
export const LOBU_INTERACTION_RESOURCE_URI = 'ui://lobu/interaction/v42.html';
