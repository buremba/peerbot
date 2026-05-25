import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/cli/config";

const delivery = defineAgent({
  id: "delivery",
  name: "delivery",
  description:
    "Help delivery teams keep milestones, blockers, owners, and artifacts aligned",
  dir: "./agents/delivery",
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

const blocker = defineEntityType({
  key: "blocker",
  name: "Blocker",
  description: "A dependency or issue that is blocking project progress",
  properties: {
    blocker_description: {
      type: "string",
      "x-table-label": "Blocker",
      "x-table-column": true,
    },
    owned_by: {
      type: "string",
      "x-table-label": "Owner",
      "x-table-column": true,
    },
    impact: {
      type: "string",
      "x-table-label": "Impact",
      "x-table-column": true,
    },
    status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
  },
});

const document = defineEntityType({
  key: "document",
  name: "Document",
  description: "A project artifact, review, or reference document",
  properties: {
    document_name: {
      type: "string",
      "x-table-label": "Document",
      "x-table-column": true,
    },
    document_type: {
      type: "string",
      "x-table-label": "Type",
      "x-table-column": true,
    },
    linked_project: {
      type: "string",
      "x-table-label": "Project",
      "x-table-column": true,
    },
    last_updated: {
      type: "string",
      "x-table-label": "Updated",
      "x-table-column": true,
    },
  },
});

const milestone = defineEntityType({
  key: "milestone",
  name: "Milestone",
  description: "A key deliverable or phase gate within a project",
  properties: {
    milestone_name: {
      type: "string",
      "x-table-label": "Milestone",
      "x-table-column": true,
    },
    lifecycle_state: {
      type: "string",
      "x-table-label": "State",
      "x-table-column": true,
    },
    target_date: {
      type: "string",
      "x-table-label": "Target Date",
      "x-table-column": true,
    },
    parent_project: {
      type: "string",
      "x-table-label": "Project",
      "x-table-column": true,
    },
  },
});

const stakeholder = defineEntityType({
  key: "stakeholder",
  name: "Stakeholder",
  description: "A person who owns or is responsible for part of a project",
  properties: {
    name: { type: "string", "x-table-label": "Name", "x-table-column": true },
    role: { type: "string", "x-table-label": "Role", "x-table-column": true },
    owns: { type: "string", "x-table-label": "Owns", "x-table-column": true },
    contact: { type: "string", "x-table-label": "Contact" },
  },
});

const blockedBy = defineRelationshipType({
  key: "blocked-by",
  name: "Blocked By",
  description:
    "Tie blockers directly to the project and milestone they threaten.",
});

const documentedIn = defineRelationshipType({
  key: "documented-in",
  name: "Documented In",
  description:
    "Preserve the source documents and reviews behind key project state.",
});

const ownedBy = defineRelationshipType({
  key: "owned-by",
  name: "Owned By",
  description: "Keep project ownership queryable across updates and artifacts.",
});

const phoenixRolloutTracker = defineWatcher({
  agent: delivery,
  slug: "phoenix-rollout-tracker",
  name: "Phoenix rollout tracker",
  schedule: "0 9 * * 1",
  notification: { priority: "high", channel: "both" },
  tags: ["delivery", "weekly", "rollout"],
  minCooldownSeconds: 3600,
  prompt:
    "Check project blockers, milestone progress, and generate the weekly risk summary for leadership.\n",
  extractionSchema: {
    type: "object",
    required: [
      "blockers_resolved",
      "milestone_state",
      "new_risks",
      "risk_summary",
    ],
    properties: {
      blockers_resolved: { type: "array", items: { type: "string" } },
      milestone_state: { type: "string" },
      new_risks: { type: "array", items: { type: "string" } },
      risk_summary: { type: "string" },
    },
  },
});

export default defineConfig({
  connectors: [connectorFromFile("./shopify-orders.connector.ts")],
  org: "delivery",
  orgName: "Delivery",
  orgDescription:
    "Help delivery teams keep milestones, blockers, owners, and artifacts aligned",
  agents: [delivery],
  entities: [blocker, document, milestone, stakeholder],
  relationships: [blockedBy, documentedIn, ownedBy],
  watchers: [phoenixRolloutTracker],
});
