import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/cli/config";

const finance = defineAgent({
  id: "finance",
  name: "finance",
  description:
    "Help finance teams reconcile data, explain variance, and prepare reporting runs",
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

const account = defineEntityType({
  key: "account",
  name: "Account",
  description:
    "A financial account that holds balances, transactions, and reconciliation state",
  properties: {
    account_name: {
      type: "string",
      "x-table-label": "Account",
      "x-table-column": true,
    },
    account_type: {
      type: "string",
      "x-table-label": "Type",
      "x-table-column": true,
    },
    balance: {
      type: "string",
      "x-table-label": "Balance",
      "x-table-column": true,
    },
    reconciliation_status: {
      type: "string",
      "x-table-label": "Reconciliation",
      "x-table-column": true,
    },
  },
});

const report = defineEntityType({
  key: "report",
  name: "Report",
  description:
    "A financial report or summary generated from account and transaction data",
  properties: {
    report_name: {
      type: "string",
      "x-table-label": "Report",
      "x-table-column": true,
    },
    period: {
      type: "string",
      "x-table-label": "Period",
      "x-table-column": true,
    },
    status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    exceptions_count: {
      type: "string",
      "x-table-label": "Exceptions",
      "x-table-column": true,
    },
  },
});

const transaction = defineEntityType({
  key: "transaction",
  name: "Transaction",
  description: "A financial transaction that affects account balances",
  properties: {
    description: {
      type: "string",
      "x-table-label": "Description",
      "x-table-column": true,
    },
    amount: {
      type: "string",
      "x-table-label": "Amount",
      "x-table-column": true,
    },
    date: { type: "string", "x-table-label": "Date", "x-table-column": true },
    category: {
      type: "string",
      "x-table-label": "Category",
      "x-table-column": true,
    },
  },
});

const variance = defineEntityType({
  key: "variance",
  name: "Variance",
  description:
    "A discrepancy or anomaly identified during reconciliation or reporting",
  properties: {
    variance_type: {
      type: "string",
      "x-table-label": "Type",
      "x-table-column": true,
    },
    amount: {
      type: "string",
      "x-table-label": "Amount",
      "x-table-column": true,
    },
    source_account: {
      type: "string",
      "x-table-label": "Account",
      "x-table-column": true,
    },
    explanation: {
      type: "string",
      "x-table-label": "Explanation",
      "x-table-column": true,
    },
  },
});

const createsVariance = defineRelationshipType({
  key: "creates-variance",
  name: "Creates Variance",
  description:
    "Keep anomalies attached to the source records that produced them.",
});

const reconcilesTo = defineRelationshipType({
  key: "reconciles-to",
  name: "Reconciles To",
  description:
    "Tie transactions and balances back to the accounts they roll into.",
});

const summarizedIn = defineRelationshipType({
  key: "summarized-in",
  name: "Summarized In",
  description:
    "Let agents trace reporting outputs back to the supporting data.",
});

const reconciliationMonitor = defineWatcher({
  agent: finance,
  slug: "reconciliation-monitor",
  name: "Reconciliation monitor",
  schedule: "0 6 * * 1-5",
  notification: { priority: "high", channel: "both" },
  tags: ["finance", "reconciliation", "daily"],
  minCooldownSeconds: 3600,
  reaction: "./reconciliation-monitor.reaction.ts",
  prompt:
    "Check accounts for unreconciled transactions, new variances, and approaching reporting deadlines. Lead with exceptions that need review.\n",
  extractionSchema: {
    type: "object",
    required: ["unreconciled_count", "new_variances", "approaching_deadlines"],
    properties: {
      unreconciled_count: { type: "integer" },
      new_variances: { type: "array", items: { type: "string" } },
      approaching_deadlines: { type: "array", items: { type: "string" } },
      payment_risks: { type: "array", items: { type: "string" } },
    },
  },
});

export default defineConfig({
  connectors: [connectorFromFile("./quickbooks-transactions.connector.ts")],
  org: "finance",
  orgName: "Finance",
  orgDescription:
    "Help finance teams reconcile data, explain variance, and prepare reporting runs",
  agents: [finance],
  entities: [account, report, transaction, variance],
  relationships: [createsVariance, reconcilesTo, summarizedIn],
  watchers: [reconciliationMonitor],
});
