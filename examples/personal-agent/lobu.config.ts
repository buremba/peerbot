import {
  connectorFromFile,
  defineAgent,
  defineAuthProfile,
  defineConfig,
  defineConnection,
  defineEntityType,
} from "@lobu/cli/config";
import type RevolutTransactionsConnector from "./revolut-transactions.connector.ts";

// This Mac's device worker (Owletto). Syncs/actions for device-pinned
// connections run here — where the logged-in Chrome / CDP session lives.
const DEVICE_WORKER_ID = "2c295bed-1dfa-4c8b-9f58-c20a62aadfc2";

const personalAgent = defineAgent({
  id: "personal-agent",
  dir: ".",
  name: "personal-agent",
  description:
    "A personal agent that tracks finances, people, companies, subscriptions, trips, and topics across the user's own data.",
  // No cloud provider key: runs on the local/Mac-app device worker and inherits
  // the org's default provider. No ANTHROPIC_API_KEY needed.
  network: {
    allowed: [
      "app.revolut.com",
      ".revolut.com",
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

const subscription = defineEntityType({
  key: "subscription",
  name: "Subscription",
  description:
    "Recurring costs and obligations - subscriptions, bills, insurance, memberships",
  metadata: { icon: "🔄", color: "#EF4444" },
  required: ["category"],
  properties: {
    amount: { type: "number", description: "Current charge amount" },
    status: {
      type: "string",
      enum: ["active", "cancelled", "changed"],
      description: "Current status",
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
    last_seen: { type: "string", format: "date" },
    first_seen: { type: "string", format: "date" },
    billing_day: {
      type: "number",
      description: "Day of month typically charged",
    },
    total_spent: {
      type: "number",
      description: "Total spent over tracked period",
    },
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

const trip = defineEntityType({
  key: "trip",
  name: "Trip",
  description: "Travel experiences with associated spending",
  metadata: { icon: "✈️", color: "#F59E0B" },
  required: ["destination"],
  properties: {
    people: { type: "number", description: "Number of travellers" },
    currency: { type: "string" },
    end_date: { type: "string", format: "date" },
    start_date: { type: "string", format: "date" },
    total_cost: { type: "number" },
    destination: { type: "string", description: "Primary destination" },
  },
});

// Revolut runs through the browser's live session over CDP, so its auth grant
// is performed at runtime (lobu memory browser-auth) — no stored secret here.
const revolutAuth = defineAuthProfile({
  slug: "revolut-buremba",
  connector: "revolut",
  authKind: "browser_session",
  name: "Revolut (this Mac)",
});

// Connection pinned to THIS Mac's device worker: the sync runs where the
// logged-in Revolut Chrome / CDP session lives, not in the cloud. max_scrolls
// is raised so the first run paginates the full multi-year history.
const revolutConnection = defineConnection({
  slug: "revolut-buremba",
  connector: "revolut",
  name: "Revolut",
  authProfile: "revolut-buremba",
  deviceWorkerId: DEVICE_WORKER_ID,
  feeds: [{ feed: "transactions", config: { max_scrolls: 100 } }],
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
  authProfiles: [revolutAuth],
  connections: [revolutConnection],
});
