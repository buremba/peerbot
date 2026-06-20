/**
 * Token usage -> USD pricing for the cost ledger.
 *
 * Prices via `@pydantic/genai-prices`, which models context-tier (>200k) and
 * cache-read/cache-write pricing that pi-ai's flat per-token formula misses
 * (a >200k Anthropic run is otherwise undercharged ~43%). Unknown models —
 * including BYO / self-hosted / catalog-absent ones — return
 * `usd: null, unpriced: true`, never a fake $0 that hides the gap. (Per-org
 * price overrides for those models land with the price-override table in a
 * follow-up PR.)
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

export interface PricedUsage {
  /** Total USD, or null when the catalog can't price the model. */
  usd: number | null;
  /** True when `usd` is null because the model is unknown/unpriced. */
  unpriced: boolean;
  /** Where the price came from — for auditing the ledger row. */
  source: "catalog" | "unpriced";
}

/** Stored-provider -> genai-prices `providerId` aliases. genai-prices hosts the
 * GLM/Zhipu models under `zhipuai`; our transcripts stamp `zai` (and the CRUD
 * layer accepts `z-ai`), so without this they fall through to the unpriced
 * path. */
const PROVIDER_ALIASES: Record<string, string> = {
  zai: "zhipuai",
  "z-ai": "zhipuai",
};

function toCatalogProvider(provider: string): string {
  return PROVIDER_ALIASES[provider] ?? provider;
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
  at?: Date;
}): PricedUsage {
  const { usage, provider, model, at } = args;

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
