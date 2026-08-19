/**
 * The canonical MCP App resource URI, plus every retired URI still mapped to it.
 *
 * The URI is the host cache key for the immutable template. Bump it whenever the
 * shipped HTML changes; ChatGPT caches both successful and failed fetches. Every
 * bump must also append the retired version number to the alias list for the
 * template it shipped with — `EXTERNAL_ALIAS_VERSIONS` today. Already-rendered
 * apps keep fetching the URI they were built with, and an unmapped one fails
 * `resources/read` for the life of that chat.
 */
export const LOBU_INTERACTION_RESOURCE_URI = 'ui://lobu/interaction/v42.html';

/**
 * Retired interaction resource URIs, kept resolvable.
 *
 * Every rollout that changed the widget contract minted a new `ui://` id, but
 * MCP hosts cache the id they first saw and keep asking for it, so each old one
 * still has to resolve — to the template it was issued with, not to today's.
 *
 * Two irregularities in the version list are deliberate and load-bearing:
 * v1/v2 predate the `.html` suffix, and v16–v19 were never shipped (no commit
 * has ever contained them), so they stay unresolvable rather than becoming
 * newly valid ids here.
 */
const EMBEDDED_ALIAS_VERSIONS = [
  1, 2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
] as const;

const EXTERNAL_ALIAS_VERSIONS = [
  3, 4, 5, 6, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41,
] as const;

export interface McpAppResourceAlias {
  canonicalUri: string;
  template: 'embedded' | 'external';
}

function aliasUri(version: number): string {
  return `ui://lobu/interaction/v${version}${version <= 2 ? '' : '.html'}`;
}

export const MCP_APP_RESOURCE_ALIASES: ReadonlyMap<string, McpAppResourceAlias> =
  new Map(
    (
      [
        ['embedded', EMBEDDED_ALIAS_VERSIONS],
        ['external', EXTERNAL_ALIAS_VERSIONS],
      ] as const
    ).flatMap(([template, versions]) =>
      versions.map(
        (version): [string, McpAppResourceAlias] => [
          aliasUri(version),
          { canonicalUri: LOBU_INTERACTION_RESOURCE_URI, template },
        ]
      )
    )
  );
