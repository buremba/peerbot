import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/cli/config";

const legalReview = defineAgent({
  id: "legal-review",
  name: "legal-review",
  description:
    "Review contracts, summarize risk, and surface missing protections",
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

const clause = defineEntityType({
  key: "clause",
  name: "Clause",
  description:
    "A specific provision or section within a contract that defines terms or obligations",
  properties: {
    clause_type: {
      type: "string",
      "x-table-label": "Type",
      "x-table-column": true,
    },
    section: {
      type: "string",
      "x-table-label": "Section",
      "x-table-column": true,
    },
    risk_level: {
      type: "string",
      "x-table-label": "Risk Level",
      "x-table-column": true,
    },
    language_summary: {
      type: "string",
      "x-table-label": "Summary",
      "x-table-column": true,
    },
  },
});

const contract = defineEntityType({
  key: "contract",
  name: "Contract",
  description:
    "A legal agreement between parties with defined terms, obligations, and conditions",
  properties: {
    contract_type: {
      type: "string",
      "x-table-label": "Type",
      "x-table-column": true,
    },
    status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
    effective_date: {
      type: "string",
      "x-table-label": "Effective Date",
      "x-table-column": true,
    },
    counterparty_name: {
      type: "string",
      "x-table-label": "Counterparty",
      "x-table-column": true,
    },
    governing_law: { type: "string", "x-table-label": "Governing Law" },
  },
});

const counterparty = defineEntityType({
  key: "counterparty",
  name: "Counterparty",
  description: "An external party involved in a contract or legal agreement",
  properties: {
    organization_name: {
      type: "string",
      "x-table-label": "Organization",
      "x-table-column": true,
    },
    jurisdiction: {
      type: "string",
      "x-table-label": "Jurisdiction",
      "x-table-column": true,
    },
    contact_person: {
      type: "string",
      "x-table-label": "Contact",
      "x-table-column": true,
    },
    relationship_status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
  },
});

const risk = defineEntityType({
  key: "risk",
  name: "Risk",
  description:
    "A legal risk identified in a contract or clause that requires attention or mitigation",
  properties: {
    severity: {
      type: "string",
      "x-table-label": "Severity",
      "x-table-column": true,
    },
    category: {
      type: "string",
      "x-table-label": "Category",
      "x-table-column": true,
    },
    mitigation: {
      type: "string",
      "x-table-label": "Mitigation",
      "x-table-column": true,
    },
    source_clause: {
      type: "string",
      "x-table-label": "Source Clause",
      "x-table-column": true,
    },
  },
});

const belongsToCounterparty = defineRelationshipType({
  key: "belongs-to-counterparty",
  name: "Belongs to Counterparty",
  description:
    "Tie agreements and negotiation context back to the right external party.",
});

const containsClause = defineRelationshipType({
  key: "contains-clause",
  name: "Contains Clause",
  description:
    "Represent how a contract is composed so risky language stays attached to the right section.",
});

const createsRisk = defineRelationshipType({
  key: "creates-risk",
  name: "Creates Risk",
  description: "Keep legal risk linked to the clause or term that caused it.",
});

const contractReviewTracker = defineWatcher({
  agent: legalReview,
  slug: "contract-review-tracker",
  name: "Contract review tracker",
  schedule: "0 8 * * 1-5",
  notification: { priority: "high" },
  tags: ["legal", "contract", "daily"],
  minCooldownSeconds: 1800,
  reactionsGuidance:
    "For any contract with `status: needs_counsel`, route an entity-scoped event\nto the assigned reviewer. For contracts >90 days unsigned, escalate to the\ncounterparty owner; never auto-resolve risk items.\n",
  prompt:
    "Review active contracts for approaching deadlines, unsigned agreements, and unresolved risk items. Flag any clauses that still need counsel approval.\n",
  extractionSchema: {
    type: "object",
    required: [
      "pending_contracts",
      "unresolved_risks",
      "approaching_deadlines",
    ],
    properties: {
      pending_contracts: { type: "array", items: { type: "string" } },
      unresolved_risks: { type: "array", items: { type: "string" } },
      approaching_deadlines: { type: "array", items: { type: "string" } },
      flagged_clauses: { type: "array", items: { type: "string" } },
    },
  },
});

export default defineConfig({
  connectors: [connectorFromFile("./docusign-envelopes.connector.ts")],
  org: "legal-review",
  orgName: "Legal",
  orgDescription:
    "Review contracts, summarize risk, and surface missing protections",
  agents: [legalReview],
  entities: [clause, contract, counterparty, risk],
  relationships: [belongsToCounterparty, containsClause, createsRisk],
  watchers: [contractReviewTracker],
});
