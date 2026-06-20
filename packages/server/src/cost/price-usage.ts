/**
 * Token usage -> USD pricing for the cost ledger.
 *
 * Prices via `@pydantic/genai-prices`, which models context-tier (>200k) and
 * cache-read/cache-write pricing that pi-ai's flat per-token formula misses
 * (a >200k Anthropic run is otherwise undercharged ~43%). Org price overrides
 * win, since they are the only correct price for BYO / self-hosted / catalog-
 * absent models that would otherwise resolve to $0. Unknown models return
 * `usd: null, unpriced: true` — never a fake $0 that hides the gap.
 */

import { calcPrice, type Usage as GenaiUsage } from "@pydantic/genai-prices";

/**
 * Token buckets as captured from the worker, in pi-ai / Anthropic convention:
 * `input` is UNCACHED input only; `cacheRead`/`cacheWrite` are separate,
 * non-overlapping counts — NOT subsets of `input`.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Per-1M-token USD rates an org sets for a model the catalog can't price. */
export interface PriceOverride {
  inputMtok: number;
  outputMtok: number;
  cacheReadMtok: number;
  cacheWriteMtok: number;
}

export interface PricedUsage {
  /** Total USD, or null when neither an override nor the catalog can price it. */
  usd: number | null;
  /** True when `usd` is null because the model is unknown/unpriced. */
  unpriced: boolean;
  /** Where the price came from — for auditing the ledger row. */
  source: "catalog" | "override" | "unpriced";
}

/** Stored-provider -> genai-prices `providerId` aliases (mirror of the worker's
 * model-resolver aliasing; without this, z.ai falls through to the $0 path). */
const PROVIDER_ALIASES: Record<string, string> = {
  "z-ai": "zai",
};

function toCatalogProvider(provider: string): string {
  return PROVIDER_ALIASES[provider] ?? provider;
}

function priceWithOverride(usage: TokenUsage, o: PriceOverride): number {
  return (
    (usage.input * o.inputMtok +
      usage.output * o.outputMtok +
      usage.cacheRead * o.cacheReadMtok +
      usage.cacheWrite * o.cacheWriteMtok) /
    1_000_000
  );
}

/**
 * Resolve USD for one run's token usage.
 *
 * Token-semantics bridge: genai-prices treats `input_tokens` as the GRAND TOTAL
 * prompt tokens with `cache_read`/`cache_write` as SUBSETS, and throws if the
 * uncached remainder (`input_tokens - cache_*`) would be negative. We capture
 * the buckets SEPARATELY, so we reconstruct the grand total as
 * `input + cacheRead + cacheWrite` before calling — otherwise cache-heavy runs
 * mis-price or throw.
 *
 * `at` (the run's occurred_at) drives genai-prices' time-versioned pricing, so
 * a backfilled run is priced at the rate that was in effect on its own date.
 */
export function priceUsage(args: {
  usage: TokenUsage;
  provider: string;
  model: string;
  override?: PriceOverride | null;
  at?: Date;
}): PricedUsage {
  const { usage, provider, model, override, at } = args;

  if (override) {
    return {
      usd: priceWithOverride(usage, override),
      unpriced: false,
      source: "override",
    };
  }

  const genaiUsage: GenaiUsage = {
    input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
    output_tokens: usage.output,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
  };

  try {
    const result = calcPrice(genaiUsage, model, {
      providerId: toCatalogProvider(provider),
      ...(at ? { timestamp: at } : {}),
    });
    if (!result || !Number.isFinite(result.total_price)) {
      return { usd: null, unpriced: true, source: "unpriced" };
    }
    return { usd: result.total_price, unpriced: false, source: "catalog" };
  } catch {
    // Unknown model / unmappable provider / malformed usage — never bill $0.
    return { usd: null, unpriced: true, source: "unpriced" };
  }
}
