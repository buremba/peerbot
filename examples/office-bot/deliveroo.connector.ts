/**
 * Deliveroo Connector
 *
 * Reads a restaurant's Deliveroo menu via the paired Owletto Chrome extension's
 * content-script scrape primitive. No Playwright, no cookie cache: the menu is
 * read off the office's real Chrome (the office account is signed into
 * deliveroo.co.uk there). Deliveroo menu pages are server-rendered — the menu
 * is in the DOM, not a separate XHR — so we use `extensionDomScrape` (a content
 * script, no CDP debugger) with the menu-item selectors below, rather than
 * `extensionNetworkSync`.
 *
 * Reading only. There is no checkout/order path here — the agent assembles the
 * order from these menu items and a human places it.
 */

import {
  type ChromeActionDispatcher,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  extensionDomScrape,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

// ── Scrape contract (derived from the live deliveroo.co.uk menu DOM) ─────────
//
// Each menu item renders as `div[class*="MenuItemCardV2-"]`. Inside the card the
// classes are hashed (`ccl-*`) with no stable testids on name/price, so we grab
// the name (first <p>) plus the whole card text and parse price/kcal/description
// out of it — the same "scrape body, parse fields" shape LinkedIn's home feed
// uses. Item card text looks like: "1/2 Chicken Meal A chicken breast… 579 kcal £18.20 £20.95".

const DELIVEROO_ALLOWED_ORIGINS = ["deliveroo.co.uk", "*.deliveroo.co.uk"];

const MENU_SCRAPE_CONFIG = {
  scroll: { max: 12, stall: 4, waitMs: 1200, deep: true },
  // Menus are public, but a login/age wall would replace the menu — bail clearly.
  loggedOutWhen: { pathRegex: "/(account/login|login)\\b" },
  rowSelector: 'div[class*="MenuItemCardV2-"]',
  requireFields: ["name"],
  fields: {
    // First <p> in the card is the item name.
    name: { selector: "p", take: "text", firstLine: true },
    // Whole card text — price/kcal/description are parsed out of this.
    text: { take: "text" },
  },
} as const;

/** A raw scraped menu row (one item card). */
interface MenuRow {
  name?: string;
  text?: string;
}

interface MenuItem {
  name: string;
  /** Display price, e.g. "£18.20" (the current price; a struck-through was-price is ignored). */
  price?: string;
  /** Price in pence, for downstream budget math. */
  priceMinor?: number;
  description?: string;
  kcal?: number;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Parse a scraped card into a structured menu item. The card text concatenates
 * name, description, "N kcal", then one or more "£X.XX" prices (the first is the
 * current price; a second is a struck-through original). We key off the name (a
 * clean field) and pull price/kcal out of the remaining text.
 */
export function parseMenuRows(rows: MenuRow[]): MenuItem[] {
  const seen = new Set<string>();
  const items: MenuItem[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const text = (row.text ?? "").replace(/\s+/g, " ").trim();
    const priceMatch = text.match(/£\s?(\d+(?:\.\d{1,2})?)/);
    const kcalMatch = text.match(/(\d+)\s*kcal/i);

    // Description = card text with the leading name, the "N kcal", and any £
    // prices removed. Best-effort — Deliveroo doesn't expose a clean field.
    let description = text;
    if (description.startsWith(name))
      description = description.slice(name.length);
    description = description
      .replace(/\d+\s*kcal/gi, "")
      .replace(/£\s?\d+(?:\.\d{1,2})?/g, "")
      .replace(/\s+/g, " ")
      .trim();

    items.push({
      name,
      price: priceMatch ? `£${priceMatch[1]}` : undefined,
      priceMinor: priceMatch
        ? Math.round(Number.parseFloat(priceMatch[1]) * 100)
        : undefined,
      description: description || undefined,
      kcal: kcalMatch ? Number.parseInt(kcalMatch[1], 10) : undefined,
    });
  }
  return items;
}

/**
 * Pull the chrome action dispatcher from sessionState — the connector-worker
 * splices a live `chrome_dispatcher` onto each sync; it rides IPC up to the
 * gateway's chrome-action bridge and out to the paired Owletto extension. With
 * no online extension in the connection's org, the dispatcher throws.
 */
function requireExtensionDispatcher(ctx: SyncContext): ChromeActionDispatcher {
  const handle = (
    ctx.sessionState as Record<string, unknown> | null | undefined
  )?.chrome_dispatcher as ChromeActionDispatcher | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "Deliveroo connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — run on a connector-worker with the dispatcher bridge and an online extension."
    );
  }
  return handle;
}

const menuConfigSchema = {
  type: "object",
  required: ["restaurant_url"],
  properties: {
    restaurant_url: {
      type: "string",
      description:
        'Deliveroo restaurant menu URL (e.g. "https://deliveroo.co.uk/menu/London/the-city/nandos-lime-street/?fulfillment_method=DELIVERY")',
    },
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      default: 12,
      description:
        "Maximum scroll iterations to load the full menu (default: 12)",
    },
  },
};

export default class DeliverooConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "deliveroo",
    name: "Deliveroo",
    description:
      "Reads a restaurant's Deliveroo menu via the paired Owletto Chrome extension. Auth is implicit (the office account is signed into deliveroo.co.uk in that Chrome). Reading only — no checkout.",
    version: "1.0.0",
    faviconDomain: "deliveroo.co.uk",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      menu: {
        key: "menu",
        name: "Restaurant Menu",
        description:
          "Menu items (name, price, description) for one Deliveroo restaurant.",
        configSchema: menuConfigSchema,
        eventKinds: {
          menu_item: {
            description: "A single Deliveroo menu item.",
            metadataSchema: {
              type: "object",
              properties: {
                price: { type: "string" },
                price_minor: { type: "number" },
                kcal: { type: "number" },
              },
            },
          },
        },
      },
    },
    optionsSchema: menuConfigSchema,
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as Record<string, unknown>;
    const url = (config.restaurant_url as string)?.trim();
    if (!url) {
      throw new Error("restaurant_url is required");
    }
    const maxScrolls = (config.max_scrolls as number) ?? 12;
    const dispatcher = requireExtensionDispatcher(ctx);

    const { items: rows, loggedIn } = await extensionDomScrape<MenuRow>({
      dispatcher,
      url,
      config: {
        ...MENU_SCRAPE_CONFIG,
        scroll: { ...MENU_SCRAPE_CONFIG.scroll, max: maxScrolls },
      },
      parseRows: (raw) => raw as MenuRow[],
      allowedOrigins: DELIVEROO_ALLOWED_ORIGINS,
    });

    if (!loggedIn) {
      throw new Error(
        "Deliveroo menu could not be read — a login/age wall blocked the page. Sign into deliveroo.co.uk in the focused Owletto window, then re-run."
      );
    }

    const items = parseMenuRows(rows);
    const occurredAt = new Date();
    const urlSlug = slugify(new URL(url).pathname);

    const events: EventEnvelope[] = items.map((item) => ({
      origin_id: `deliveroo_${urlSlug}_${slugify(item.name)}`,
      payload_text: item.description
        ? `${item.name} — ${item.description}`
        : item.name,
      title: item.name,
      occurred_at: occurredAt,
      origin_type: "menu_item",
      source_url: url,
      metadata: {
        price: item.price,
        price_minor: item.priceMinor,
        kcal: item.kcal,
      },
    }));

    return {
      events,
      // The menu is a full snapshot each run — nothing incremental to checkpoint.
      checkpoint: {},
      metadata: {
        items_found: events.length,
        items_scraped: rows.length,
        backend: "extension-cs-scrape",
      },
    };
  }
}
