import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/cli/config";
import type LinearCyclesConnector from "./linear-cycles.connector.ts";

const leadership = defineAgent({
  id: "leadership",
  name: "leadership",
  description:
    "Help leadership teams turn memos, decisions, and board materials into reusable operating context",
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

const decision = defineEntityType({
  key: "decision",
  name: "Decision",
  description:
    "A leadership decision extracted from a document with its approval status",
  properties: {
    subject: {
      type: "string",
      "x-table-label": "Subject",
      "x-table-column": true,
    },
    status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    source_document: {
      type: "string",
      "x-table-label": "Source",
      "x-table-column": true,
    },
    decision_date: {
      type: "string",
      "x-table-label": "Date",
      "x-table-column": true,
    },
  },
});

const document = defineEntityType({
  key: "document",
  name: "Document",
  description:
    "A source document such as a board memo, strategy brief, or executive report",
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
    date: { type: "string", "x-table-label": "Date", "x-table-column": true },
    decisions_count: {
      type: "string",
      "x-table-label": "Decisions",
      "x-table-column": true,
    },
  },
});

const region = defineEntityType({
  key: "region",
  name: "Region",
  description:
    "A geographic region referenced in strategic decisions or expansion plans",
  properties: {
    region_name: {
      type: "string",
      "x-table-label": "Region",
      "x-table-column": true,
    },
    decision_context: {
      type: "string",
      "x-table-label": "Context",
      "x-table-column": true,
    },
    status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    budget_approved: { type: "string", "x-table-label": "Budget" },
  },
});

const risk = defineEntityType({
  key: "risk",
  name: "Risk",
  description:
    "A blocker or dependency that is holding up a decision or initiative",
  properties: {
    blocker: {
      type: "string",
      "x-table-label": "Blocker",
      "x-table-column": true,
    },
    affects: {
      type: "string",
      "x-table-label": "Affects",
      "x-table-column": true,
    },
    state: { type: "string", "x-table-label": "State", "x-table-column": true },
    owner: { type: "string", "x-table-label": "Owner", "x-table-column": true },
  },
});

const task = defineEntityType({
  key: "task",
  name: "Task",
  description:
    "An assigned follow-up action extracted from a leadership document or meeting",
  properties: {
    action: {
      type: "string",
      "x-table-label": "Action",
      "x-table-column": true,
    },
    owner: { type: "string", "x-table-label": "Owner", "x-table-column": true },
    deadline: {
      type: "string",
      "x-table-label": "Deadline",
      "x-table-column": true,
    },
    source: {
      type: "string",
      "x-table-label": "Source",
      "x-table-column": true,
    },
  },
});

const approved = defineRelationshipType({
  key: "approved",
  name: "Approved",
  description:
    "Keep approved decisions queryable without re-reading the whole source memo.",
});

const assigned = defineRelationshipType({
  key: "assigned",
  name: "Assigned",
  description:
    "Turn follow-up work into durable ownership instead of transient notes.",
});

const blockedBy = defineRelationshipType({
  key: "blocked-by",
  name: "Blocked By",
  description:
    "Attach blocked decisions to the dependency that is holding them up.",
});

const boardActionTracker = defineWatcher({
  agent: leadership,
  slug: "board-action-tracker",
  name: "Board action tracker",
  schedule: "0 8 * * *",
  notification: { priority: "high", channel: "both" },
  tags: ["leadership", "daily", "board"],
  agentKind: "notifier",
  prompt:
    "Track board action items: check task delivery status, blocker resolution progress, and approaching deadlines for the next board packet.\n",
  extractionSchema: {
    type: "object",
    required: [
      "action_items",
      "blocked_items",
      "deadlines_approaching",
      "completion_status",
    ],
    properties: {
      action_items: { type: "array", items: { type: "string" } },
      blocked_items: { type: "array", items: { type: "string" } },
      deadlines_approaching: { type: "array", items: { type: "string" } },
      completion_status: { type: "string" },
    },
  },
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof LinearCyclesConnector>(
      "./linear-cycles.connector.ts"
    ),
  ],
  org: "leadership",
  orgName: "Leadership",
  orgDescription:
    "Turn memos, decisions, and board materials into reusable operating context",
  agents: [leadership],
  entities: [decision, document, region, risk, task],
  relationships: [approved, assigned, blockedBy],
  watchers: [boardActionTracker],
});
