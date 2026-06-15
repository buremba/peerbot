import type { ChromeActionDispatcher } from './extension-network.js';

/**
 * Companion to `extensionNetworkSync` for feeds that can't be read by passive
 * network capture — the CDP debugger the intercept needs stops some
 * personalized feeds from rendering. Wraps the extension's content-script
 * `cs_scrape` op in one dispatch so the DOM path goes through the SDK like the
 * network path; the connector supplies only its selector config + a row parser.
 */

/** Declarative config the extension's `genericScrape` interprets; forwarded verbatim as `scrape_config`. */
export interface ExtensionScrapeConfig {
  scroll?: { max?: number; stall?: number; waitMs?: number; deep?: boolean };
  loggedOutWhen?: { pathRegex?: string; hostRegex?: string };
  rowSelector?: string;
  /** Section/day grouping: iterate each `selector`, take its first text line as
   * the group label (when `labelFromFirstLine`), and emit a row per
   * `rowSelector` inside it. The engine reads `cfg.group.selector`. */
  group?: { selector: string; rowSelector: string; labelFromFirstLine?: boolean };
  id?: { source: string; name?: string; regex?: string; group?: number };
  requireFields?: readonly string[];
  fields?: Record<
    string,
    { selector?: string; take?: string; attr?: string; firstLine?: boolean; const?: unknown }
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

/** Dispatcher observation envelope; the index signature satisfies `ChromeActionOutput`. */
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

/**
 * Drive one content-script `cs_scrape` navigate and return parsed rows.
 * `persistent`/`focus` default true so a reused, focused window lets the user
 * clear an auth wall in place.
 */
export async function extensionDomScrape<TItem>(opts: {
  dispatcher: ChromeActionDispatcher;
  url: string;
  config: ExtensionScrapeConfig;
  parseRows: (rows: Array<Record<string, unknown>>) => TItem[];
  allowedOrigins: string[];
  persistent?: boolean;
  focus?: boolean;
}): Promise<ExtensionDomScrapeResult<TItem>> {
  const observation = await opts.dispatcher.dispatch<ExtensionScrapeObservation>('navigate', {
    cs_scrape: true,
    persistent: opts.persistent ?? true,
    focus: opts.focus ?? true,
    url: opts.url,
    scrape_config: opts.config,
    allowed_origins: opts.allowedOrigins,
  });
  const result = observation?.result;
  const items = opts.parseRows(result?.rows ?? []);
  return {
    items,
    loggedIn: result?.loggedIn !== false,
    count: result?.count ?? items.length,
    host: result?.host,
    landedUrl: result?.landedUrl,
  };
}
