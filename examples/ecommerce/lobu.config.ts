import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineSkill,
  defineEntityType,
  defineRelationshipType,
  defineAutomation,
  every,
  secret,
} from "@lobu/cli/config";
import type StripeChargesConnector from "./stripe-charges.connector.ts";

const customerActivityTrackerSkill = defineSkill({
  name: "customer-activity-tracker",
  content:
    "Monitor customers for new orders, subscription changes, delivery requests, and support interactions.\n",
});

const ecommerceOps = defineAgent({
  id: "ecommerce-ops",
  skills: [customerActivityTrackerSkill],
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

const customerActivityTracker = defineAutomation({
  agent: ecommerceOps,
  slug: "customer-activity-tracker",
  name: "Customer activity tracker",
  triggers: [every("0 */6 * * *")],
  notification: { priority: "normal" },
  tags: ["ecommerce", "customer-ops"],
  minCooldownSeconds: 300,
  skills: ["customer-activity-tracker"],
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
  automations: [customerActivityTracker],
});
