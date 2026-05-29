/**
 * Extension DOM Scrape
 *
 * Companion to `extensionNetworkSync` (extension-network.ts) for the feeds
 * that CAN'T be read by passive network capture. Attaching the CDP debugger
 * (which the Network-domain intercept needs) stops some personalized feeds
 * from rendering, so the Voyager-style XHRs never fire. For those, the Owletto
 * extension exposes a content-script scrape op (`cs_scrape`): a single
 * `navigate` dispatch that opens/reuses a tab, runs the extension's
 * site-agnostic `genericScrape` engine over the live DOM using a declarative
 * `scrape_config`, scrolls, and hands back the extracted rows.
 *
 * Why this exists: connectors used to hand-wire that `navigate` dispatch
 * inline (LinkedIn's home feed), which left the SDK asymmetric: a helper for
 * the network path, a raw dispatch for the DOM path. This wraps the single
 * dispatch so every extension feed goes through the SDK, and the connector
 * only supplies the (site-specific) selector config + a row parser.
 *
 * Generic by design: the SDK names no site. The `scrape_config` selectors and
 * the `allowedOrigins` are supplied by the caller; the extension interprets
 * the config (apps/chrome content-script genericScrape).
 *
 * Wire shape: the dispatcher returns the same `observation` envelope the
 * extension produces on /api/workers/complete-action. The connector awaits the
 * dispatcher and never needs to know how the run was routed (sync vs queued).
 */

import type { ChromeActionDispatcher } from './extension-network.js';

// ── Wire types (mirror the extension's genericScrape config + result) ──

/**
 * Declarative selector config the extension's content-script `genericScrape`
 * interprets. The SDK passes this through verbatim as `scrape_config`; the
 * connector owns the site-specific selectors. Kept structurally permissive
 * (an index signature) so connectors can add engine fields the SDK doesn't
 * need to know about without widening this type.
 */
export interface ExtensionScrapeConfig {
  /**
   * Scroll loop bounds. `max` iterations; `stall` = consecutive no-growth
   * scrolls before stopping; `waitMs` between scrolls; `deep` = deeper walk.
   */
  scroll?: { max?: number; stall?: number; waitMs?: number; deep?: boolean };
  /** When the landed page matches, the extension reports `loggedIn: false`. */
  loggedOutWhen?: { pathRegex?: string; hostRegex?: string };
  /** CSS selector for each row container. */
  rowSelector?: string;
  /** Optional grouping selector. */
  group?: string;
  /** How to derive the row id from the matched element. */
  id?: { source: string; name?: string; regex?: string; group?: number };
  /** Rows missing any of these extracted fields are dropped. */
  requireFields?: readonly string[];
  /** Field extractors keyed by output field name. */
  fields?: Record<
    string,
    {
      selector?: string;
      take?: string;
      attr?: string;
      firstLine?: boolean;
      const?: unknown;
    }
  >;
  [k: string]: unknown;
}

/** The `.result` payload of a `cs_scrape` dispatch. */
export interface ExtensionScrapeResult {
  count?: number;
  host?: string;
  landedUrl?: string;
  loggedIn?: boolean;
  rows?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * The dispatch observation wrapping a `cs_scrape` result. The index signature
 * keeps it assignable to ChromeActionDispatcher.dispatch's `ChromeActionOutput`
 * (= Record<string, unknown>) constraint.
 */
export type ExtensionScrapeObservation = Record<string, unknown> & {
  tab_id?: number;
  cs_scrape?: boolean;
  persistent_reused?: boolean;
  result?: ExtensionScrapeResult;
};

export interface ExtensionDomScrapeResult<TItem> {
  items: TItem[];
  loggedIn: boolean;
  count: number;
  host?: string;
  landedUrl?: string;
}

// ── Main entrypoint ───────────────────────────────────────────────────────

/**
 * Drive a single content-script `cs_scrape` navigate against the extension and
 * return the parsed rows. Mirrors `extensionNetworkSync` for the DOM path: the
 * connector supplies the declarative `config` (its own selectors) and a
 * `parseRows` mapper; the SDK owns the dispatch shape.
 *
 * `persistent`/`focus` default to true so a reused, focused window lets the
 * user clear an auth wall in place for the next run.
 */
export async function extensionDomScrape<TItem>(opts: {
  dispatcher: ChromeActionDispatcher;
  url: string;
  /** The declarative scrape config the extension interprets (site selectors). */
  config: ExtensionScrapeConfig;
  /** Map the extension's raw extracted rows into typed items. */
  parseRows: (rows: Array<Record<string, unknown>>) => TItem[];
  /**
   * Origins the dispatched navigate is allowed to touch. Forwarded as
   * `allowed_origins` so the extension's per-run origin gate blocks anything
   * off-host (mirrors extensionNetworkSync's allowlist).
   */
  allowedOrigins: string[];
  /** Reuse a persistent window (default true). */
  persistent?: boolean;
  /** Focus the window so an auth wall can be cleared in place (default true). */
  focus?: boolean;
}): Promise<ExtensionDomScrapeResult<TItem>> {
  const observation = await opts.dispatcher.dispatch<ExtensionScrapeObservation>(
    'navigate',
    {
      cs_scrape: true,
      persistent: opts.persistent ?? true,
      focus: opts.focus ?? true,
      url: opts.url,
      scrape_config: opts.config,
      allowed_origins: opts.allowedOrigins,
    }
  );

  const result = observation?.result;
  const rows = result?.rows ?? [];
  const items = opts.parseRows(rows);

  return {
    items,
    // Only an explicit `false` means logged out; absence is treated as ok.
    loggedIn: result?.loggedIn !== false,
    count: result?.count ?? items.length,
    host: result?.host,
    landedUrl: result?.landedUrl,
  };
}
