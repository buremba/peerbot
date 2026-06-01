import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineEntityType,
  secret,
} from "@lobu/cli/config";
import type RevolutTransactionsConnector from "./revolut-transactions.connector.ts";

const personalAgent = defineAgent({
  id: "personal-agent",
  dir: ".",
  name: "personal-agent",
  description:
    "A personal agent that tracks finances, people, companies, subscriptions, trips, and topics across the user's own data.",
  providers: [
    {
      id: "anthropic",
      model: "claude/sonnet-4-5",
      key: secret("ANTHROPIC_API_KEY"),
    },
  ],
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
    role: {
      type: "string",
      "x-table-label": "Role",
      "x-table-column": true,
    },
    type: {
      type: "string",
      enum: ["employee", "client_contact", "partner", "external"],
      "x-table-label": "Type",
      "x-table-column": true,
    },
    email: {
      type: "string",
      "x-table-label": "Email",
      "x-table-column": true,
    },
    company: {
      type: "string",
      "x-table-label": "Company",
      "x-table-column": true,
    },
    session_prefix: { type: "string" },
  },
});

const company = defineEntityType({
  key: "company",
  name: "Company",
  description: "Portfolio company or deal pipeline company",
  metadata: { icon: "building", color: "#2563eb" },
  properties: {
    mrr: { type: "number", "x-table-label": "MRR", "x-table-column": true },
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
      "x-table-label": "Stage",
      "x-table-column": true,
    },
    market: {
      type: "string",
      "x-table-label": "Market",
      "x-table-column": true,
    },
    thesis: { type: "string" },
    revenue: { type: "number" },
    location: { type: "string" },
    one_liner: { type: "string" },
    team_size: { type: "integer" },
    valuation: { type: "number" },
    growth_rate: { type: "number" },
    linkedin_url: { type: "string" },
    founding_year: { type: "integer" },
    funding_raised: { type: "number" },
    traction_score: { type: "number" },
    traction_signals: { type: "object" },
  },
});

const asset = defineEntityType({
  key: "asset",
  name: "Asset",
  description:
    "Things you own with monetary value - bank accounts, property, investments, vehicles, devices",
  metadata: { icon: "💰", color: "#10B981" },
  properties: {
    value: {
      type: "number",
      "x-table-label": "Value",
      "x-table-column": true,
    },
    status: {
      type: "string",
      enum: ["active", "sold", "closed"],
      "x-table-label": "Status",
      "x-table-column": true,
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
      "x-table-label": "Category",
      "x-table-column": true,
    },
    currency: {
      type: "string",
      "x-table-label": "Ccy",
      "x-table-column": true,
    },
    acquired_date: { type: "string" },
  },
});

const subscription = defineEntityType({
  key: "subscription",
  name: "Subscription",
  description:
    "Recurring costs and obligations - subscriptions, bills, insurance, memberships",
  metadata: { icon: "🔄", color: "#EF4444" },
  properties: {
    amount: {
      type: "number",
      "x-table-label": "Amount",
      "x-table-column": true,
    },
    status: {
      type: "string",
      enum: ["active", "cancelled", "changed"],
      "x-table-label": "Status",
      "x-table-column": true,
    },
    category: {
      type: "string",
      enum: ["subscription", "bill", "insurance", "membership"],
      "x-table-label": "Category",
      "x-table-column": true,
    },
    currency: {
      type: "string",
      "x-table-label": "Ccy",
      "x-table-column": true,
    },
    frequency: {
      type: "string",
      enum: ["monthly", "annual", "periodic"],
      "x-table-label": "Frequency",
      "x-table-column": true,
    },
    last_seen: { type: "string" },
    first_seen: { type: "string" },
    billing_day: { type: "number" },
    total_spent: { type: "number" },
  },
});

const topic = defineEntityType({
  key: "topic",
  name: "Topic",
  description:
    "Generic topic or category for organizing content and connections",
  metadata: { icon: "📚", color: "#8B5CF6" },
  properties: {
    description: {
      type: "string",
      "x-table-label": "Description",
      "x-table-column": true,
    },
  },
});

const trip = defineEntityType({
  key: "trip",
  name: "Trip",
  description: "Travel experiences with associated spending",
  metadata: { icon: "✈️", color: "#F59E0B" },
  properties: {
    people: {
      type: "number",
      "x-table-label": "People",
      "x-table-column": true,
    },
    currency: {
      type: "string",
      "x-table-label": "Ccy",
      "x-table-column": true,
    },
    end_date: {
      type: "string",
      "x-table-label": "End",
      "x-table-column": true,
    },
    start_date: {
      type: "string",
      "x-table-label": "Start",
      "x-table-column": true,
    },
    total_cost: {
      type: "number",
      "x-table-label": "Total",
      "x-table-column": true,
    },
    destination: {
      type: "string",
      "x-table-label": "Destination",
      "x-table-column": true,
    },
  },
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
});
