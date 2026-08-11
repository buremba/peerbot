/**
 * World-model entities for the live-portfolio path.
 *
 * A SHALLOW entity model: a listed company or fund is described by a small,
 * flat set of properties — never a generic instrument entity, never a fund
 * subtype of company. Funds link to their manager/sponsor company via a
 * `managed_by` / `sponsored_by` relationship, not by inheritance.
 *
 * These descriptors are the RESOLUTION TABLE, not a database model: they tell
 * the portfolio path which public `company` / `fund` entity a Midas holding's
 * (market, symbol) maps to, and what quoting identity it carries. Nothing here
 * persists holdings; the Midas events remain the source of truth.
 *
 * Ticker identity is (market/exchange, symbol) — never symbol alone. Fallback
 * keys are `US:NVDA`, `TR:THYAO` style; an exchange MIC is preferred when one
 * is already available. No FIGI/OpenFIGI is introduced.
 */

/** A company or fund. Funds are NOT a subtype of company — separate entity_type. */
export type WorldEntityType = "company" | "fund";

/** A single listing of the entity on an exchange. */
export interface WorldListing {
  symbol: string;
  exchangeMic?: string | null;
  currency?: string | null;
  isPrimary?: boolean;
}

/**
 * Shallow descriptor for a company or fund entity in a public Market catalog.
 * Every field optional except the essentials; extra catalog fields are allowed
 * and preserved by callers.
 */
export interface WorldEntity {
  /** entity_type — 'company' | 'fund'. */
  entityType: WorldEntityType;
  /** Canonical display name (e.g. "NVIDIA"). */
  name: string;
  /** Primary ticker for the entity's home market. */
  primaryTicker?: string | null;
  /** Exchange MIC of the primary listing (e.g. XNAS) or market name. */
  primaryExchange?: string | null;
  /** Trading currency of the primary listing. */
  currency?: string | null;
  /** All known listings. */
  listings?: WorldListing[];
  /**
   * Funds only: what the fund tracks/benchmarks when known (e.g. "S&P 500").
   * `fund_type` distinguishes e.g. 'etf' | 'mutual_fund' | 'commodity'.
   */
  fundType?: string | null;
  benchmark?: string | null;
  /**
   * Relationship target (a company entity key or name) for
   * `fund --managed_by--> company` (or `sponsored_by` when legally accurate).
   */
  managedBy?: string | null;
  sponsoredBy?: string | null;
}

/** Stable key for a world entity, usable as a catalog lookup key. */
export type WorldEntityKey = string;

/**
 * The canonical, curated world-model resolution table used by the portfolio
 * path. Midas holdings carry (market, symbol); this maps them to a shallow
 * company/fund descriptor. DELIBERATELY SMALL — only exact, known mappings.
 * Unknown symbols (e.g. ALTIN.S1 with no exact mapping) resolve to `null` and
 * the caller must surface an explicit unresolved state, never a guess.
 */
export const WORLD_ENTITIES: Record<string, WorldEntity> = {
  // ── Companies (US) ──────────────────────────────────────────────────
  "US:NVDA": {
    entityType: "company",
    name: "NVIDIA",
    primaryTicker: "NVDA",
    primaryExchange: "XNAS",
    currency: "USD",
    listings: [
      { symbol: "NVDA", exchangeMic: "XNAS", currency: "USD", isPrimary: true },
    ],
  },
  "US:AAPL": {
    entityType: "company",
    name: "Apple",
    primaryTicker: "AAPL",
    primaryExchange: "XNAS",
    currency: "USD",
    listings: [
      { symbol: "AAPL", exchangeMic: "XNAS", currency: "USD", isPrimary: true },
    ],
  },
  "US:MSFT": {
    entityType: "company",
    name: "Microsoft",
    primaryTicker: "MSFT",
    primaryExchange: "XNAS",
    currency: "USD",
    listings: [
      { symbol: "MSFT", exchangeMic: "XNAS", currency: "USD", isPrimary: true },
    ],
  },
  // ── Companies (Turkey / BIST) ───────────────────────────────────────
  "TR:THYAO": {
    entityType: "company",
    name: "Turkish Airlines",
    primaryTicker: "THYAO",
    primaryExchange: "XBIST",
    currency: "TRY",
    listings: [
      {
        symbol: "THYAO",
        exchangeMic: "XBIST",
        currency: "TRY",
        isPrimary: true,
      },
    ],
  },
  // ── Funds ───────────────────────────────────────────────────────────
  "US:SPY": {
    entityType: "fund",
    name: "SPDR S&P 500 ETF Trust",
    primaryTicker: "SPY",
    primaryExchange: "XASE",
    currency: "USD",
    listings: [
      { symbol: "SPY", exchangeMic: "XASE", currency: "USD", isPrimary: true },
    ],
    fundType: "etf",
    benchmark: "S&P 500",
  },
  "US:IAU": {
    entityType: "fund",
    name: "iShares Gold Trust",
    primaryTicker: "IAU",
    primaryExchange: "XASE",
    currency: "USD",
    listings: [
      { symbol: "IAU", exchangeMic: "XASE", currency: "USD", isPrimary: true },
    ],
    fundType: "etf",
    benchmark: "Gold spot price",
  },
};

/**
 * Identity key for a Midas holding's acquisition: `(market, symbol)`.
 *
 * `market` is the Midas market ("US" | "TR"), which is exactly the quoting
 * market for these holdings. When an exchange MIC is already known it is
 * preferred, but the Midas connector exposes only the market — the key is the
 * market-scoped identity the mission requires.
 */
export function tickerIdentityKey(market: string, symbol: string): string {
  const m = market.trim().toUpperCase();
  const s = symbol.trim().toUpperCase();
  if (!m || !s) return "";
  return `${m}:${s}`;
}

/**
 * Resolve a Midas (market, symbol) to a world entity, or `null` when there is
 * NO exact known mapping. Explicit unresolved state, never a guess.
 */
export function resolveWorldEntity(
  market: string,
  symbol: string
): WorldEntity | null {
  return WORLD_ENTITIES[tickerIdentityKey(market, symbol)] ?? null;
}

/**
 * The canonical catalog entity key for a resolved world entity, or `null` when
 * unresolved. The public Market catalog is expected to key company/fund
 * entities by this value.
 */
export function worldEntityCatalogKey(
  market: string,
  symbol: string
): string | null {
  const resolved = resolveWorldEntity(market, symbol);
  return resolved ? tickerIdentityKey(market, symbol) : null;
}

/** All (market, symbol) holdings the world model currently knows. */
export function knownTickerIdentities(): string[] {
  return Object.keys(WORLD_ENTITIES);
}
