/**
 * The canonical MCP App resource URI, and the matcher that keeps older ones
 * resolvable.
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
 * **Every version resolves to the same template, and that is load-bearing.** A
 * host does not read the id out of the tool result it just received; it reads
 * the one it captured at connect time, from `resources/list` and the tool-level
 * `openai/outputTemplate`. That handshake is cached for the life of the
 * connection. So the moment a bump lands, every already-connected host asks for
 * the *previous* id — and if that id 404s, the card dies for everyone until
 * each user manually refreshes the connector, which nobody knows to do.
 *
 * Verified on prod 2026-08-20, same host and bundle, only the handshake
 * differing: a stale ChatGPT connection rendered `Error loading app / Failed to
 * fetch template` with the sandbox iframe collapsed to height 0, and Claude
 * failed the same way without saying so. Clicking Refresh on the plugin — which
 * re-fetches the handshake — made the identical prompt render at 400px.
 *
 * This is not a compatibility shim for old code paths. There is exactly one
 * template; the packed self-contained variant is gone, and the 37-entry alias
 * table that used to pin each retired id to the template it shipped with went
 * with it. Resolving any version to the single template we serve today is the
 * correct answer to "give me the Lobu interaction shell", and it makes a bump
 * mean what the comment above claims it means: a cache eviction, not an outage.
 */
export const LOBU_INTERACTION_RESOURCE_URI = 'ui://lobu/interaction/v42.html';

/**
 * Any interaction-shell id, current or superseded. The `.html` suffix is
 * optional because the earliest ids predate it, and a host that cached one is
 * exactly the host this exists to keep working.
 */
const LOBU_INTERACTION_URI_PATTERN = /^ui:\/\/lobu\/interaction\/v\d+(?:\.html)?$/;

export function isLobuInteractionResourceUri(uri: string): boolean {
  return LOBU_INTERACTION_URI_PATTERN.test(uri);
}
