import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  reactionFromFile,
  secret,
} from "@lobu/cli/config";
import type SalesforcePipelineConnector from "./salesforce-pipeline.connector.ts";
import type accountHealthMonitorReaction from "./account-health-monitor.reaction.ts";

const sales = defineAgent({
  id: "sales",
  name: "sales",
  description:
    "Help revenue teams track account health, rollout progress, and renewal signals",
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

const organization = defineEntityType({
  key: "organization",
  name: "Organization",
  description:
    "A customer account or prospect being tracked by the revenue team",
  properties: {
    company_name: {
      type: "string",
      "x-table-label": "Company",
      "x-table-column": true,
    },
    stage: { type: "string", "x-table-label": "Stage", "x-table-column": true },
    arr: { type: "string", "x-table-label": "ARR", "x-table-column": true },
    renewal_date: {
      type: "string",
      "x-table-label": "Renewal Date",
      "x-table-column": true,
    },
  },
});

const product = defineEntityType({
  key: "product",
  name: "Product",
  description: "A product rollout or pilot being tracked at a customer account",
  properties: {
    product_name: {
      type: "string",
      "x-table-label": "Product",
      "x-table-column": true,
    },
    pilot_status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    owner_team: {
      type: "string",
      "x-table-label": "Owner",
      "x-table-column": true,
    },
    account: {
      type: "string",
      "x-table-label": "Account",
      "x-table-column": true,
    },
  },
});

const region = defineEntityType({
  key: "region",
  name: "Region",
  description: "A geographic region where an account is expanding or operating",
  properties: {
    region_name: {
      type: "string",
      "x-table-label": "Region",
      "x-table-column": true,
    },
    expansion_status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    parent_account: {
      type: "string",
      "x-table-label": "Account",
      "x-table-column": true,
    },
    market_size: { type: "string", "x-table-label": "Market Size" },
  },
});

const renewalRisk = defineEntityType({
  key: "renewal-risk",
  name: "Renewal Risk",
  description:
    "A commercial signal or concern that affects an upcoming renewal or expansion",
  properties: {
    signal: {
      type: "string",
      "x-table-label": "Signal",
      "x-table-column": true,
    },
    severity: {
      type: "string",
      "x-table-label": "Severity",
      "x-table-column": true,
    },
    affects: {
      type: "string",
      "x-table-label": "Affects",
      "x-table-column": true,
    },
    next_step: {
      type: "string",
      "x-table-label": "Next Step",
      "x-table-column": true,
    },
  },
});

const team = defineEntityType({
  key: "team",
  name: "Team",
  description:
    "An internal team or customer function that owns a pilot or initiative",
  properties: {
    team_name: {
      type: "string",
      "x-table-label": "Team",
      "x-table-column": true,
    },
    role: { type: "string", "x-table-label": "Role", "x-table-column": true },
    owns: { type: "string", "x-table-label": "Owns", "x-table-column": true },
    account: {
      type: "string",
      "x-table-label": "Account",
      "x-table-column": true,
    },
  },
});

const affects = defineRelationshipType({
  key: "affects",
  name: "Affects",
  description:
    "Connect commercial signals directly to the renewal or expansion they influence.",
});

const expandedInto = defineRelationshipType({
  key: "expanded-into",
  name: "Expanded Into",
  description:
    "Track where an account is growing so territory and rollout context stay explicit.",
});

const runs = defineRelationshipType({
  key: "runs",
  name: "Runs",
  description:
    "Link the internal team or customer function to the pilot they own.",
});

const accountHealthMonitor = defineWatcher({
  agent: sales,
  slug: "account-health-monitor",
  name: "Account health monitor",
  schedule: "0 */12 * * *",
  notification: { priority: "high", channel: "both" },
  tags: ["sales", "health", "renewals"],
  minCooldownSeconds: 1800,
  reaction: reactionFromFile<typeof accountHealthMonitorReaction>(
    "./account-health-monitor.reaction.ts"
  ),
  prompt:
    "Poll CRM data for tracked accounts. Track expansion progress, risk level changes, and renewal timeline.\n",
  extractionSchema: {
    type: "object",
    required: [
      "risk_level",
      "expansion_status",
      "renewal_blockers",
      "activity_delta",
    ],
    properties: {
      risk_level: { type: "string" },
      expansion_status: { type: "string" },
      renewal_blockers: { type: "array", items: { type: "string" } },
      activity_delta: { type: "string" },
    },
  },
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof SalesforcePipelineConnector>(
      "./salesforce-pipeline.connector.ts"
    ),
  ],
  org: "sales",
  orgName: "Sales",
  orgDescription:
    "Help revenue teams track account health, rollout progress, and renewal signals",
  agents: [sales],
  entities: [organization, product, region, renewalRisk, team],
  relationships: [affects, expandedInto, runs],
  watchers: [accountHealthMonitor],
});
