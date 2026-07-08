import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineConnection,
  defineEntityType,
} from "@lobu/cli/config";
import type GoogleTakeoutConnector from "./google-takeout.connector.ts";
import type InstagramTakeoutConnector from "./instagram-takeout.connector.ts";
import type LinkedInConnector from "./linkedin.connector.ts";
import type RevolutTransactionsConnector from "./revolut-transactions.connector.ts";
import type SpotifyConnector from "./spotify.connector.ts";
import type TwitterTakeoutConnector from "./twitter-takeout.connector.ts";
import type WhatsAppCloudConnector from "./whatsapp.cloud.connector.ts";

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
    first_name: { type: "string" },
    last_name: { type: "string" },
    linkedin_url: { type: "string" },
    twitter_handle: { type: "string" },
    instagram_handle: { type: "string" },
  },
  // WhatsApp + X identity metrics. Declared here so `apply` preserves them
  // rather than pruning — persons alias connector identities (wa_jid, x_handle).
  eventSets: {
    wa_messages: {
      by: "alias",
      field: "metadata->>'sender_jid'",
      against: "aliases",
      where: "connector_key='whatsapp.local'",
    },
    x_posts: {
      by: "alias",
      field: "metadata->>'author_handle'",
      against: "aliases",
      where:
        "connector_key='x' AND origin_type IN ('tweet','reply','liked_tweet','bookmark')",
    },
    x_dms: {
      by: "alias",
      field: "metadata->>'participant_handle'",
      against: "aliases",
      where: "connector_key='x' AND origin_type='dm_message'",
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
    x_posts_seen: {
      eventSet: "x_posts",
      agg: "count",
      description:
        "X posts involving this person as author (timeline, likes, bookmarks).",
      tier: "silver",
    },
    x_dms_received: {
      eventSet: "x_dms",
      agg: "count",
      where: "metadata->>'from_me'='false'",
      description: "Inbound X DMs with this person.",
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
  // account asset's aliases. This example assumes a single consolidated Revolut
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

// Trips are stored from explicit travel evidence such as passport stamps.
// Related transaction/photo windows are attached through event sets below.
const trip = defineEntityType({
  key: "trip",
  name: "Trip",
  description: "Travel derived from passport stamps",
  metadata: { icon: "✈️", color: "#F59E0B" },
  properties: {
    destination: {
      type: "string",
      description: "Destination of the trip",
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
    event_type: { type: "string" },
    notes: { type: "string" },
  },
  eventSets: {
    transactions: {
      by: "window",
      start: "start_date",
      end: "end_date",
      where: completedCardSpendWhere,
    },
    photos: {
      by: "window",
      start: "start_date",
      end: "end_date",
      where: "connector_id = 'apple-photos'",
    },
  },
  measures: {
    photo_count: {
      eventSet: "photos",
      agg: "count",
      description: "Number of Apple photos taken during the trip window.",
      tier: "silver",
    },
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

const localTakeoutRoot = process.env.LOCAL_TAKEOUT_ROOT ?? "./takeout";
const localTakeoutDir = (envName: string, fallback: string): string =>
  process.env[envName] ?? `${localTakeoutRoot}/${fallback}`;

const googleYoutubeTakeoutDir = localTakeoutDir(
  "GOOGLE_YOUTUBE_TAKEOUT_DIR",
  "google-youtube"
);
const googleKeepTakeoutDir = localTakeoutDir(
  "GOOGLE_KEEP_TAKEOUT_DIR",
  "google-keep"
);
const twitterTakeoutDir = localTakeoutDir("TWITTER_TAKEOUT_DIR", "twitter");
const instagramTakeoutDir = localTakeoutDir(
  "INSTAGRAM_TAKEOUT_DIR",
  "instagram"
);
const linkedinTakeoutDir = localTakeoutDir("LINKEDIN_TAKEOUT_DIR", "linkedin");

const takeoutConnection = defineConnection({
  slug: "google-takeout-buremba",
  connector: "google.takeout",
  name: "Google Takeout Local",
  feeds: [
    { feed: "youtube", config: { takeout_dir: googleYoutubeTakeoutDir } },
    { feed: "keep", config: { takeout_dir: googleKeepTakeoutDir } },
  ],
});

const twitterTakeoutConnection = defineConnection({
  slug: "twitter-takeout-buremba",
  connector: "twitter.takeout",
  name: "X/Twitter Takeout Local",
  feeds: [
    { feed: "tweets", config: { takeout_dir: twitterTakeoutDir } },
    { feed: "messages", config: { takeout_dir: twitterTakeoutDir } },
    { feed: "likes", config: { takeout_dir: twitterTakeoutDir } },
    { feed: "followers", config: { takeout_dir: twitterTakeoutDir } },
    { feed: "following", config: { takeout_dir: twitterTakeoutDir } },
  ],
});

const instagramTakeoutConnection = defineConnection({
  slug: "instagram-takeout-buremba",
  connector: "instagram.takeout",
  name: "Instagram Takeout Local",
  feeds: [
    { feed: "messages", config: { takeout_dir: instagramTakeoutDir } },
    { feed: "connections", config: { takeout_dir: instagramTakeoutDir } },
    { feed: "saved", config: { takeout_dir: instagramTakeoutDir } },
    { feed: "comments", config: { takeout_dir: instagramTakeoutDir } },
    { feed: "likes", config: { takeout_dir: instagramTakeoutDir } },
    { feed: "media", config: { takeout_dir: instagramTakeoutDir } },
    {
      feed: "story_interactions",
      config: { takeout_dir: instagramTakeoutDir },
    },
    { feed: "searches", config: { takeout_dir: instagramTakeoutDir } },
    { feed: "link_history", config: { takeout_dir: instagramTakeoutDir } },
    { feed: "ads", config: { takeout_dir: instagramTakeoutDir } },
  ],
});

// One consolidated LinkedIn connection spanning BOTH sources: the local Data
// Export CSV feeds AND the live Chrome-extension feeds. Because it's a single
// connection on connector "linkedin", people met live and people in the CSV
// export dedup on the shared linkedin_slug/email identity. Keeps the existing
// slug (buremba connection id 410, 2544 events).
//
// The live home_feed reads linkedin.com/feed/ through the paired Owletto Chrome
// extension and needs no company_url. The company_updates/jobs live feeds each
// require a company_url, so add them per-company when tracking a specific page
// (e.g. { feed: "company_updates", config: { company_url: "https://www.linkedin.com/company/openai" } }).
const linkedinConnection = defineConnection({
  slug: "linkedin-takeout-buremba",
  connector: "linkedin",
  name: "LinkedIn",
  feeds: [
    // Local Data Export (CSV) feeds.
    { feed: "messages", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "connections", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "invitations", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "applied_jobs", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "profile", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "companies", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "learning", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "events", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "endorsements", config: { takeout_dir: linkedinTakeoutDir } },
    { feed: "media", config: { takeout_dir: linkedinTakeoutDir } },
    // Live Chrome-extension feed (no company_url needed).
    { feed: "home_feed", config: { max_scrolls: 8 } },
  ],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof RevolutTransactionsConnector>(
      "./revolut-transactions.connector.ts"
    ),
    connectorFromFile<typeof LinkedInConnector>("./linkedin.connector.ts"),
    connectorFromFile<typeof SpotifyConnector>("./spotify.connector.ts"),
    connectorFromFile<typeof WhatsAppCloudConnector>(
      "./whatsapp.cloud.connector.ts"
    ),
    connectorFromFile<typeof GoogleTakeoutConnector>(
      "./google-takeout.connector.ts"
    ),
    connectorFromFile<typeof TwitterTakeoutConnector>(
      "./twitter-takeout.connector.ts"
    ),
    connectorFromFile<typeof InstagramTakeoutConnector>(
      "./instagram-takeout.connector.ts"
    ),
  ],
  org: "buremba",
  orgName: "Buremba Org",
  orgDescription:
    "Personal agent tracking finances, people, companies, subscriptions, trips, and topics.",
  agents: [personalAgent],
  entities: [person, company, asset, subscription, topic, trip, goal, learning],
  connections: [
    revolutConnection,
    takeoutConnection,
    twitterTakeoutConnection,
    instagramTakeoutConnection,
    linkedinConnection,
  ],
});
