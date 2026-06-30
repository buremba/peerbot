import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineConnection,
  defineEntityType,
} from "@lobu/cli/config";
import type RevolutTransactionsConnector from "./revolut-transactions.connector.ts";

const personalAgent = defineAgent({
  id: "personal-agent",
  dir: ".",
  name: "personal-agent",
  description:
    "A personal agent that tracks finances, people, companies, subscriptions, trips, and topics across the user's own data.",
  // No cloud provider key: runs on the local/Mac-app device worker and inherits
  // the org's default provider. No ANTHROPIC_API_KEY needed.
  //
  // The Revolut connector no longer makes worker-side HTTP requests to Revolut:
  // it reads the rendered DOM through the paired Owletto Chrome extension, which
  // runs inside the user's own browser (its own network context), so the worker
  // egress allowlist no longer needs `app.revolut.com` / `.revolut.com`. We keep
  // the github/npm entries that the CLI uses to compile the connector.
  network: {
    allowed: [
      "github.com",
      ".github.com",
      ".githubusercontent.com",
      "registry.npmjs.org",
      ".npmjs.org",
    ],
  },
});

const person = defineEntityType({
  key: "person",
  name: "Person",
  description: "Team member, contact, or stakeholder",
  metadata: { icon: "user", color: "#8B5CF6" },
  properties: {
    role: { type: "string" },
    type: {
      type: "string",
      enum: ["employee", "client_contact", "partner", "external"],
    },
    email: { type: "string" },
    company: { type: "string" },
    session_prefix: { type: "string" },
  },
  // WhatsApp message metric (already live in prod). Declared here so `apply`
  // preserves it rather than pruning it — a person aliases their `sender_jid`,
  // and inbound messages on the local WhatsApp connector resolve to them.
  eventSets: {
    wa_messages: {
      by: "alias",
      field: "metadata->>'sender_jid'",
      against: "aliases",
      where: "connector_key='whatsapp.local'",
    },
  },
  measures: {
    messages_received: {
      eventSet: "wa_messages",
      agg: "count",
      where: "metadata->>'from_me'='false'",
      description: "WhatsApp messages received from this person.",
      tier: "silver",
    },
  },
  dimensions: {
    chat: {
      expr: "metadata->>'chat_jid'",
      description: "WhatsApp chat the message belongs to.",
    },
  },
});

const company = defineEntityType({
  key: "company",
  name: "Company",
  description: "Portfolio company or deal pipeline company",
  metadata: { icon: "building", color: "#2563eb" },
  properties: {
    mrr: { type: "number", description: "Monthly recurring revenue in USD" },
    stage: {
      type: "string",
      enum: [
        "preseed",
        "seed",
        "series_a",
        "series_b",
        "series_c",
        "growth",
        "public",
      ],
      description: "Current funding stage",
    },
    market: { type: "string", description: "Primary market vertical" },
    thesis: { type: "string", description: "Investment thesis notes" },
    revenue: { type: "number", description: "Annual revenue in USD" },
    location: { type: "string" },
    one_liner: { type: "string", description: "One-line pitch" },
    team_size: { type: "integer", minimum: 0 },
    valuation: { type: "number", description: "Last known valuation in USD" },
    growth_rate: { type: "number", description: "YoY growth rate as decimal" },
    linkedin_url: { type: "string", format: "uri" },
    founding_year: { type: "integer", maximum: 2030, minimum: 1900 },
    funding_raised: {
      type: "number",
      description: "Total funding raised in USD",
    },
    traction_score: {
      type: "number",
      maximum: 100,
      minimum: 0,
      description: "Computed traction score",
    },
    traction_signals: {
      type: "object",
      properties: {
        hiring: { type: "number" },
        last_updated: { type: "string", format: "date-time" },
        news_coverage: { type: "number" },
        github_velocity: { type: "number" },
        social_mentions: { type: "number" },
        app_store_growth: { type: "number" },
        review_sentiment: { type: "number" },
      },
    },
  },
});

// GBP-equivalent of a transaction amount, using ONLY exact, Revolut-booked
// values — never a fuzzy FX-rate lookup:
//   • native GBP                       → the amount itself
//   • foreign card payment converted   → `counterpart_amount` (the GBP side
//     Revolut actually moved; present when `counterpart_currency = 'GBP'`)
//   • multi-currency pocket spend      → NULL. There is no GBP figure on the
//     transaction (the pocket was funded earlier by a GBP→ccy EXCHANGE); the
//     GBP cost is realised on that exchange, so we deliberately don't guess
//     here. `SUM(gbp)` therefore ignores these rows rather than double-counting
//     or inventing a rate. The stored per-transaction `fx_rate` is NOT used —
//     its direction is inconsistent across currencies (USD stores ccy→GBP,
//     VND stores GBP→ccy), so `amount * fx_rate` is unsafe.
const gbpAmountSql = `CASE
    WHEN metadata->>'currency' = 'GBP' THEN nullif(metadata->>'amount', '')::numeric
    WHEN metadata->>'counterpart_currency' = 'GBP' THEN nullif(metadata->>'counterpart_amount', '')::numeric
    ELSE NULL
  END`;

// Pocket-spend fallback rate. A spend from a multi-currency pocket (USD/EUR
// charges from a USD/EUR balance) carries no per-transaction GBP — there is no
// exact figure to read. Rather than leave those costs null or invent a market
// rate, we convert at the user's OWN realised rate: the average GBP-per-unit
// across their actual conversions (rows where `counterpart_currency = 'GBP'`).
// It's their real, data-grounded rate (USD ≈ 0.76, EUR ≈ 0.85), and it self-
// updates as they transact. Returns NULL for a currency they've never converted,
// so the caller can still distinguish "estimated" from "truly unknown".
const realizedGbpRateSql = (ccyExpr: string) => `(
    SELECT round(avg(
      nullif(r.metadata->>'counterpart_amount', '')::numeric
      / nullif(nullif(r.metadata->>'amount', '')::numeric, 0)
    ), 6)
    FROM events r
    WHERE r.semantic_type = 'transaction'
      AND r.metadata->>'counterpart_currency' = 'GBP'
      AND r.metadata->>'currency' = ${ccyExpr}
      AND nullif(r.metadata->>'amount', '')::numeric > 0
      AND nullif(r.metadata->>'counterpart_amount', '')::numeric > 0
  )`;

// Spend rows we treat as real consumption: a COMPLETED outbound CARD_PAYMENT.
// This single predicate removes the three classes that polluted the old views:
//   • DECLINED / FAILED / REVERTED / DELETED states (money never moved — e.g.
//     the "Hydra" £600k was 12 DECLINED charge attempts), and
//   • TRANSFER / EXCHANGE / ATM / FEE / SAVINGS types (own-money movement, not
//     spend — e.g. "Personal → Joint", "Bought GBP with USD", "Ultra Plan Fee").
const completedCardSpendWhere = `semantic_type = 'transaction'
    AND metadata->>'state' = 'COMPLETED'
    AND metadata->>'transaction_type' = 'CARD_PAYMENT'
    AND metadata->>'direction' = 'out'`;

const asset = defineEntityType({
  key: "asset",
  name: "Asset",
  description:
    "Things you own with monetary value - bank accounts, property, investments, vehicles, devices",
  metadata: { icon: "💰", color: "#10B981" },
  required: ["category"],
  properties: {
    value: { type: "number", description: "Current value or balance" },
    status: {
      type: "string",
      enum: ["active", "sold", "closed"],
      description: "Current status",
    },
    category: {
      type: "string",
      enum: [
        "financial-account",
        "property",
        "investment",
        "vehicle",
        "device",
      ],
      description: "Type of asset",
    },
    currency: { type: "string", description: "Currency code (GBP, USD, etc)" },
    acquired_date: {
      type: "string",
      format: "date",
      description: "When acquired",
    },
  },
  // Governed spend metrics over the Revolut transaction stream. The eventSet
  // resolves a transaction to an account by matching its `currency` against the
  // account asset's aliases. The buremba org runs a single consolidated Revolut
  // account, so that one asset is aliased with EVERY currency it transacts in
  // (GBP, USD, EUR, …) and owns all transactions; `currency` is then a
  // dimension, not a separate entity per pocket. Because the measure is
  // GBP-normalised, the per-account roll-up is a valid single GBP total. Aliases
  // are entity data, not schema — seed them with
  // examples/personal-agent/seed-asset-aliases.sql.
  eventSets: {
    transactions: {
      by: "alias",
      field: "metadata->>'currency'",
      reads: "current",
    },
  },
  segments: {
    card_spend: {
      description:
        "Completed outbound card payments only (excludes declined/reverted charges and transfers/exchanges/ATM/fees).",
      where: completedCardSpendWhere,
      on: "event",
    },
  },
  measures: {
    spend: {
      eventSet: "transactions",
      agg: "sum",
      expr: gbpAmountSql,
      segments: ["card_spend"],
      description:
        "Total card spend in GBP. Exact only (native GBP + Revolut-booked GBP counterpart); foreign pocket spend is excluded here and accounted at the funding exchange.",
      tier: "gold",
    },
    transaction_count: {
      eventSet: "transactions",
      agg: "count",
      segments: ["card_spend"],
      description: "Number of completed card payments.",
      tier: "gold",
    },
  },
  dimensions: {
    category: {
      expr: "metadata->>'category'",
      description:
        "Revolut spend category (restaurants, groceries, travel, services, …).",
    },
    month: {
      expr: "to_char(occurred_at, 'YYYY-MM')",
      description: "Calendar month of the transaction (YYYY-MM).",
    },
    currency: {
      expr: "metadata->>'currency'",
      description: "Transaction currency (ISO 4217).",
    },
    merchant_country: {
      expr: "metadata->>'merchant_country'",
      description: "Merchant country (ISO 3166-1 alpha-2).",
    },
  },
});

// Subscriptions are derived from repeated COMPLETED card payments. We trust two
// signals, OR'd: (1) Revolut's own `is_subscription` mandate flag (high
// precision, but only on recently-detected mandates), and (2) a recurrence
// heuristic for older history — a stable monthly charge (low amount variance)
// in a subscription-like category. The category exclusion + low-variance test
// keep frequent restaurants/groceries (which the old blocklist chased by hand)
// from masquerading as subscriptions.
const subscriptionBackingSql = `
WITH card AS (
  SELECT
    occurred_at,
    occurred_at::date AS tx_date,
    max(occurred_at::date) OVER () AS data_as_of,
    coalesce(
      nullif(metadata->>'merchant_brand_id', ''),
      lower(regexp_replace(coalesce(metadata->>'description', payload_text, 'unknown'), '[^a-z0-9]+', ' ', 'g'))
    ) AS merchant_key,
    coalesce(metadata->>'description', payload_text, 'Unknown') AS merchant_name,
    nullif(metadata->>'amount', '')::numeric AS amount,
    coalesce(metadata->>'currency', 'GBP') AS currency,
    metadata->>'category' AS category,
    (metadata->>'is_subscription') = 'true' AS flagged,
    ${gbpAmountSql} AS gbp
  FROM events
  WHERE ${completedCardSpendWhere}
    AND nullif(metadata->>'amount', '') IS NOT NULL
)
SELECT
  'subscription:' || md5(merchant_key || ':' || currency) AS id,
  regexp_replace(initcap(max(merchant_name)), '\\s+', ' ', 'g') AS name,
  'subscription-' || md5(merchant_key || ':' || currency) AS slug,
  CASE
    WHEN max(tx_date) >= max(data_as_of) - interval '45 days' THEN 'active'
    WHEN max(tx_date) >= max(data_as_of) - interval '120 days' THEN 'changed'
    ELSE 'cancelled'
  END AS status,
  'subscription' AS category,
  currency,
  CASE
    WHEN count(*) <= count(distinct date_trunc('month', occurred_at)) + 2 THEN 'monthly'
    ELSE 'periodic'
  END AS frequency,
  round((array_agg(amount ORDER BY occurred_at DESC))[1], 2) AS amount,
  min(tx_date)::text AS first_seen,
  max(tx_date)::text AS last_seen,
  round(avg(extract(day from occurred_at)))::int AS billing_day,
  round(sum(amount), 2) AS total_spent,
  nullif(
    round(
      coalesce(sum(gbp), 0)
      + coalesce(sum(amount) FILTER (WHERE gbp IS NULL), 0)
        * coalesce(${realizedGbpRateSql("max(card.currency)")}, 0),
      2
    ),
    0
  ) AS total_spent_gbp,
  count(*)::int AS charge_count,
  count(distinct date_trunc('month', occurred_at))::int AS active_months
FROM card
GROUP BY merchant_key, currency
HAVING bool_or(flagged)
   OR (
     count(distinct date_trunc('month', occurred_at)) >= 4
     AND max(category) NOT IN ('restaurants', 'groceries', 'transport', 'cash', 'general')
     AND coalesce(stddev_pop(amount), 0) <= avg(amount) * 0.2
     AND count(*) <= count(distinct date_trunc('month', occurred_at)) + 2
     AND sum(amount) >= 20
   )
ORDER BY total_spent DESC
`;

const subscription = defineEntityType({
  key: "subscription",
  name: "Subscription",
  description:
    "Recurring costs and obligations derived from repeated transaction patterns",
  metadata: { icon: "🔄", color: "#EF4444" },
  backing: { sql: subscriptionBackingSql },
  properties: {
    amount: {
      type: "number",
      description: "Current charge amount",
      "x-table-column": true,
      "x-table-label": "Amount",
    },
    status: {
      type: "string",
      enum: ["active", "cancelled", "changed"],
      description: "Current status",
      "x-table-column": true,
      "x-table-label": "Status",
    },
    category: {
      type: "string",
      enum: ["subscription", "bill", "insurance", "membership"],
      description: "Type of expense",
    },
    currency: { type: "string", description: "Currency code" },
    frequency: {
      type: "string",
      enum: ["monthly", "annual", "periodic"],
      description: "How often charged",
    },
    last_seen: {
      type: "string",
      format: "date",
      "x-table-column": true,
      "x-table-label": "Last Seen",
    },
    first_seen: { type: "string", format: "date" },
    billing_day: {
      type: "number",
      description: "Day of month typically charged",
    },
    total_spent: {
      type: "number",
      description:
        "Total charged over the tracked period, in the charge currency",
      "x-table-column": true,
      "x-table-label": "Total",
    },
    total_spent_gbp: {
      type: "number",
      description:
        "Total in GBP: exact where known (native GBP + Revolut-booked GBP counterpart), and pocket charges (USD/EUR) valued at the user's own realised conversion rate",
    },
    charge_count: { type: "integer" },
    active_months: { type: "integer" },
  },
});

const topic = defineEntityType({
  key: "topic",
  name: "Topic",
  description:
    "Generic topic or category for organizing content and connections",
  metadata: { icon: "📚", color: "#8B5CF6" },
  properties: {
    description: { type: "string" },
  },
});

// Trips are clusters of COMPLETED card payments in a NON-home country,
// concentrated in time. We key on `merchant_country` (a single trip mixes
// VND/USD/GBP, so the old currency-clustering was wrong) per calendar month.
// The country denylist drops home (GB/GBR) plus the online-merchant domiciles
// (IE/LU/EE) that surface as bogus "trips" spread across years.
//
// A real trip is a SHORT, VARIED burst — so beyond the >= 6 transaction count
// we require span <= 16 days and >= 3 distinct categories. That distinguishes
// travel (concentrated, restaurants + transport + shopping in a couple of
// weeks) from steady online spend billed abroad (US-domiciled SaaS: spread
// across the whole month, one or two service categories) which otherwise
// surfaced as a monthly "US trip".
//
// GBP cost is the sum of two exact sources, never a guessed FX rate:
//   • gbp_known  — native GBP + Revolut-booked GBP counterpart on the trip's
//                  own card payments.
//   • gbp_funded — GBP exchanged INTO the trip's local currency around the trip
//                  window (a Revolut "Exchanged to <ccy>" event). This recovers
//                  the cost of pocket spend, which carries no per-transaction
//                  GBP (e.g. a VND-pocket Vietnam trip: £688 on cards + £1,500
//                  exchanged to VND). gbp_cost = gbp_known + gbp_funded.
const tripBackingSql = `
WITH tx AS (
  SELECT
    metadata->>'merchant_country' AS country,
    date_trunc('month', occurred_at) AS mon,
    coalesce(metadata->>'currency', 'GBP') AS currency,
    metadata->>'category' AS category,
    nullif(metadata->>'amount', '')::numeric AS amount,
    ${gbpAmountSql} AS gbp,
    occurred_at::date AS d
  FROM events
  WHERE ${completedCardSpendWhere}
    AND nullif(metadata->>'amount', '') IS NOT NULL
    AND metadata->>'merchant_country' IS NOT NULL
    AND metadata->>'merchant_country' NOT IN ('', 'GB', 'GBR', 'IE', 'LU', 'EE')
)
SELECT
  'trip:' || country || ':' || to_char(mon, 'YYYY-MM') AS id,
  country || ' trip (' || min(d)::text || ' to ' || max(d)::text || ')' AS name,
  'trip-' || lower(country) || '-' || to_char(mon, 'YYYY-MM') AS slug,
  country AS destination,
  min(d)::text AS start_date,
  max(d)::text AS end_date,
  mode() WITHIN GROUP (ORDER BY currency) AS local_currency,
  round(sum(gbp), 2) AS gbp_known,
  nullif(
    round(
      -- exact card GBP (native + GBP counterpart)
      coalesce(sum(gbp), 0)
      -- plus the pocket-spend cost: the GBP exchanged into the local currency
      -- around the trip (exact) when present, else the untraced pocket spend
      -- valued at the user's realised rate (covers long-held USD/EUR pockets
      -- with no in-window exchange).
      + coalesce(
          nullif((
            SELECT coalesce(sum(nullif(e.metadata->>'amount', '')::numeric), 0)
            FROM events e
            WHERE e.semantic_type = 'transaction'
              AND e.metadata->>'transaction_type' = 'EXCHANGE'
              AND e.metadata->>'state' = 'COMPLETED'
              AND e.metadata->>'currency' = 'GBP'
              AND e.metadata->>'direction' = 'out'
              AND e.metadata->>'description' = 'Exchanged to ' || mode() WITHIN GROUP (ORDER BY tx.currency)
              AND e.occurred_at::date BETWEEN min(tx.d) - 21 AND max(tx.d) + 3
          ), 0),
          coalesce(sum(amount) FILTER (WHERE gbp IS NULL), 0)
            * coalesce(${realizedGbpRateSql("mode() WITHIN GROUP (ORDER BY tx.currency)")}, 0)
        ),
      2
    ),
    0
  ) AS gbp_cost,
  string_agg(DISTINCT currency, ',' ORDER BY currency) AS currencies,
  count(*)::int AS transaction_count,
  CASE WHEN (max(d) - min(d)) <= 10 AND count(*) >= 12 THEN 'high' ELSE 'medium' END AS confidence
FROM tx
GROUP BY country, mon
HAVING count(*) >= 6 AND (max(d) - min(d)) <= 16 AND count(DISTINCT category) >= 3
ORDER BY start_date DESC
`;

const trip = defineEntityType({
  key: "trip",
  name: "Trip",
  description:
    "Travel derived from time-concentrated card spend in a non-home country",
  metadata: { icon: "✈️", color: "#F59E0B" },
  backing: { sql: tripBackingSql },
  properties: {
    destination: {
      type: "string",
      description: "Merchant country code (ISO 3166-1 alpha-2)",
      "x-table-column": true,
      "x-table-label": "Destination",
    },
    start_date: {
      type: "string",
      format: "date",
      "x-table-column": true,
      "x-table-label": "Start",
    },
    end_date: {
      type: "string",
      format: "date",
      "x-table-column": true,
      "x-table-label": "End",
    },
    local_currency: {
      type: "string",
      description: "Dominant currency spent on the trip",
    },
    local_spend: {
      type: "number",
      description: "Spend in the dominant local currency (exact)",
      "x-table-column": true,
      "x-table-label": "Local spend",
    },
    gbp_cost: {
      type: "number",
      description:
        "Best GBP estimate of the trip: exact card GBP, plus pocket cost — GBP exchanged into the local currency around the trip, or (for long-held pockets with no in-window exchange) pocket spend at the user's realised rate",
      "x-table-column": true,
      "x-table-label": "GBP cost",
    },
    gbp_known: {
      type: "number",
      description:
        "GBP spent directly on cards, known exactly (native GBP + GBP counterpart)",
    },
    gbp_funded: {
      type: "number",
      description:
        "GBP exchanged into the local currency around the trip window (funds pocket spend)",
    },
    currencies: {
      type: "string",
      description: "All currencies spent on the trip, comma-separated",
    },
    transaction_count: { type: "integer" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
});

// Goals and learnings are agent-curated, not derived from a feed: the agent
// writes them with save_memory and updates them as it observes the user. They
// are stored entity types (no `backing`). The human-AI field-ownership loop
// (a human edit pinning a field the agent must then respect) is a later layer;
// for now these capture the agent's working model of what the user is trying to
// do and what it has learned about them.
const goal = defineEntityType({
  key: "goal",
  name: "Goal",
  description:
    "A personal objective the agent tracks and helps make progress on",
  metadata: { icon: "🎯", color: "#0EA5E9" },
  properties: {
    status: {
      type: "string",
      enum: ["active", "achieved", "paused", "abandoned"],
      description: "Current status",
      "x-table-column": true,
      "x-table-label": "Status",
    },
    category: {
      type: "string",
      description:
        "Area of life (finance, health, career, travel, learning, …)",
    },
    target_date: {
      type: "string",
      format: "date",
      description: "When the user wants to reach it",
      "x-table-column": true,
      "x-table-label": "Target",
    },
    progress: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "Percent complete (0–100)",
      "x-table-column": true,
      "x-table-label": "Progress",
    },
    metric: {
      type: "string",
      description:
        "How progress is measured — ideally a declared metric (e.g. asset.spend) the agent can query",
    },
    description: { type: "string" },
  },
});

const learning = defineEntityType({
  key: "learning",
  name: "Learning",
  description:
    "Something the agent has learned about the user or their world worth retaining",
  metadata: { icon: "💡", color: "#A855F7" },
  properties: {
    topic: {
      type: "string",
      description: "What the learning is about",
      "x-table-column": true,
      "x-table-label": "Topic",
    },
    source: {
      type: "string",
      description: "Where it was learned (conversation, watcher, observation)",
    },
    learned_date: {
      type: "string",
      format: "date",
      "x-table-column": true,
      "x-table-label": "Date",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      "x-table-column": true,
      "x-table-label": "Confidence",
    },
    tags: { type: "array", items: { type: "string" } },
    description: { type: "string" },
  },
});

// Revolut auth is implicit: the connector reads the rendered web app through
// the paired Owletto Chrome extension's signed-in session — there's no stored
// secret and no browser-auth profile to grant.
//
// Not device-pinned: the connector's sync() runs on a cloud Node worker and
// dispatches its DOM-scrape actions down to whichever online paired Owletto
// extension claims them (same model as LinkedIn). This is what makes Revolut
// "extension-only" from the user's side — no Owletto Mac app required, just the
// Chrome extension signed in to app.revolut.com. max_scrolls is capped so a
// single run fits inside the extension's 90s per-run cap (≈150s at 100 scrolls
// always timed out); 20 scrolls (~55s) reliably completes, and scheduled
// incremental syncs keep history current from the top each run.
const revolutConnection = defineConnection({
  slug: "revolut-buremba",
  connector: "revolut",
  name: "Revolut",
  feeds: [{ feed: "transactions", config: { max_scrolls: 20 } }],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof RevolutTransactionsConnector>(
      "./revolut-transactions.connector.ts"
    ),
  ],
  org: "buremba",
  orgName: "Buremba",
  orgDescription:
    "Personal agent tracking finances, people, companies, subscriptions, trips, and topics.",
  agents: [personalAgent],
  entities: [person, company, asset, subscription, topic, trip, goal, learning],
  connections: [revolutConnection],
});
