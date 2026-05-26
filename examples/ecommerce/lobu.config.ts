import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/cli/config";
import type StripeChargesConnector from "./stripe-charges.connector.ts";

const ecommerceOps = defineAgent({
  id: "ecommerce-ops",
  name: "ecommerce-ops",
  description:
    "Manage subscriptions, process order changes, and resolve customer requests",
  dir: ".",
  providers: [
    {
      id: "anthropic",
      model: "claude/sonnet-4-5",
      key: secret("ANTHROPIC_API_KEY"),
    },
  ],
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

const customer = defineEntityType({
  key: "customer",
  name: "Customer",
  description:
    "A customer with subscriptions, orders, and communication preferences",
  properties: {
    full_name: {
      type: "string",
      "x-table-label": "Name",
      "x-table-column": true,
    },
    status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    plan: { type: "string", "x-table-label": "Plan", "x-table-column": true },
    communication_preference: {
      type: "string",
      "x-table-label": "Preference",
      "x-table-column": true,
    },
  },
});

const order = defineEntityType({
  key: "order",
  name: "Order",
  description: "A customer order with fulfillment status and delivery details",
  properties: {
    order_number: {
      type: "string",
      "x-table-label": "Order",
      "x-table-column": true,
    },
    product: {
      type: "string",
      "x-table-label": "Product",
      "x-table-column": true,
    },
    fulfillment_status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    customer: {
      type: "string",
      "x-table-label": "Customer",
      "x-table-column": true,
    },
  },
});

const product = defineEntityType({
  key: "product",
  name: "Product",
  description: "A product in the catalog linked to subscriptions and orders",
  properties: {
    product_name: {
      type: "string",
      "x-table-label": "Product",
      "x-table-column": true,
    },
    plan_tier: {
      type: "string",
      "x-table-label": "Tier",
      "x-table-column": true,
    },
    delivery_frequency: {
      type: "string",
      "x-table-label": "Delivery",
      "x-table-column": true,
    },
    price: { type: "string", "x-table-label": "Price", "x-table-column": true },
  },
});

const subscription = defineEntityType({
  key: "subscription",
  name: "Subscription",
  description:
    "A recurring subscription plan with billing cycle and pending changes",
  properties: {
    plan_name: {
      type: "string",
      "x-table-label": "Plan",
      "x-table-column": true,
    },
    frequency: {
      type: "string",
      "x-table-label": "Frequency",
      "x-table-column": true,
    },
    status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    pending_changes: {
      type: "string",
      "x-table-label": "Pending",
      "x-table-column": true,
    },
  },
});

const hasPreference = defineRelationshipType({
  key: "has-preference",
  name: "Has Preference",
  description:
    "Persist communication and delivery preferences across interactions.",
});

const placedOrder = defineRelationshipType({
  key: "placed-order",
  name: "Placed Order",
  description: "Link orders to customers so purchase history stays queryable.",
});

const subscribedTo = defineRelationshipType({
  key: "subscribed-to",
  name: "Subscribed To",
  description: "Track which plans and products each customer subscribes to.",
});

const customerActivityTracker = defineWatcher({
  agent: ecommerceOps,
  slug: "customer-activity-tracker",
  name: "Customer activity tracker",
  schedule: "0 */6 * * *",
  notification: { priority: "normal" },
  tags: ["ecommerce", "customer-ops"],
  minCooldownSeconds: 300,
  prompt:
    "Monitor customers for new orders, subscription changes, delivery requests, and support interactions.\n",
  extractionSchema: {
    type: "object",
    required: [
      "subscription_status",
      "pending_changes",
      "recent_orders",
      "communication_preferences",
      "open_requests",
    ],
    properties: {
      subscription_status: { type: "string" },
      pending_changes: { type: "array", items: { type: "string" } },
      recent_orders: { type: "array", items: { type: "string" } },
      communication_preferences: { type: "string" },
      open_requests: { type: "array", items: { type: "string" } },
    },
  },
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof StripeChargesConnector>(
      "./stripe-charges.connector.ts"
    ),
  ],
  org: "ecommerce",
  orgName: "Ecommerce",
  orgDescription:
    "Manage subscriptions, process order changes, and resolve customer requests",
  agents: [ecommerceOps],
  entities: [customer, order, product, subscription],
  relationships: [hasPreference, placedOrder, subscribedTo],
  watchers: [customerActivityTracker],
});
