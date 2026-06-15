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
});

const subscriptionBackingSql = `
SELECT
  s.id,
  s.name,
  s.slug,
  CASE
    WHEN s.last_seen_date >= s.data_as_of - interval '45 days' THEN 'active'
    WHEN s.last_seen_date >= s.data_as_of - interval '120 days' THEN 'changed'
    ELSE 'cancelled'
  END AS status,
  s.category,
  s.currency,
  s.frequency,
  s.amount,
  s.first_seen_date::text AS first_seen,
  s.last_seen_date::text AS last_seen,
  s.billing_day,
  s.total_spent,
  s.charge_count,
  s.active_months
FROM (
  SELECT
  'subscription:' || md5(tx.merchant_key || ':' || tx.currency) AS id,
  regexp_replace(initcap(max(tx.merchant_name)), '\\s+', ' ', 'g') AS name,
  'subscription-' || md5(tx.merchant_key || ':' || tx.currency) AS slug,
  'subscription' AS category,
  tx.currency,
  CASE
    WHEN count(*) <= count(distinct date_trunc('month', tx.occurred_at)) + 2 THEN 'monthly'
    ELSE 'periodic'
  END AS frequency,
  round((array_agg(tx.amount ORDER BY tx.occurred_at DESC))[1], 2) AS amount,
  min(tx.tx_date) AS first_seen_date,
  max(tx.tx_date) AS last_seen_date,
  round(avg(extract(day from tx.occurred_at)))::int AS billing_day,
  round(sum(tx.amount), 2) AS total_spent,
  count(*)::int AS charge_count,
  count(distinct date_trunc('month', tx.occurred_at))::int AS active_months,
  max(tx.data_as_of) AS data_as_of
FROM (
  SELECT
    id,
    occurred_at,
    occurred_at::date AS tx_date,
    max(occurred_at::date) OVER () AS data_as_of,
    lower(regexp_replace(coalesce(metadata->>'description', payload_text, 'unknown'), '[^a-z0-9]+', ' ', 'g')) AS merchant_key,
    coalesce(metadata->>'description', payload_text, 'Unknown') AS merchant_name,
    nullif(metadata->>'amount', '')::numeric AS amount,
    coalesce(metadata->>'currency', 'GBP') AS currency
  FROM events
  WHERE semantic_type = 'transaction'
    AND metadata->>'direction' = 'out'
    AND nullif(metadata->>'amount', '') IS NOT NULL
    AND lower(coalesce(metadata->>'description', payload_text, 'unknown')) !~ '^(to|from|transfer from|transfer to|exchanged to|cash withdrawal|withdrawing savings|withdrawing)'
    AND lower(coalesce(metadata->>'description', payload_text, 'unknown')) !~ '(aldi|amazon fresh|antepliler|b\\s*&\\s*m|bar|bolt|boots|british airways|buns from home|camden chippy|chipotle|co-?op|coco di mama|coffee|deliveroo|dishoom|dostlar|five guys|fortnum|galata|gokyuzu|grocery|hair studio|kolkati|marks\\s*&\\s*spencer|m&s|netil|nisa|ocakbasi|porte|pub|rave coffee|redemption roasters|resident advisor|restaurant|sainsbury|santander cycles|sushi|the constitution|trainline|uber|umut|waitrose|wasabi|whsmith)'
) tx
GROUP BY tx.merchant_key, tx.currency
HAVING count(distinct date_trunc('month', tx.occurred_at)) >= 3
   AND max(tx.amount) <= greatest(avg(tx.amount) * 3, 50)
   AND count(*) <= count(distinct date_trunc('month', tx.occurred_at)) * 2
   AND sum(tx.amount) >= 20
) s
ORDER BY s.total_spent DESC
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
      description: "Total spent over tracked period",
      "x-table-column": true,
      "x-table-label": "Total",
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

const tripBackingSql = `
SELECT
  'trip:' || md5(date_trunc('month', occurred_at)::date::text || ':' || coalesce(metadata->>'currency', 'GBP')) AS id,
  CASE coalesce(metadata->>'currency', 'GBP')
    WHEN 'VND' THEN 'Vietnam trip'
    WHEN 'EUR' THEN 'Europe trip'
    WHEN 'USD' THEN 'US or international trip'
    WHEN 'TRY' THEN 'Turkey trip'
    WHEN 'JPY' THEN 'Japan trip'
    WHEN 'KRW' THEN 'Korea trip'
    ELSE coalesce(metadata->>'currency', 'GBP') || ' trip'
  END || ' (' || min(occurred_at::date)::text || ' to ' || max(occurred_at::date)::text || ')' AS name,
  'trip-' || date_trunc('month', occurred_at)::date::text || '-' || lower(coalesce(metadata->>'currency', 'GBP')) AS slug,
  CASE coalesce(metadata->>'currency', 'GBP')
    WHEN 'VND' THEN 'Vietnam'
    WHEN 'EUR' THEN 'Europe'
    WHEN 'USD' THEN 'US or international'
    WHEN 'TRY' THEN 'Turkey'
    WHEN 'JPY' THEN 'Japan'
    WHEN 'KRW' THEN 'Korea'
    ELSE coalesce(metadata->>'currency', 'GBP')
  END AS destination,
  min(occurred_at::date)::text AS start_date,
  max(occurred_at::date)::text AS end_date,
  coalesce(metadata->>'currency', 'GBP') AS currency,
  round(sum(nullif(metadata->>'amount', '')::numeric), 2) AS total_cost,
  count(*)::int AS transaction_count,
  count(*)::int AS foreign_transaction_count,
  CASE
    WHEN count(*) >= 5 THEN 'high'
    WHEN count(*) >= 3 THEN 'medium'
    ELSE 'low'
  END AS confidence
FROM events
WHERE semantic_type = 'transaction'
  AND metadata->>'direction' = 'out'
  AND coalesce(metadata->>'currency', 'GBP') <> 'GBP'
  AND nullif(metadata->>'amount', '') IS NOT NULL
GROUP BY date_trunc('month', occurred_at)::date, coalesce(metadata->>'currency', 'GBP')
HAVING count(*) >= 2
ORDER BY start_date DESC
`;

const trip = defineEntityType({
  key: "trip",
  name: "Trip",
  description:
    "Travel experiences derived from foreign-currency transaction clusters",
  metadata: { icon: "✈️", color: "#F59E0B" },
  backing: { sql: tripBackingSql },
  properties: {
    currency: { type: "string" },
    end_date: {
      type: "string",
      format: "date",
      "x-table-column": true,
      "x-table-label": "End",
    },
    start_date: {
      type: "string",
      format: "date",
      "x-table-column": true,
      "x-table-label": "Start",
    },
    total_cost: {
      type: "number",
      "x-table-column": true,
      "x-table-label": "Total",
    },
    destination: {
      type: "string",
      description: "Primary destination",
      "x-table-column": true,
      "x-table-label": "Destination",
    },
    transaction_count: { type: "integer" },
    foreign_transaction_count: { type: "integer" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
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
  entities: [person, company, asset, subscription, topic, trip],
  connections: [revolutConnection],
});
