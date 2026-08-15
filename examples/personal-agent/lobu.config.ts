import {
  connectorFromFile,
  defineAgent,
  defineAuthProfile,
  defineAutomation,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  defineSkill,
  reactionFromFile,
} from "@lobu/cli/config";
import type GoogleTakeoutConnector from "./google-takeout.connector.ts";
import type HackerNewsConnector from "./hackernews.connector.ts";
import type InstagramTakeoutConnector from "./instagram-takeout.connector.ts";
import type LinkedInConnector from "./linkedin.connector.ts";
import type MidasConnector from "./midas.connector.ts";
import type NetWorthReaction from "./net-worth.reaction.ts";
import type RevolutTransactionsConnector from "./revolut-transactions.connector.ts";
import type SocialInterestRadarReaction from "./social-interest-radar.reaction.ts";
import type SpotifyConnector from "./spotify.connector.ts";
import { takeoutConfig } from "./takeout-dirs.ts";
import type TwitterTakeoutConnector from "./twitter-takeout.connector.ts";
import type WhatsAppCloudConnector from "./whatsapp.cloud.connector.ts";

const hourlyTaskCollaboratorSkill = defineSkill({
  name: "hourly-task-collaborator",
  content:
    "Review the current hourly window's content and the collaborative task list in the payload's task_list source. The task_list source includes recently closed tasks (metadata status done or dismissed) for reference so you know what is already finished. Return a JSON object with a tasks array matching the provided task schema. Extract only concrete actions Burak or his personal agent should take; ignore advertisements, newsletters, automated notices, passive information, and vague ideas. For every task, copy source_scope, source_origin_id, and source_event_id exactly from the recent_signals or upcoming_calendar row it came from. The upcoming_calendar source lists confirmed meetings, flights, and events in the next 30 days, ordered soonest first; draw preparation tasks from it only when a concrete action is genuinely needed, and never emit a task that merely restates that an event is scheduled. Set task_key to a short stable machine key for that distinct action within the source (for example send-deck or book-flight); keep the same task_key when only the wording or status changes. Preserve existing tasks instead of restating them. Never re-emit, reopen, or recreate any task whose status is done or dismissed in the task list, even if the originating message still appears in recent signals. Set status to backlog unless there is clear evidence work has started. Assign owner \"Burak\" unless the action can be safely completed by the personal agent. Use ISO-8601 due_date only when a real deadline is present. Include source and a short rationale. Produce at most 12 tasks, ordered by priority.",
});

const duplicateEntityResolutionRealV3FinalSkill = defineSkill({
  name: "duplicate-entity-resolution-real-v3-final",
  content:
    "Review every row in sources.people. Explain likely duplicate groups in analysis_summary and put name-only, alias-only, handle-only, oversized, or otherwise uncertain groups in uncertain_groups with why. Do not call entity tools or emit backlog tasks. After analysis, the deterministic reaction submits only candidate IDs to the server. The person entity type's x-lobu-resolution policy decides which normalized identities auto-merge and which require human review. Without that extension, normalized email and phone matches remain review-only and never auto-merge.\n",
});

const personalAgent = defineAgent({
  id: "personal-agent",
  skills: [
    hourlyTaskCollaboratorSkill,
    duplicateEntityResolutionRealV3FinalSkill,
  ],
  dir: ".",
  name: "personal-agent",
  description:
    "A personal agent that tracks finances, people, companies, tasks, subscriptions, and trips across the user's own data.",
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
  description:
    "A real-world person linked across connectors via identities (x_user_id, x_handle, wa_jid, phone, email, linkedin_slug, …). Metadata holds connector traits and optional human notes — not a CRM form.",
  metadata: { icon: "user", color: "#8B5CF6" },
  // Trait names must match connector EventAttributionRule.traits keys.
  // Identity join keys live on entity identities/aliases, not as required props.
  properties: {
    // X (packages/connectors x.ts + twitter takeout)
    x_handle: {
      type: "string",
      description:
        "X/Twitter @handle without @. Mutable secondary identity; primary join is x_user_id.",
      "x-table-label": "X",
      "x-table-column": true,
    },
    x_display_name: {
      type: "string",
      description: "Display name from X profile/posts.",
    },
    last_x_interaction_at: {
      type: "string",
      format: "date-time",
      description:
        "Most recent X post/like/bookmark/reply involving this person.",
      "x-table-label": "Last X",
      "x-table-column": true,
    },
    last_x_dm_at: {
      type: "string",
      format: "date-time",
      description: "Most recent X DM with this person.",
    },
    // WhatsApp
    push_name: {
      type: "string",
      description: "WhatsApp push name.",
      "x-table-label": "WA name",
      "x-table-column": true,
    },
    last_seen_at: {
      type: "string",
      format: "date-time",
      description: "Most recent WhatsApp message time for this contact.",
    },
    // LinkedIn
    linkedin_url: {
      type: "string",
      description:
        "LinkedIn profile URL (display trait; identity is linkedin_slug).",
    },
    position: {
      type: "string",
      description: "LinkedIn headline/position.",
    },
    company: {
      type: "string",
      description: "Company / employer (LinkedIn connection + manual).",
      "x-table-label": "Company",
      "x-table-column": true,
    },
    last_linkedin_message_at: {
      type: "string",
      format: "date-time",
      description: "Most recent LinkedIn message with this person.",
    },
    // Instagram takeout
    ig_username: {
      type: "string",
      description: "Instagram username.",
    },
    instagram_profile_url: {
      type: "string",
      description: "Instagram profile URL.",
    },
    // Gmail (match-only; traits accrete when identity already exists)
    from_name: {
      type: "string",
      description: "Name as seen on inbound email.",
    },
    last_email_at: {
      type: "string",
      format: "date-time",
      description: "Most recent email from/to this address.",
    },
    // Optional human-curated (email is also an identity namespace)
    email: {
      type: "string",
      description: "Email address (also an identity namespace).",
    },
    first_name: { type: "string" },
    last_name: { type: "string" },
    role: {
      type: "string",
      description: "Freeform role or relationship note (not a CRM enum).",
    },
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
  // Entity-resolution policy: a normalized email match auto-merges two persons
  // (a normalized address is a strong unique key — the same human on LinkedIn,
  // Gmail, X, etc.). Phone stays review-only: shared/work numbers collide too
  // easily to merge without a human look. Declared here so `apply` folds it into
  // the person type's metadata_schema and the duplicate-entity-resolution
  // reaction's candidate submissions auto-merge on email.
  resolutionPolicy: {
    rules: [
      { fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
      { fields: ["emails"], normalizer: "email", onMatch: "auto_merge" },
      { fields: ["phone"], normalizer: "phone", onMatch: "review" },
      { fields: ["phones"], normalizer: "phone", onMatch: "review" },
    ],
  },
});

const company = defineEntityType({
  key: "company",
  name: "Company",
  description:
    "An organization the user cares about — own company, employer, customer, partner, or portfolio company. Link people via works_at.",
  metadata: { icon: "building", color: "#2563eb" },
  properties: {
    // Core identity / positioning
    domain: { type: "string", description: "Primary web domain" },
    one_liner: { type: "string", description: "One-line description" },
    location: { type: "string" },
    market: { type: "string", description: "Primary market vertical" },
    main_market: { type: "string" },
    platform_type: { type: "string" },
    linkedin_url: { type: "string", format: "uri" },
    founding_year: { type: "integer", maximum: 2030, minimum: 1900 },
    team_size: { type: "integer", minimum: 0 },
    // Optional growth / funding fields (portfolio / competitive tracking)
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
      description: "Current funding stage when relevant",
    },
    mrr: { type: "number", description: "Monthly recurring revenue in USD" },
    revenue: { type: "number", description: "Annual revenue in USD" },
    valuation: { type: "number", description: "Last known valuation in USD" },
    growth_rate: { type: "number", description: "YoY growth rate as decimal" },
    funding_raised: {
      type: "number",
      description: "Total funding raised in USD",
    },
    thesis: { type: "string", description: "Investment or relationship notes" },
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

// System chat-surface unit (Slack etc.). Declared so prune does not attempt to
// delete the org's channel type while conversation ACL still depends on it.
const channel = defineEntityType({
  key: "channel",
  name: "Channel",
  description:
    "A chat channel (Slack channel, etc.) — the unit of conversation access control",
});

// Collaborative actions for Burak + personal-agent. Identity comes from the
// stable source plus a per-source task key, never editable display wording.
// Schema is owned here — the Automation does not declare an extraction schema.
const task = defineEntityType({
  key: "task",
  name: "Task",
  description:
    "An actionable item collaboratively managed by Burak and his personal agent.",
  metadata: { icon: "check-square", color: "#10B981" },
  required: [
    "action",
    "status",
    "source_scope",
    "source_origin_id",
    "task_key",
  ],
  properties: {
    action: {
      type: "string",
      minLength: 1,
      description: "Concrete action to perform",
      "x-table-label": "Action",
      "x-table-column": true,
    },
    status: {
      type: "string",
      enum: ["backlog", "active", "done", "dismissed"],
      description: "Collaborative task state",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    owner: {
      type: "string",
      description: "Person or agent responsible",
      "x-table-label": "Owner",
      "x-table-column": true,
    },
    priority: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "Execution priority",
      "x-table-label": "Priority",
      "x-table-column": true,
    },
    due_date: {
      type: "string",
      format: "date-time",
      description: "Due time when known",
      "x-table-label": "Due",
      "x-table-column": true,
    },
    source: {
      type: "string",
      description: "Where this task came from",
    },
    rationale: {
      type: "string",
      description: "Why this task is worth doing",
    },
    source_event_id: {
      type: "integer",
      description: "Originating Lobu event id (provenance, not identity)",
    },
    source_scope: {
      type: "string",
      minLength: 1,
      description:
        "Stable source namespace copied from the source row (connection, connector, or local event)",
    },
    source_origin_id: {
      type: "string",
      minLength: 1,
      description: "Stable source event identity copied from the source row",
    },
    task_key: {
      type: "string",
      minLength: 1,
      description:
        "Stable machine key for one distinct action within the source event",
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

// One bounded, immutable weekly row is the financial read model. The inner
// top-1 uses the live-event index; the outer SUM window runs over that one row
// only and lets the existing derived-column classifier expose net_worth_gbp as
// the first-class measure without a separate metrics DSL.
const netWorthSnapshot = defineEntityType({
  key: "net-worth-snapshot",
  name: "Net Worth Snapshot",
  description:
    "Latest household balance-sheet valuation from connector positions and current observations, with weekly FX, valuation range, and deterministic attribution.",
  metadata: { icon: "wallet-cards", color: "#10B981" },
  backing: {
    sql: `SELECT
      latest.id,
      latest.week,
      latest.snapshot_at,
      SUM(latest.net_worth_gbp) OVER () AS net_worth_gbp,
      SUM(latest.net_worth_low_gbp) OVER () AS net_worth_low_gbp,
      SUM(latest.net_worth_high_gbp) OVER () AS net_worth_high_gbp,
      latest.scope,
      latest.sources,
      latest.positions,
      latest.breakdowns,
      latest.previous,
      latest.attribution
    FROM (
      SELECT
        id,
        metadata->>'week' AS week,
        occurred_at AS snapshot_at,
        (metadata->>'net_worth_gbp')::numeric AS net_worth_gbp,
        (metadata->'net_worth_range_gbp'->>'low')::numeric AS net_worth_low_gbp,
        (metadata->'net_worth_range_gbp'->>'high')::numeric AS net_worth_high_gbp,
        metadata->>'scope' AS scope,
        metadata->'sources' AS sources,
        metadata->'positions' AS positions,
        metadata->'breakdowns' AS breakdowns,
        metadata->'previous' AS previous,
        metadata->'attribution' AS attribution
      FROM events
      WHERE semantic_type = 'summary'
        AND metadata->>'schema' = 'net-worth-snapshot/v4'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) latest`,
  },
});

const account = defineEntityType({
  key: "account",
  name: "Financial Account",
  description:
    "A financial account used as the stable grain for account-level transaction metrics.",
  metadata: { icon: "landmark", color: "#10B981" },
  properties: {
    is_active: {
      type: "boolean",
      description: "Whether this account is active",
      "x-table-column": true,
      "x-table-label": "Active",
    },
    institution: { type: "string", description: "Financial institution" },
    account_type: { type: "string", description: "Account classification" },
  },
  // Governed spend metrics over the Revolut transaction stream. The eventSet
  // resolves a transaction to an account by matching its `currency` against the
  // account's aliases. This example assumes a single consolidated Revolut
  // account, so that one account is aliased with EVERY currency it transacts in
  // (GBP, USD, EUR, …) and owns all transactions; `currency` is then a
  // dimension, not a separate entity per pocket. Because the measure is
  // GBP-normalised, the per-account roll-up is a valid single GBP total. Aliases
  // are entity data, not schema — seed them with
  // examples/personal-agent/seed-account-aliases.sql.
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
        "How progress is measured — ideally a declared metric (e.g. account.spend) the agent can query",
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
      description:
        "Where it was learned (conversation, Automation, observation)",
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

// Revolut auth is implicit: through the paired Owletto Chrome extension, the
// connector captures request headers from a signed-in tab and pages the retail
// API in that browser context. No secret or browser-auth profile is stored.
//
// The connection is not device-pinned; Chrome dispatch selects an online paired
// extension. `max_scrolls` is the compatibility name for its paging-batch cap.
const revolutConnection = defineConnection({
  slug: "revolut-buremba",
  connector: "revolut",
  name: "Revolut",
  feeds: [
    // Apply replaces feed config wholesale. Preserve checkpointed syncs and the
    // 60s passcode grace period within the device worker's ~95s run budget.
    {
      feed: "transactions",
      config: { max_scrolls: 20, backfill: false, wait_for_data_seconds: 60 },
    },
    { feed: "balances", config: {} },
  ],
});

// LinkedIn is also a browser connector. Unlike takeout-only connections, never
// synthesize a local path for it: a browser-only deployment must not provision
// CSV feeds that can only fail forever. Opt in with either an explicit LinkedIn
// directory or an explicitly configured shared takeout root.
const linkedinTakeoutDir =
  process.env.LINKEDIN_TAKEOUT_DIR ??
  (process.env.LOCAL_TAKEOUT_ROOT
    ? `${process.env.LOCAL_TAKEOUT_ROOT}/linkedin`
    : null);

const takeoutConnection = defineConnection({
  slug: "google-takeout-buremba",
  connector: "google.takeout",
  name: "Google Takeout Local",
  feeds: [
    {
      feed: "youtube",
      config: takeoutConfig("GOOGLE_YOUTUBE_TAKEOUT_DIR", "google-youtube"),
    },
    {
      feed: "keep",
      config: takeoutConfig("GOOGLE_KEEP_TAKEOUT_DIR", "google-keep"),
    },
    {
      feed: "maps",
      config: takeoutConfig("GOOGLE_MAPS_TAKEOUT_DIR", "google-maps"),
    },
  ],
});

const twitterTakeoutConnection = defineConnection({
  slug: "twitter-takeout-buremba",
  connector: "twitter.takeout",
  name: "X/Twitter Takeout Local",
  feeds: [
    { feed: "tweets", config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter") },
    {
      feed: "messages",
      config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter"),
    },
    { feed: "likes", config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter") },
    {
      feed: "followers",
      config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter"),
    },
    {
      feed: "following",
      config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter"),
    },
  ],
});

const instagramTakeoutConnection = defineConnection({
  slug: "instagram-takeout-buremba",
  connector: "instagram.takeout",
  name: "Instagram Takeout Local",
  feeds: [
    {
      feed: "messages",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "connections",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "saved",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "comments",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "likes",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "media",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "story_interactions",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "searches",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "link_history",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "ads",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
  ],
});

// One consolidated LinkedIn connection spanning BOTH sources: the local Data
// Export CSV feeds AND the live Chrome-extension feeds. Because it's a single
// connection on connector "linkedin", people met live and people in the CSV
// export dedup on the shared linkedin_slug/email identity. The stable slug is
// the config identity; runtime database ids are deliberately not hard-coded.
//
// The live home_feed reads linkedin.com/feed/ through the paired Owletto Chrome
// extension and needs no company_url. The company_updates/jobs live feeds each
// require a company_url, so add them per-company when tracking a specific page
// (e.g. { feed: "company_updates", config: { company_url: "https://www.linkedin.com/company/openai" } }).
const linkedinConnection = defineConnection({
  slug: "linkedin-buremba",
  connector: "linkedin",
  name: "LinkedIn",
  // Scrape affinity: the paired Mac mini Chrome owns the signed-in session.
  deviceWorkerId: "2e8a0557-ddd9-48a9-913e-f476163c0cd2",
  feeds: [
    // Local Data Export (CSV) feeds.
    ...(linkedinTakeoutDir
      ? [
          "messages",
          "connections",
          "invitations",
          "applied_jobs",
          "profile",
          "companies",
          "learning",
          "events",
          "endorsements",
          "media",
        ].map((feed) => ({ feed, config: { takeout_dir: linkedinTakeoutDir } }))
      : []),
    // Live Chrome-extension feed (no company_url needed).
    { feed: "home_feed", config: { min_scrolls: 6, max_scrolls: 10 } },
  ],
});

const hackerNewsConnection = defineConnection({
  slug: "hackernews-buremba",
  connector: "hackernews",
  name: "Hacker News",
  // Draft staging rides the paired Mac mini Chrome's signed-in HN session.
  deviceWorkerId: "2e8a0557-ddd9-48a9-913e-f476163c0cd2",
  feeds: [{ feed: "front_page", config: {} }],
});

const midasConnection = defineConnection({
  slug: "midas",
  connector: "midas",
  name: "Midas",
  feeds: [{ feed: "assets", config: {} }],
});

// A same-workspace execution target for market marks. It has no credentials or
// feeds: the weekly reaction receives quotes directly from its read-only action
// without persisting raw quote events.
const marketQuotesConnection = defineConnection({
  slug: "market-quotes",
  connector: "market.quotes",
  name: "Market Quotes",
  feeds: [],
});

// Gmail person-building, not mailbox mirroring. One narrow collected feed syncs
// only person-relevant threads (human_senders_only) so the DB holds a small
// high-signal set that drives person minting/merging — full email content stays
// a live read via the connector's search/get_thread actions, never persisted.
// Adopts the existing `gmail-buremba` slug so the OAuth grant is reused; stale
// duplicate gmail connections/feeds in prod surface as drift until cleaned up.
// Apply requires referenced auth profiles to be declared. Omitting credentials
// preserves the existing OAuth grant and app secret.
const gmailAccountAuth = defineAuthProfile({
  slug: "personal",
  connector: "google.gmail",
  authKind: "oauth_account",
  name: "personal",
});

const gmailAppAuth = defineAuthProfile({
  slug: "google-gmail-google-app",
  connector: "google.gmail",
  authKind: "oauth_app",
  name: "Google Gmail Google App",
});

const gmailConnection = defineConnection({
  slug: "gmail-buremba",
  connector: "google.gmail",
  name: "Gmail",
  // Apply treats omitted bindings as null, so both must remain explicit.
  authProfile: gmailAccountAuth,
  appAuthProfile: gmailAppAuth,
  feeds: [
    {
      feed: "threads",
      config: {
        human_senders_only: true,
        labels: ["INBOX", "SENT"],
        max_results: 500,
        lookback_days: 365,
      },
    },
  ],
});

// ── Relationships (only those the personal agent uses) ──────────
// Tax-graph relationship types (account_contains, for_tax_year, …) belong in
// examples/personal-finance — not here. With prune:true they are removed from
// buremba if present.

const worksAt = defineRelationshipType({
  key: "works_at",
  name: "Works At",
  description: "Person employed by / associated with a company",
  rules: [{ source: person, target: company }],
});

const memberOf = defineRelationshipType({
  key: "member_of",
  name: "Member of",
  description: "A person is a member of an organization or channel",
});

const mentions = defineRelationshipType({
  key: "mentions",
  name: "Mentions",
  description: "Auto-discovered content reference",
});

// Graph edges created in the org (and populated with live relationships) that
// the config must declare — otherwise prune flags them "removed from config"
// and the apply aborts: the server refuses to delete a relationship type that
// still has relationship rows.
const connectedWith = defineRelationshipType({
  key: "connected_with",
  name: "Connected With",
  description:
    "Social connection observed on a platform (LinkedIn connection, mutual follow). Symmetric.",
});

const founderOf = defineRelationshipType({
  key: "founder_of",
  name: "Founder Of",
  description: "A person founded or co-founded a company.",
});

const sameAs = defineRelationshipType({
  key: "same_as",
  name: "Same As",
  description:
    "Maps a private person profile to its canonical public identity. The mapping and private profile remain visible only to this workspace.",
});

const voiceProfile = defineEntityType({
  key: "voice-profile",
  name: "Voice profile",
  description:
    "How the member sounds (mode=voice) or what they engage with (mode=taste) on one channel. Human analogue of agent identity/soul.",
  metadata: { icon: "🎙️", color: "#F59E0B" },
  properties: {
    mode: {
      type: "string",
      enum: ["voice", "taste"],
      "x-table-label": "Mode",
      "x-table-column": true,
    },
    channel: {
      type: "string",
      enum: ["core", "x", "linkedin", "reddit", "instagram"],
      "x-table-label": "Channel",
      "x-table-column": true,
    },
    summary: { type: "string" },
    themes: { type: "array", items: { type: "string" } },
    prefers: { type: "array", items: { type: "string" } },
    avoids: { type: "array", items: { type: "string" } },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      "x-table-label": "Confidence",
      "x-table-column": true,
    },
    evidence_count: {
      type: "number",
      "x-table-label": "Evidence",
      "x-table-column": true,
    },
    evidence_from: { type: "string", format: "date" },
    evidence_to: { type: "string", format: "date" },
    sample_event_ids: { type: "array", items: { type: "number" } },
  },
});

// Deprecated compatibility declaration. The radar now writes threaded events
// with event persistence, but prune must retain this type while historical
// social-signal entity rows still exist. Remove it only through an explicit
// data migration; it is not part of the active output path.
const socialSignal = defineEntityType({
  key: "social-signal",
  name: "Social Signal",
  description:
    "Deprecated historical entity rows from the former Social Interest Radar output path.",
  metadata: { icon: "radar" },
  properties: {
    platform: {
      type: "string",
      enum: ["x", "linkedin"],
      description: "Source platform",
    },
    author: {
      type: "string",
      minLength: 1,
      description: 'Post author (never "unknown")',
    },
    snippet: { type: "string", description: "Excerpt of the post" },
    why: {
      type: "string",
      minLength: 1,
      description: "Why this matches taste — specific to this item",
    },
    priority: { type: "string", enum: ["high", "normal", "low"] },
    source_origin_id: {
      type: "string",
      description: "Stable events.origin_id of the source post",
    },
    source_event_id: {
      type: "integer",
      description: "Originating event id (unstable across re-sync)",
    },
    suggested_action: { type: "string", description: "Concrete next step" },
  },
  required: ["platform", "author", "why", "priority", "source_origin_id"],
});

// ── Automations (must be declared under prune or apply deletes them) ─

const voiceProfileSynthesis = defineAutomation({
  agent: personalAgent,
  slug: "voice-profile-synth-v2",
  name: "Voice profile synthesis",
  tags: ["voice", "identity", "social"],
  triggers: [
    { kind: "schedule", cron: "40 6 * * 1", skip_if_unchanged: false },
  ],
  notification: { channel: "canvas", priority: "low" },
  minCooldownSeconds: 3600,
  agentKind: "opencode",
  deviceWorkerId: "e7806c72-9485-4a8c-a619-7e6bdcb14eaf",
  model: "opencode-go/deepseek-v4-flash",
  outputs: {
    profiles: {
      entity: voiceProfile,
      key: ["channel", "mode"],
    },
  },
  sources: {
    authored_recent:
      "SELECT id, occurred_at, connector_key, origin_type, left(payload_text, 400) AS payload_text, metadata FROM events WHERE payload_text IS NOT NULL AND length(payload_text) >= 40 AND occurred_at > now() - interval '21 days' AND ((connector_key = 'twitter.takeout' AND origin_type IN ('reply','tweet')) OR (connector_key = 'x' AND origin_type IN ('tweet','reply') AND lower(coalesce(metadata->>'author_handle','')) = 'bu7emba') OR (connector_key IN ('linkedin','linkedin.takeout') AND origin_type = 'message') OR (connector_key = 'hackernews' AND origin_type = 'comment' AND lower(coalesce(author_name,'')) = 'buremba')) ORDER BY occurred_at DESC LIMIT 200",
    engaged_recent:
      "SELECT id, occurred_at, connector_key, origin_type, left(payload_text, 300) AS payload_text, metadata FROM events WHERE payload_text IS NOT NULL AND length(payload_text) >= 20 AND occurred_at > now() - interval '21 days' AND ((connector_key IN ('x','twitter.takeout') AND origin_type IN ('liked_tweet','bookmark')) OR (connector_key = 'instagram.takeout' AND origin_type IN ('like','saved','comment'))) ORDER BY occurred_at DESC LIMIT 200",
    existing_profiles: {
      context: true,
      query:
        "SELECT NULL::bigint AS id, v.name, v.metadata, v.updated_at FROM entities v WHERE v.entity_type = 'voice-profile' AND v.deleted_at IS NULL ORDER BY v.updated_at DESC LIMIT 20",
    },
  },
  prompt:
    'Refine Burak\'s voice-profile entities.\nexisting_profiles is historical truth. authored_recent/engaged_recent refine last ~21d only.\nALWAYS re-emit all existing profiles. Return JSON:\n{ "profiles":[{ "name","channel","mode","summary","themes","prefers","avoids","confidence","evidence_count","evidence_from","evidence_to","sample_event_ids" }], "analysis_summary":"..." }\nNever invent channel=core.',
  reactionsGuidance:
    "ALWAYS re-emit every existing_profiles row (same channel/mode). Refine if recent evidence; never return empty profiles[] when existing_profiles non-empty.",
});

const socialInterestRadar = defineAutomation({
  agent: personalAgent,
  slug: "social-interest-radar-v2",
  name: "Social interest radar",
  tags: ["social", "x", "linkedin", "notifications"],
  triggers: [
    { kind: "schedule", cron: "25 * * * *", skip_if_unchanged: false },
  ],
  notification: { channel: "both", priority: "normal" },
  minCooldownSeconds: 1800,
  agentKind: "opencode",
  deviceWorkerId: "e7806c72-9485-4a8c-a619-7e6bdcb14eaf",
  model: "opencode-go/deepseek-v4-flash",
  sources: {
    recent_social:
      "SELECT id, origin_id, connection_id, occurred_at, title, author_name, payload_text, source_url, metadata, connector_key, origin_type FROM events WHERE connector_key IN ('x','linkedin','hackernews') AND ((connector_key='x' AND origin_type IN ('tweet','bookmark')) OR (connector_key='linkedin' AND origin_type='post') OR (connector_key='hackernews' AND origin_type IN ('story','ask_hn','show_hn'))) AND payload_text IS NOT NULL AND origin_id IS NOT NULL AND connection_id IS NOT NULL ORDER BY occurred_at DESC LIMIT 80",
    already_emitted: {
      context: true,
      query:
        "SELECT id, origin_parent_id AS source_origin_id FROM events WHERE semantic_type = 'observation' AND metadata->>'automation_output' = 'signals' AND occurred_at > now() - interval '7 days' ORDER BY occurred_at DESC LIMIT 400",
    },
    voice_profiles: {
      context: true,
      query:
        "SELECT NULL::bigint AS id, v.name, v.metadata, v.updated_at FROM entities v WHERE v.entity_type='voice-profile' AND v.deleted_at IS NULL ORDER BY v.updated_at DESC LIMIT 20",
    },
    known_people: {
      context: true,
      query:
        "SELECT id, name, metadata FROM entities WHERE entity_type='person' AND deleted_at IS NULL AND (metadata ? 'x_handle' OR metadata ? 'linkedin_url' OR metadata ? 'company') ORDER BY updated_at DESC LIMIT 40",
    },
  },
  outputs: {
    signals: { event: "observation" },
    drafts: { event: "draft_reply" },
  },
  prompt:
    'Rank at most 8 new, high-signal X, LinkedIn, or Hacker News posts for Burak. Use voice_profiles for taste and known_people for relationship context. Prefer AI, agents, infrastructure, developer tools, people he knows, launches, funding, and technical substance; ignore engagement bait, generic memes, and ads. Return each choice in `signals` as a standard observation event draft. Set `title` to the author/platform, `author` to the post author\'s display name (never "unknown"), `content` to the specific why plus a concrete suggested action, `source_url` to the source row source_url, `parent_event_id` to the source row id, and `idempotency_key` to its origin_id. Put only `{ platform, why, priority, source_event_id, source_connection_id }` in metadata, copying the source id and connection_id exactly. `platform` is one of "x", "linkedin", or "hackernews". Never restate the author, the source origin_id, the post excerpt, or a kind in metadata: `author`, `parent_event_id`, and `content` already carry them on the event itself, and the platform stamps the automation and output names. Prefer posts not present in already_emitted. Also return `drafts`: either [] or exactly one standard draft_reply event for the single best item that genuinely deserves a response. Its content is only the proposed reply text; copy author, source_url, and parent_event_id, use `draft:` plus origin_id as idempotency_key, and metadata `{ platform, why, priority, source_event_id, source_connection_id }`. Never claim to publish: the reaction only stages the draft and the human submits it. Return empty arrays when nothing qualifies.',
  reactionsGuidance:
    "Declared outputs own event persistence and source-level deduplication. Only draft-ready notifications are delivered: the reaction schedules at most one saved draft for the first signed-in Chrome device that visits the exact post, and a signal-only run is silent. It never publishes.",
  reaction: reactionFromFile<typeof SocialInterestRadarReaction>(
    "./social-interest-radar.reaction.ts"
  ),
});

const midasNetWorth = defineAutomation({
  agent: personalAgent,
  // Keep the existing slug: it is the Automation's durable identity. Renaming it
  // would delete/recreate the Automation and discard its cooldown/history.
  slug: "midas-net-worth",
  name: "Weekly net worth",
  description:
    "Consolidates connector positions and current balance-sheet observations into one immutable weekly GBP snapshot with exact change attribution.",
  triggers: [
    {
      kind: "schedule",
      cron: "0 9 * * 1",
      timezone: "Europe/London",
      // Prices change even when the current broker position book does not.
      skip_if_unchanged: false,
    },
  ],
  notification: { channel: "canvas", priority: "low" },
  minCooldownSeconds: 300,
  tags: ["finance", "net-worth", "balance-sheet"],
  prompt:
    'The deterministic reaction performs this scheduled consolidated valuation. Return only {"summary":"Run the deterministic weekly net-worth snapshot."}; do not calculate values, create entities, or call connector operations yourself.',
  reactionsGuidance:
    "The reaction owns active-connection deduplication, current observation heads, security and weekly FX marks, penny-exact attribution, immutable snapshot persistence, and the notification. Missing FX fails closed.",
  reaction: reactionFromFile<typeof NetWorthReaction>(
    "./net-worth.reaction.ts"
  ),
});

const hourlyTaskCollaborator = defineAutomation({
  agent: personalAgent,
  slug: "hourly-task-collaborator",
  name: "Hourly Task Collaborator",
  model: "hetzner/DeepSeek-V4-Flash-0731",
  triggers: [{ kind: "schedule", cron: "0 * * * *" }],
  notification: { channel: "both", priority: "normal" },
  minCooldownSeconds: 300,
  outputs: {
    tasks: {
      entity: task,
      key: ["source_scope", "source_origin_id", "task_key"],
      name: ["action"],
    },
  },
  sources: {
    // Past-facing conversational signal. `calendar_event` is deliberately NOT in
    // this filter and `occurred_at <= now()` is deliberately present: calendar
    // rows are dated when the meeting HAPPENS, so future-dated ones sort ahead of
    // every message under `occurred_at DESC` and evict the entire window. On prod
    // 213 of 254 Google Calendar rows are future-dated (mostly two recurring
    // series expanded out to 2056) — more than the LIMIT 200 window holds.
    recent_signals:
      "SELECT id, id AS source_event_id, COALESCE('connection:' || connection_id::text, 'connector:' || connector_key, 'event') AS source_scope, COALESCE(origin_id, 'event:' || id::text) AS source_origin_id, occurred_at, title, payload_text, semantic_type, connector_key, metadata FROM events WHERE semantic_type IN ('message','thread','reminder','note') AND occurred_at <= now() ORDER BY occurred_at DESC LIMIT 200",
    // Forward-facing calendar, on its own budget so it can neither starve
    // recent_signals nor be starved by a busy messaging day. Ascending + a small
    // LIMIT keeps it to the NEAREST events; the upper bound is what stops the
    // 2056 recurring expansions from filling it on a sparse calendar.
    //
    // 30 days, not 7: measured against prod 2026-08-07, a 7-day window returns
    // 0 rows (the next real event is 18 days out). Row counts from now-1d:
    // 7d=0, 30d=4, 60d=5, 90d=7. 30d is the smallest round window that is
    // non-empty on real data and still covers the next flight; retune here if
    // the calendar fills in.
    //
    // Those counts span BOTH calendar connectors, because this source keys off
    // `semantic_type` and not `connector_key` — that is the entire point of the
    // shared vocabulary. Counting google.calendar alone gives 3/4/6 and is the
    // wrong measurement: the 30-day window's second row is an apple.calendar
    // holiday.
    upcoming_calendar:
      "SELECT id, id AS source_event_id, COALESCE('connection:' || connection_id::text, 'connector:' || connector_key, 'event') AS source_scope, COALESCE(origin_id, 'event:' || id::text) AS source_origin_id, occurred_at, title, payload_text, semantic_type, connector_key, metadata FROM events WHERE semantic_type = 'calendar_event' AND occurred_at BETWEEN now() - interval '1 day' AND now() + interval '30 days' ORDER BY occurred_at ASC LIMIT 20",
    // context-only: existing tasks are dedup reference data, not window signal
    task_list: {
      context: true,
      query:
        "SELECT NULL::bigint AS id, t.name, t.metadata, t.updated_at FROM entities t WHERE t.entity_type = 'task' AND t.deleted_at IS NULL AND (COALESCE(t.metadata->>'status', 'backlog') NOT IN ('done', 'dismissed') OR t.updated_at > now() - interval '14 days') ORDER BY t.updated_at DESC LIMIT 100",
    },
  },
  skills: ["hourly-task-collaborator"],
});

const duplicateEntityResolution = defineAutomation({
  agent: personalAgent,
  slug: "duplicate-entity-resolution-real-v3-final",
  name: "Duplicate entity resolution — real contacts",
  tags: ["identity", "deduplication", "world-model"],
  notification: { channel: "canvas", priority: "normal" },
  sources: {
    // context-only: duplicate candidates for analysis (not window body)
    people: {
      context: true,
      query:
        "SELECT * FROM (SELECT id AS id, name AS name, name_key AS name_key, match_reason AS match_reason, metadata AS metadata, created_at AS created_at, updated_at AS updated_at\nFROM (\n  SELECT id, name, metadata, created_at, updated_at,\n    regexp_replace(lower(trim(name)),'[^a-z0-9]','','g') AS name_key,\n    nullif(lower(trim(metadata->>'email')),'') AS em,\n    nullif(regexp_replace(coalesce(metadata->>'phone',''),'[^0-9]','','g'),'') AS ph,\n    COUNT(*) OVER (PARTITION BY regexp_replace(lower(trim(name)),'[^a-z0-9]','','g')) AS name_grp,\n    COUNT(*) OVER (PARTITION BY nullif(lower(trim(metadata->>'email')),'')) AS email_grp,\n    COUNT(*) OVER (PARTITION BY nullif(regexp_replace(coalesce(metadata->>'phone',''),'[^0-9]','','g'),'')) AS phone_grp,\n    CASE\n      WHEN nullif(lower(trim(metadata->>'email')),'') IS NOT NULL\n           AND COUNT(*) OVER (PARTITION BY nullif(lower(trim(metadata->>'email')),'')) > 1 THEN 'email:' || lower(trim(metadata->>'email'))\n      WHEN length(nullif(regexp_replace(coalesce(metadata->>'phone',''),'[^0-9]','','g'),'')) >= 7\n           AND COUNT(*) OVER (PARTITION BY nullif(regexp_replace(coalesce(metadata->>'phone',''),'[^0-9]','','g'),'')) > 1 THEN 'phone:' || regexp_replace(coalesce(metadata->>'phone',''),'[^0-9]','','g')\n      ELSE 'name:' || regexp_replace(lower(trim(name)),'[^a-z0-9]','','g')\n    END AS match_reason\n  FROM entities\n  WHERE entity_type='person' AND deleted_at IS NULL AND merged_into IS NULL\n    AND trim(coalesce(name,'')) <> ''\n) s\nWHERE (s.name_grp > 1 AND s.name_key <> '')\n   OR (s.em IS NOT NULL AND s.email_grp > 1)\n   OR (s.ph IS NOT NULL AND length(s.ph) >= 7 AND s.phone_grp > 1)\nORDER BY s.match_reason, s.id\nLIMIT 200) real_candidates WHERE COALESCE(metadata->>'email','') NOT LIKE '%@example.test'",
    },
  },
  reactionsGuidance:
    "Explain uncertainty; never decide identity from names, aliases, or handles. The server-side entity type policy is the only merge authority.",
  skills: ["duplicate-entity-resolution-real-v3-final"],
});

export default defineConfig({
  // Source of truth for buremba definitions. Deletes org-owned entity /
  // relationship types and automations absent from this config (including
  // UI-created ones). Data rows, connections, auth profiles, and agents are
  // never pruned. Tax-graph types belong in examples/personal-finance only.
  prune: true,
  connectors: [
    connectorFromFile<typeof MidasConnector>("./midas.connector.ts"),
    connectorFromFile<typeof RevolutTransactionsConnector>(
      "./revolut-transactions.connector.ts"
    ),
    connectorFromFile<typeof LinkedInConnector>("./linkedin.connector.ts"),
    connectorFromFile<typeof HackerNewsConnector>("./hackernews.connector.ts"),
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
    "Personal agent tracking finances, people, companies, tasks, subscriptions, and trips.",
  agents: [personalAgent],
  entities: [
    person,
    company,
    task,
    channel,
    account,
    netWorthSnapshot,
    subscription,
    trip,
    goal,
    learning,
    voiceProfile,
    socialSignal,
  ],
  relationships: [
    worksAt,
    memberOf,
    mentions,
    connectedWith,
    founderOf,
    sameAs,
  ],
  automations: [
    hourlyTaskCollaborator,
    duplicateEntityResolution,
    voiceProfileSynthesis,
    socialInterestRadar,
    midasNetWorth,
  ],
  authProfiles: [gmailAccountAuth, gmailAppAuth],
  connections: [
    midasConnection,
    marketQuotesConnection,
    revolutConnection,
    takeoutConnection,
    twitterTakeoutConnection,
    instagramTakeoutConnection,
    linkedinConnection,
    hackerNewsConnection,
    gmailConnection,
  ],
});
