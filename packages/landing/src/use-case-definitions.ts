import { generatedUseCaseModels } from "./generated/use-case-models";

export type MemoryField = {
  label: string;
  value: string;
};

export type RecordNode = {
  id: string;
  label: string;
  kind: string;
  summary: string;
  chips?: string[];
  children?: RecordNode[];
};

export type ExampleRelation = {
  source: string;
  sourceType: string;
  label: string;
  target: string;
  targetType: string;
  note: string;
};

type ExampleLink = {
  label: string;
  href: string;
};

export type HowItWorksPanelItem = {
  label: string;
  detail: string;
  meta?: string;
  platform?: {
    id: "slack" | "openclaw" | "chatgpt" | "claude";
    label: string;
  };
};

export type HowItWorksPanelTable = {
  columns: string[];
  rows: string[][];
};

export type HowItWorksPanel = {
  title: string;
  description?: string;
  items?: HowItWorksPanelItem[];
  table?: HowItWorksPanelTable;
};

export type HowItWorksStep = {
  id: "model" | "connect" | "auth" | "reuse" | "fresh";
  label: string;
  title: string;
  detail: string;
  chips?: string[];
  links?: ExampleLink[];
  panel?: HowItWorksPanel;
};

export type MemoryExample = {
  id: string;
  tab: string;
  title: string;
  description: string;
  entityTypes: string[];
  entitySelections?: Record<string, string>;
  howItWorks: HowItWorksStep[];
  highlights: MemoryField[];
  nodeHighlights?: Record<string, MemoryField[]>;
  watcher: {
    name: string;
    schedule: string;
    prompt: string;
    extractionSchema: string;
    schemaEvolution: string;
  };
  recordTree: RecordNode;
  relations: ExampleRelation[];
};

export type SkillWorkspacePreviewData = {
  name: string;
  description: string;
  agentId: string;
  skillId: string;
  skills: string[];
  nixPackages: string[];
  allowedDomains: string[];
  mcpServer: string;
  providerId: string;
  model: string;
  apiKeyEnv: string;
  identity: string[];
  soul: string[];
  user: string[];
  skillInstructions: string[];
};

export type LandingUseCaseAgentDefinition = {
  identity: string[];
  soul: string[];
  user: string[];
};

export type LandingUseCaseModelDefinition = {
  entities: string[];
};

export type LandingUseCaseSkillsDefinition = {
  description: string;
  agentId: string;
  skillId: string;
  skills: string[];
  nixPackages: string[];
  allowedDomains: string[];
  mcpServer: string;
  providerId: string;
  model: string;
  apiKeyEnv: string;
  skillInstructions: string[];
};

export type LandingUseCaseMemoryDefinition = {
  id: string;
  description: string;
  entitySelections?: Record<string, string>;
  howItWorks: HowItWorksStep[];
  highlights: MemoryField[];
  nodeHighlights?: Record<string, MemoryField[]>;
  watcher: {
    name: string;
    schedule: string;
    prompt: string;
    extractionSchema: string;
    schemaEvolution: string;
  };
  recordTree: RecordNode;
  relations: ExampleRelation[];
};

export type LandingUseCaseDefinition = {
  id: string;
  label: string;
  examplePath: string;
  agent: LandingUseCaseAgentDefinition;
  model: LandingUseCaseModelDefinition;
  skills: LandingUseCaseSkillsDefinition;
  memory: LandingUseCaseMemoryDefinition;
  owlettoOrg?: string;
};

export const technicalLinks = {
  mcpProxy: { label: "MCP proxy", href: "/guides/mcp-proxy/" },
  connectorSdk: {
    label: "Connector SDK",
    href: "/reference/owletto-cli/#connector-sdk",
  },
  memoryDocs: { label: "Memory docs", href: "/getting-started/memory/" },
  slackInstall: { label: "Slack install", href: "/platforms/slack/" },
  watcherDocs: {
    label: "Watcher docs",
    href: "/getting-started/memory/#watchers",
  },
  mcpAuthFlow: { label: "MCP auth flow", href: "/guides/mcp-proxy/" },
};

function g(id: string) {
  return generatedUseCaseModels[id];
}

type HowItWorksStepConfig = {
  detail: string;
  chips?: string[];
  links?: ExampleLink[];
  title?: string;
};

function buildHowItWorks(config: {
  model: HowItWorksStepConfig;
  connect: HowItWorksStepConfig;
  auth: HowItWorksStepConfig;
  reuse: HowItWorksStepConfig;
  fresh: { detail: string; title?: string; links?: ExampleLink[] };
}): HowItWorksStep[] {
  return [
    {
      id: "model",
      label: "1",
      title: config.model.title ?? "Model the world",
      detail: config.model.detail,
      chips: config.model.chips,
      links: config.model.links,
    },
    {
      id: "connect",
      label: "2",
      title: config.connect.title ?? "Connect sources",
      detail: config.connect.detail,
      chips: config.connect.chips,
      links: config.connect.links,
    },
    {
      id: "auth",
      label: "3",
      title: config.auth.title ?? "Let users connect their data",
      detail: config.auth.detail,
      chips: config.auth.chips,
      links: config.auth.links,
    },
    {
      id: "reuse",
      label: "4",
      title: config.reuse.title ?? "Reuse context across agents",
      detail: config.reuse.detail,
      chips: config.reuse.chips,
      links: config.reuse.links,
    },
    {
      id: "fresh",
      label: "5",
      title: config.fresh.title ?? "Keep it fresh",
      detail: config.fresh.detail,
      links: config.fresh.links,
    },
  ];
}

export const landingUseCases = {
  legal: {
    id: "legal",
    label: "Legal",
    examplePath: "legal",
    agent: g("legal").agent,
    model: g("legal").model,
    skills: g("legal").skills,
    memory: {
      id: "contract",
      description:
        "Store contracts, clauses, counterparties, and risk so every review starts with context.",
      entitySelections: {
        Contract: "legal-contract",
        Clause: "legal-clause",
        Risk: "legal-risk",
        Counterparty: "legal-counterparty",
      },
      howItWorks: buildHowItWorks({
        model: {
          detail:
            "Represent contracts, clauses, risks, and counterparties as typed objects so review history and negotiations stay queryable.",
          chips: ["Contract", "Clause", "Risk", "Counterparty"],
        },
        connect: {
          detail:
            "Bring in uploaded agreements, shared drives, research tools, and custom parsing pipelines through connector-backed ingestion and MCP proxying.",
          chips: ["File upload", "Drive", "Research", "Custom SDK"],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Use OAuth for document systems, API keys for legal research, and manual uploads for negotiated drafts without exposing credentials to the agent runtime.",
          chips: ["OAuth", "API keys", "File upload", "Manual review"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          detail:
            "The same contract memory powers legal agents wherever teams work.",
          chips: ["Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers track new drafts, changes in negotiated language, and unresolved risk so redlines stay grounded in the latest document state.",
        },
      }),
      watcher: {
        name: "Contract review tracker",
        schedule: "Every 12 hours",
        prompt:
          "Check Redwood Capital contract changes, unresolved risks, and new draft versions.",
        extractionSchema:
          "{ changed_clauses[], unresolved_risks[], new_counterparty_terms[] }",
        schemaEvolution:
          "Started with clause + risk capture. After repeated NDA reviews, added negotiated_position and fallback_language fields.",
      },
      highlights: [
        { label: "Contract", value: "Redwood NDA" },
        { label: "Counterparty", value: "Redwood Capital" },
        { label: "Risk", value: "No cap on confidentiality term" },
        {
          label: "Negotiation point",
          value: "Broad residuals + Delaware venue",
        },
      ],
      nodeHighlights: {
        "legal-root": [
          { label: "Contract", value: "Redwood NDA" },
          { label: "Counterparty", value: "Redwood Capital" },
          { label: "Open risk", value: "No cap on confidentiality term" },
          { label: "Clause note", value: "Residuals remain broad" },
        ],
        "legal-contract": [
          { label: "Type", value: "Contract" },
          { label: "Name", value: "Redwood NDA" },
          { label: "Counterparty", value: "Redwood Capital" },
          { label: "Venue", value: "Delaware" },
        ],
        "legal-clause": [
          { label: "Type", value: "Clause" },
          { label: "Clause", value: "Residuals" },
          { label: "State", value: "Broad language still present" },
          {
            label: "Why it matters",
            value: "Could weaken confidentiality protections",
          },
        ],
        "legal-risk": [
          { label: "Type", value: "Risk" },
          { label: "Risk", value: "Unlimited confidentiality term" },
          { label: "Severity", value: "Needs counsel review" },
          { label: "Source", value: "Current NDA draft" },
        ],
        "legal-counterparty": [
          { label: "Type", value: "Counterparty" },
          { label: "Name", value: "Redwood Capital" },
          { label: "Context", value: "Negotiating NDA" },
          { label: "Known request", value: "Delaware venue" },
        ],
      },
      recordTree: {
        id: "legal-root",
        label: "Record: Redwood NDA review",
        kind: "Model record",
        summary:
          "One contract review note becomes a linked contract record with clause state, counterparty context, and durable legal risk.",
        chips: ["contract memory", "auditable", "reviewable"],
        children: [
          {
            id: "legal-contract",
            label: "Entity: Redwood NDA",
            kind: "Contract",
            summary:
              "Primary contract record used for future reviews, approvals, and negotiation history.",
            chips: ["primary", "agreement"],
          },
          {
            id: "legal-clause",
            label: "Clause: residuals",
            kind: "Clause",
            summary:
              "Clause-level review stays attached to the contract instead of disappearing inside a one-off summary.",
            chips: ["clause", "review"],
          },
          {
            id: "legal-risk",
            label: "Risk: unlimited confidentiality term",
            kind: "Risk",
            summary:
              "Open risk is queryable later when the team asks what still needs counsel approval.",
            chips: ["risk", "open issue"],
          },
          {
            id: "legal-counterparty",
            label: "Counterparty: Redwood Capital",
            kind: "Counterparty",
            summary:
              "Counterparty context helps future drafts and negotiation summaries stay grounded in the same deal thread.",
            chips: ["counterparty", "context"],
          },
        ],
      },
      relations: [
        {
          source: "Redwood NDA",
          sourceType: "Contract",
          label: "contains_clause",
          target: "Residuals clause",
          targetType: "Clause",
          note: "The clause stays attached to the agreement being reviewed.",
        },
        {
          source: "Residuals clause",
          sourceType: "Clause",
          label: "creates_risk",
          target: "Unlimited confidentiality term",
          targetType: "Risk",
          note: "Risk is linked to the language that caused it.",
        },
        {
          source: "Redwood NDA",
          sourceType: "Contract",
          label: "belongs_to_counterparty",
          target: "Redwood Capital",
          targetType: "Counterparty",
          note: "Counterparty context remains queryable across future drafts.",
        },
      ],
    },
    owlettoOrg: g("legal").owlettoOrg,
  },
  engineering: {
    id: "engineering",
    label: "Engineering",
    examplePath: "engineering",
    agent: g("engineering").agent,
    model: g("engineering").model,
    skills: g("engineering").skills,
    memory: {
      id: "incident",
      description:
        "Track incidents, services, deploys, and remediation work in one shared operational memory graph.",
      entitySelections: {
        Incident: "engineering-incident",
        Service: "engineering-service",
        Deploy: "engineering-deploy",
        "Pull request": "engineering-pr",
      },
      howItWorks: buildHowItWorks({
        model: {
          detail:
            "Represent incidents, services, deploys, and pull requests as first-class objects so on-call context survives after the thread scrolls away.",
          chips: ["Incident", "Service", "Deploy", "Pull request"],
        },
        connect: {
          detail:
            "Turn live operational signals into structured incident memory.",
          chips: ["PagerDuty", "GitHub", "Deploy logs", "Custom SDK"],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Let teams bring the tools they already use, while keeping credentials outside the worker.",
          chips: ["OAuth", "Service account", "API keys", "Historical import"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          detail:
            "The same incident memory powers operational agents wherever teams work.",
          chips: ["Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers pull in new alerts, deploy state, and merged fixes so the runtime sees the latest impact and rollback options.",
        },
      }),
      watcher: {
        name: "Incident freshness monitor",
        schedule: "Every 5 minutes",
        prompt:
          "Track checkout-api incident state, deploy rollbacks, and the status of PR #482.",
        extractionSchema:
          "{ incident_state, impacted_regions[], rollback_ready, blocking_prs[] }",
        schemaEvolution:
          "Started with incident_state + deploy_id. After repeated incidents, added rollback_ready and impacted_regions fields.",
      },
      highlights: [
        { label: "Incident", value: "checkout-api degradation" },
        { label: "Service", value: "EU checkout" },
        { label: "Trigger", value: "Deploy 2026.04.13.2" },
        { label: "Blocker", value: "PR #482 must merge before rollback" },
      ],
      nodeHighlights: {
        "engineering-root": [
          { label: "Incident", value: "checkout-api degradation" },
          { label: "Service", value: "EU checkout" },
          { label: "Trigger", value: "Deploy 2026.04.13.2" },
          { label: "Blocked by", value: "PR #482" },
        ],
        "engineering-incident": [
          { label: "Type", value: "Incident" },
          { label: "Status", value: "Active" },
          { label: "Impact", value: "EU checkout traffic degraded" },
          { label: "Started after", value: "Deploy 2026.04.13.2" },
        ],
        "engineering-service": [
          { label: "Type", value: "Service" },
          { label: "Name", value: "checkout-api" },
          { label: "Region", value: "EU" },
          { label: "Customer impact", value: "Checkout latency and failures" },
        ],
        "engineering-deploy": [
          { label: "Type", value: "Deploy" },
          { label: "ID", value: "2026.04.13.2" },
          { label: "State", value: "Suspected trigger" },
          { label: "Action", value: "Rollback under review" },
        ],
        "engineering-pr": [
          { label: "Type", value: "Pull request" },
          { label: "PR", value: "#482" },
          { label: "Role", value: "Rollback prerequisite" },
          { label: "Status", value: "Waiting to merge" },
        ],
      },
      recordTree: {
        id: "engineering-root",
        label: "Record: checkout-api incident",
        kind: "Model record",
        summary:
          "Incident state links the active outage, affected service, triggering deploy, and required remediation work in one graph.",
        chips: ["incident memory", "live context", "operational"],
        children: [
          {
            id: "engineering-incident",
            label: "Entity: checkout-api degradation",
            kind: "Incident",
            summary:
              "The active incident stays queryable across handoffs and status updates.",
            chips: ["incident", "active"],
          },
          {
            id: "engineering-service",
            label: "Service: EU checkout",
            kind: "Service",
            summary:
              "Service impact is preserved separately from the incident narrative.",
            chips: ["service", "impact"],
          },
          {
            id: "engineering-deploy",
            label: "Deploy: 2026.04.13.2",
            kind: "Deploy",
            summary:
              "The triggering rollout remains attached to the incident for future analysis.",
            chips: ["deploy", "trigger"],
          },
          {
            id: "engineering-pr",
            label: "PR: #482",
            kind: "Pull request",
            summary:
              "Remediation work stays linked to the operational event it is blocking.",
            chips: ["code change", "blocker"],
          },
        ],
      },
      relations: [
        {
          source: "checkout-api degradation",
          sourceType: "Incident",
          label: "affects_service",
          target: "EU checkout",
          targetType: "Service",
          note: "Impact stays attached to the service that is degraded.",
        },
        {
          source: "checkout-api degradation",
          sourceType: "Incident",
          label: "triggered_by_deploy",
          target: "Deploy 2026.04.13.2",
          targetType: "Deploy",
          note: "The rollout remains linked to the operational event it caused.",
        },
        {
          source: "checkout-api degradation",
          sourceType: "Incident",
          label: "blocked_by_pr",
          target: "PR #482",
          targetType: "Pull request",
          note: "The required fix remains queryable for future handoffs.",
        },
      ],
    },
    owlettoOrg: g("engineering").owlettoOrg,
  },
  support: {
    id: "support",
    label: "Support",
    examplePath: "support",
    agent: g("support").agent,
    model: g("support").model,
    skills: g("support").skills,
    memory: {
      id: "person",
      description:
        "Remember contacts, preferences, owners, and follow-ups across conversations.",
      entitySelections: {
        Person: "person-entity",
        Organization: "person-org",
        Preference: "person-attribute-preference",
        Task: "person-task",
      },
      howItWorks: buildHowItWorks({
        model: {
          detail:
            "Define the people, organizations, preferences, and follow-ups your agents should recognize across conversations and synced contact data.",
          chips: ["Person", "Organization", "Preference", "Task"],
        },
        connect: {
          detail:
            "Proxy MCP servers and ingest contact context from messaging apps, CRM syncs, email, and custom Connector SDK integrations through one runtime.",
          chips: ["Slack", "CRM sync", "Email", "Custom SDK", "MCP proxy"],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Support OAuth for inbox and calendar context, API keys for internal tools, and imports for historical contacts without exposing credentials to agents.",
          chips: ["OAuth", "API keys", "CSV import", "Manual import"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          detail:
            "The same relationship memory powers support agents wherever teams work.",
          chips: ["Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers monitor new activity and update ownership, preferences, and follow-ups as the relationship changes.",
        },
      }),
      watcher: {
        name: g("support").watcher!.name,
        schedule: "Every 24 hours",
        prompt:
          "Monitor Alex Kim's organization for role changes, new preferences, and overdue follow-ups.",
        extractionSchema:
          "{ status, role_changed, new_preferences[], overdue_tasks[] }",
        schemaEvolution:
          "Started with name + role. After 3 runs, added preference_history and follow_up_urgency as new patterns emerged.",
      },
      highlights: [
        { label: "Primary person", value: "Alex Kim" },
        { label: "Role", value: "Vendor onboarding owner" },
        { label: "Preference", value: "Weekly email summaries" },
        { label: "Follow-up", value: "Send draft by Thursday" },
      ],
      nodeHighlights: {
        "person-root": [
          { label: "Primary person", value: "Alex Kim" },
          { label: "Organization", value: "Acme Health" },
          { label: "Preference", value: "Weekly email summaries" },
          { label: "Follow-up", value: "Send draft by Thursday" },
        ],
        "person-entity": [
          { label: "Type", value: "Person" },
          { label: "Name", value: "Alex Kim" },
          { label: "Role", value: "Vendor onboarding owner" },
          { label: "Works at", value: "Acme Health" },
        ],
        "person-attribute-role": [
          { label: "Field", value: "role" },
          { label: "Type", value: "string" },
          { label: "Value", value: "Vendor onboarding owner" },
          { label: "Source phrase", value: "owns vendor onboarding" },
        ],
        "person-attribute-preference": [
          { label: "Field", value: "communication_preference" },
          { label: "Type", value: "string" },
          { label: "Value", value: "Weekly email summaries" },
          { label: "Applies to", value: "Future follow-ups and reports" },
        ],
        "person-org": [
          { label: "Relationship", value: "works_at" },
          { label: "Source", value: "Alex Kim" },
          { label: "Target", value: "Acme Health" },
          {
            label: "Why it matters",
            value: "Connects contact memory to org context",
          },
        ],
        "person-task": [
          { label: "Type", value: "Task" },
          { label: "Action", value: "Send draft" },
          { label: "Due", value: "Thursday" },
          { label: "Source", value: "Alex Kim follow-up request" },
        ],
      },
      recordTree: {
        id: "person-root",
        label: "Record: Alex Kim memory update",
        kind: "Model record",
        summary:
          "One incoming message produces a primary person node, linked organization, durable preference, and a follow-up task.",
        chips: ["append-only", "reviewed", "workspace-scoped"],
        children: [
          {
            id: "person-entity",
            label: "Entity: Alex Kim",
            kind: "Person",
            summary:
              "Primary contact with role ownership and source-linked facts that can be reused across threads.",
            chips: ["primary", "person", "owner"],
            children: [
              {
                id: "person-attribute-role",
                label: "Attribute: role",
                kind: "Field",
                summary:
                  "Normalized to 'vendor onboarding owner' from natural language 'owns vendor onboarding'.",
                chips: ["normalized", "derived"],
              },
              {
                id: "person-attribute-preference",
                label: "Attribute: communication preference",
                kind: "Field",
                summary:
                  "Stored as a reusable preference so future agents choose the right delivery style automatically.",
                chips: ["durable", "preference"],
              },
            ],
          },
          {
            id: "person-org",
            label: "Relationship: works at Acme Health",
            kind: "Relationship",
            summary:
              "Links the person node to the organization node so both records benefit from the same evidence chain.",
            chips: ["relationship", "organization"],
          },
          {
            id: "person-task",
            label: "Task: send draft by Thursday",
            kind: "Operational memory",
            summary:
              "Follow-up stored with source reference so agents can act on it and explain where it came from.",
            chips: ["actionable", "deadline"],
          },
        ],
      },
      relations: [
        {
          source: "Alex Kim",
          sourceType: "person",
          label: "works_at",
          target: "Acme Health",
          targetType: "organization",
          note: "Organization affiliation extracted directly from the meeting note.",
        },
        {
          source: "Alex Kim",
          sourceType: "person",
          label: "prefers",
          target: "Weekly email summaries",
          targetType: "preference",
          note: "Stored as a durable preference for future agent behavior.",
        },
        {
          source: "Q3 planning call",
          sourceType: "task",
          label: "created_task",
          target: "Send draft by Thursday",
          targetType: "task",
          note: "Operational memory stays attached to the originating event.",
        },
      ],
    },
    owlettoOrg: g("support").owlettoOrg,
  },
  finance: {
    id: "finance",
    label: "Finance",
    examplePath: "finance",
    agent: g("finance").agent,
    model: g("finance").model,
    skills: g("finance").skills,
    memory: {
      id: "variance",
      description:
        "Track accounts and transactions so close workflows can reuse the same structured state.",
      entitySelections: {
        Account: "finance-account",
        Transaction: "finance-transaction",
        Variance: "finance-variance",
        Report: "finance-report",
      },
      howItWorks: buildHowItWorks({
        model: {
          detail:
            "Represent accounts, transactions, variances, and reports as linked objects so close state survives across spreadsheets, dashboards, and chat threads.",
          chips: ["Account", "Transaction", "Variance", "Report"],
        },
        connect: {
          detail:
            "Pull data from accounting systems, payment processors, CSV imports, and close checklists through MCP tools and scheduled syncs.",
          chips: ["ERP", "Stripe", "CSV", "Close checklist"],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Use API keys and service accounts for finance systems while keeping access scoped outside the worker runtime.",
          chips: ["API keys", "Service account", "Manual import"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          detail:
            "The same variance memory powers finance agents wherever teams work.",
          chips: ["Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers keep balances, exception lists, and report status current as new payouts and adjustments arrive.",
        },
      }),
      watcher: {
        name: "Month-end variance tracker",
        schedule: "Every 6 hours",
        prompt:
          "Track Account 4100 variance, refund activity, and month-end deck readiness.",
        extractionSchema:
          "{ variance_amount, likely_causes[], unresolved_items[], report_status }",
        schemaEvolution:
          "Started with variance_amount + report_status. After repeated closes, added likely_causes and unresolved_items.",
      },
      highlights: [
        { label: "Account", value: "4100" },
        { label: "Variance", value: "$42k" },
        { label: "Likely cause", value: "Delayed refunds" },
        {
          label: "Reporting task",
          value: "Month-end deck reconciliation note",
        },
      ],
      nodeHighlights: {
        "finance-root": [
          { label: "Account", value: "4100" },
          { label: "Variance", value: "$42k" },
          { label: "Likely cause", value: "Refund timing" },
          { label: "Report", value: "Month-end deck" },
        ],
        "finance-account": [
          { label: "Type", value: "Account" },
          { label: "Account", value: "4100" },
          { label: "State", value: "Needs reconciliation" },
          { label: "Cycle", value: "March close" },
        ],
        "finance-transaction": [
          { label: "Type", value: "Transaction set" },
          { label: "Source", value: "Stripe payouts" },
          { label: "Signal", value: "Refund timing mismatch" },
          { label: "Period", value: "March" },
        ],
        "finance-variance": [
          { label: "Type", value: "Variance" },
          { label: "Amount", value: "$42k" },
          { label: "Status", value: "Needs explanation" },
          { label: "Cause", value: "Refund timing" },
        ],
        "finance-report": [
          { label: "Type", value: "Report" },
          { label: "Name", value: "Month-end deck" },
          { label: "Needs", value: "Reconciliation note" },
          { label: "Owner", value: "Finance ops" },
        ],
      },
      recordTree: {
        id: "finance-root",
        label: "Record: March close variance",
        kind: "Model record",
        summary:
          "A reconciliation note becomes a reusable finance record with the affected account, variance, transaction context, and reporting destination.",
        chips: ["finance memory", "close workflow", "structured"],
        children: [
          {
            id: "finance-account",
            label: "Account: 4100",
            kind: "Account",
            summary:
              "The account record stores the close state and associated exceptions.",
            chips: ["account", "close"],
          },
          {
            id: "finance-transaction",
            label: "Transactions: Stripe payouts",
            kind: "Transaction",
            summary:
              "Transaction context stays attached to the variance it explains.",
            chips: ["payments", "source"],
          },
          {
            id: "finance-variance",
            label: "Variance: $42k",
            kind: "Variance",
            summary:
              "The anomaly remains queryable later for reporting and follow-up work.",
            chips: ["variance", "exception"],
          },
          {
            id: "finance-report",
            label: "Report: month-end deck",
            kind: "Report",
            summary:
              "Reporting outputs stay connected to the supporting data behind them.",
            chips: ["reporting", "evidence"],
          },
        ],
      },
      relations: [
        {
          source: "Stripe payouts",
          sourceType: "Transaction",
          label: "reconciles_to",
          target: "Account 4100",
          targetType: "Account",
          note: "Transaction evidence stays linked to the account it rolls into.",
        },
        {
          source: "Refund timing mismatch",
          sourceType: "Issue",
          label: "creates_variance",
          target: "$42k variance",
          targetType: "Variance",
          note: "The likely cause stays attached to the anomaly it produced.",
        },
        {
          source: "$42k variance",
          sourceType: "Variance",
          label: "summarized_in",
          target: "Month-end deck",
          targetType: "Report",
          note: "Reporting context remains attached to the finance event it explains.",
        },
      ],
    },
    owlettoOrg: g("finance").owlettoOrg,
  },
  sales: {
    id: "sales",
    label: "Sales",
    examplePath: "sales",
    agent: g("sales").agent,
    model: g("sales").model,
    skills: g("sales").skills,
    memory: {
      id: "company",
      description: "Track accounts, pilots, renewal risk, and buying signals.",
      entitySelections: {
        Organization: "company-entity",
        Region: "company-region",
        Team: "company-team",
        Product: "company-pilot",
        "Renewal risk": "company-risk",
      },
      howItWorks: buildHowItWorks({
        model: {
          detail:
            "Represent accounts as organizations with regions, teams, pilots, and risks instead of flattening everything into CRM notes.",
          chips: ["Organization", "Region", "Team", "Product", "Renewal risk"],
        },
        connect: {
          detail:
            "Ingest CRM updates, product telemetry, support signals, and internal notes through supported connectors, MCP proxying, and custom SDK integrations.",
          chips: [
            "CRM",
            "Product events",
            "Support data",
            "Internal notes",
            "Custom SDK",
          ],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Mix OAuth for SaaS apps, API keys for services, and service accounts for internal pipelines while keeping credentials scoped outside the agent runtime.",
          chips: ["OAuth", "API keys", "Service account", "Scheduled imports"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          detail:
            "The same account memory powers revenue agents wherever teams work.",
          chips: ["Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers turn ongoing account changes into updated risk, expansion, and renewal state without rewriting the whole record by hand.",
        },
      }),
      watcher: {
        name: g("sales").watcher!.name,
        schedule: "Every 12 hours",
        prompt:
          "Poll CRM data for Northstar Foods. Track expansion progress, risk level changes, and renewal timeline.",
        extractionSchema:
          "{ risk_level, expansion_status, renewal_blockers[], activity_delta }",
        schemaEvolution:
          "Started with risk_level + renewal_date. After processing EMEA expansion data, added region_status and pilot_health fields automatically.",
      },
      highlights: [
        { label: "Organization", value: "Northstar Foods" },
        { label: "Expansion", value: "EMEA" },
        { label: "Pilot", value: "Warehouse OS" },
        {
          label: "Commercial signal",
          value: "Pricing concern before October renewal",
        },
      ],
      nodeHighlights: {
        "company-root": [
          { label: "Organization", value: "Northstar Foods" },
          { label: "Expansion", value: "EMEA" },
          { label: "Pilot", value: "Warehouse OS" },
          { label: "Renewal signal", value: "Pricing concern before October" },
        ],
        "company-entity": [
          { label: "Type", value: "Organization" },
          { label: "Name", value: "Northstar Foods" },
          { label: "Expansion region", value: "EMEA" },
          { label: "Owner team", value: "Operations" },
        ],
        "company-region": [
          { label: "Node type", value: "Geography" },
          { label: "Region", value: "EMEA" },
          { label: "Status", value: "Expanded into" },
          { label: "Parent", value: "Northstar Foods" },
        ],
        "company-team": [
          { label: "Node type", value: "Team" },
          { label: "Team", value: "Operations" },
          { label: "Owns", value: "Warehouse OS pilot" },
          { label: "Role", value: "Pilot operator" },
        ],
        "company-pilot": [
          { label: "Type", value: "Product rollout" },
          { label: "Name", value: "Warehouse OS pilot" },
          { label: "Owner", value: "Operations team" },
          { label: "Account", value: "Northstar Foods" },
        ],
        "company-risk": [
          { label: "Type", value: "Renewal risk" },
          { label: "Signal", value: "Pricing concern" },
          { label: "Affects", value: "October renewal" },
          { label: "Severity", value: "Needs follow-up" },
        ],
      },
      recordTree: {
        id: "company-root",
        label: "Record: Northstar Foods update",
        kind: "Model record",
        summary:
          "One sync note expands the company node with geography, internal team structure, product rollout state, and renewal risk.",
        chips: ["org graph", "timelined", "inspectable"],
        children: [
          {
            id: "company-entity",
            label: "Entity: Northstar Foods",
            kind: "Organization",
            summary:
              "The primary organization node accumulates account context instead of scattering it across separate summaries.",
            chips: ["primary", "account"],
            children: [
              {
                id: "company-region",
                label: "Child node: EMEA expansion",
                kind: "Geography",
                summary:
                  "Region expansion modeled as structured company growth metadata, not buried inside free text.",
                chips: ["hierarchy", "region"],
              },
              {
                id: "company-team",
                label: "Child node: Operations team",
                kind: "Team",
                summary:
                  "Internal org structure lets the memory graph represent where pilots and issues actually live.",
                chips: ["team", "owner"],
              },
            ],
          },
          {
            id: "company-pilot",
            label: "Entity: Warehouse OS pilot",
            kind: "Product rollout",
            summary:
              "The pilot is tracked as its own typed object with state, owner, and relationship back to the company account.",
            chips: ["product", "stateful"],
          },
          {
            id: "company-risk",
            label: "Entity: pricing concern",
            kind: "Renewal risk",
            summary:
              "Commercial risk is separated from the raw note so success or sales agents can query it directly later.",
            chips: ["risk", "renewal"],
          },
        ],
      },
      relations: [
        {
          source: "Northstar Foods",
          sourceType: "organization",
          label: "expanded_into",
          target: "EMEA",
          targetType: "region",
          note: "Regional growth becomes part of the organization hierarchy.",
        },
        {
          source: "Operations team",
          sourceType: "team",
          label: "runs",
          target: "Warehouse OS pilot",
          targetType: "product",
          note: "Owning team provides retrieval context for future planning questions.",
        },
        {
          source: "Pricing concern",
          sourceType: "renewal-risk",
          label: "affects",
          target: "October renewal",
          targetType: "renewal",
          note: "Temporal linkage makes the signal useful for upcoming workflows.",
        },
      ],
    },
    owlettoOrg: g("sales").owlettoOrg,
  },
  delivery: {
    id: "delivery",
    label: "Delivery",
    examplePath: "delivery",
    agent: g("delivery").agent,
    model: g("delivery").model,
    skills: g("delivery").skills,
    memory: {
      id: "project",
      description:
        "Keep milestones, blockers, owners, and reporting context in one shared record.",
      entitySelections: {
        Project: "project-node",
        Milestone: "project-phase",
        Stakeholder: "project-owner",
        Blocker: "project-blocker",
        Document: "project-doc",
      },
      howItWorks: buildHowItWorks({
        model: {
          detail:
            "Treat projects as first-class objects with milestones, owners, blockers, artifacts, and recurring reporting expectations.",
          chips: ["Project", "Milestone", "Stakeholder", "Blocker", "Document"],
        },
        connect: {
          detail:
            "Bring project state in from GitHub, Linear, Slack, docs, and internal app events through MCP proxying or custom Connector SDKs.",
          chips: ["GitHub", "Linear", "Slack", "Docs", "Custom SDK"],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Support OAuth for engineering tools, API keys for internal services, and source-specific imports for historical project state and artifacts.",
          chips: ["OAuth", "API keys", "Webhooks", "Manual import"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          detail:
            "The same project memory powers delivery agents wherever teams work.",
          chips: ["Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers turn new blockers, milestone changes, and reporting cadences into updated project memory and ready-to-send summaries.",
        },
      }),
      watcher: {
        name: g("delivery").watcher!.name,
        schedule: "Every Monday at 9 AM",
        prompt:
          "Check Phoenix migration blockers, milestone progress, and generate the weekly risk summary for leadership.",
        extractionSchema:
          "{ blockers_resolved[], milestone_state, new_risks[], risk_summary }",
        schemaEvolution:
          "Started with blocker_status + phase. After the design review brief arrived, added document_references and dependency_chain fields.",
      },
      highlights: [
        { label: "Project", value: "Phoenix migration" },
        { label: "Current phase", value: "Phase two" },
        { label: "Blocker", value: "Infra blocking SSO cutover" },
        { label: "Reporting cadence", value: "Risk update every Monday" },
      ],
      nodeHighlights: {
        "project-root": [
          { label: "Project", value: "Phoenix migration" },
          { label: "Phase", value: "Phase two" },
          { label: "Owner", value: "Maya" },
          { label: "Reporting cadence", value: "Every Monday" },
        ],
        "project-node": [
          { label: "Type", value: "Project" },
          { label: "Name", value: "Phoenix migration" },
          { label: "State", value: "Phase two" },
          { label: "Owner", value: "Maya" },
        ],
        "project-phase": [
          { label: "Type", value: "Milestone" },
          { label: "Name", value: "Phase two" },
          { label: "Lifecycle", value: "In progress" },
          { label: "Parent", value: "Phoenix migration" },
        ],
        "project-blocker": [
          { label: "Type", value: "Dependency" },
          { label: "Blocker", value: "SSO cutover" },
          { label: "Owned by", value: "Infra" },
          { label: "Impact", value: "Blocks rollout progress" },
        ],
        "project-doc": [
          { label: "Type", value: "Reference" },
          { label: "Document", value: "Launch doc" },
          { label: "Contains", value: "Design review" },
          { label: "Linked to", value: "Phoenix migration" },
        ],
        "project-owner": [
          { label: "Type", value: "Person" },
          { label: "Name", value: "Maya" },
          { label: "Role", value: "Project owner" },
          { label: "Owns", value: "Phoenix migration rollout" },
        ],
        "project-cadence": [
          { label: "Type", value: "Preference" },
          { label: "Audience", value: "Leadership" },
          { label: "Update", value: "Risk summary" },
          { label: "Cadence", value: "Every Monday" },
        ],
      },
      recordTree: {
        id: "project-root",
        label: "Record: Phoenix migration state",
        kind: "Model record",
        summary:
          "Project state becomes a hierarchy of phase, owner, blocker, linked doc, and recurring leadership request.",
        chips: ["project memory", "linked artifacts", "actionable"],
        children: [
          {
            id: "project-node",
            label: "Entity: Phoenix migration",
            kind: "Project",
            summary:
              "Composite project node holding lifecycle state, stakeholders, blockers, and references in one place.",
            chips: ["primary", "project"],
            children: [
              {
                id: "project-phase",
                label: "Milestone: phase two",
                kind: "Milestone",
                summary:
                  "Lifecycle state kept as a first-class project milestone rather than a sentence fragment.",
                chips: ["state", "milestone"],
              },
              {
                id: "project-blocker",
                label: "Blocker: SSO cutover",
                kind: "Dependency",
                summary:
                  "Operational blocker linked to the owning infra function so agents can surface it automatically in updates.",
                chips: ["dependency", "risk"],
              },
              {
                id: "project-doc",
                label: "Document: launch doc",
                kind: "Reference",
                summary:
                  "The design review is attached as a document reference instead of disappearing inside an opaque note.",
                chips: ["artifact", "evidence"],
              },
            ],
          },
          {
            id: "project-owner",
            label: "Stakeholder: Maya",
            kind: "Person",
            summary:
              "Project ownership becomes directly queryable for routing follow-ups and status requests.",
            chips: ["owner", "stakeholder"],
          },
          {
            id: "project-cadence",
            label: "Preference: Monday risk update",
            kind: "Preference",
            summary:
              "Leadership reporting expectations are durable memory too, so agents can follow them consistently.",
            chips: ["cadence", "leadership"],
          },
        ],
      },
      relations: [
        {
          source: "Phoenix migration",
          sourceType: "project",
          label: "owned_by",
          target: "Maya",
          targetType: "stakeholder",
          note: "Ownership becomes a stable graph edge instead of a transient note.",
        },
        {
          source: "Phoenix migration",
          sourceType: "project",
          label: "blocked_by",
          target: "SSO cutover dependency",
          targetType: "blocker",
          note: "Operational blockers remain tied to the project for retrieval and updates.",
        },
        {
          source: "Phoenix migration",
          sourceType: "project",
          label: "documented_in",
          target: "Launch doc",
          targetType: "document",
          note: "Source artifacts stay attached to the project record.",
        },
      ],
    },
    owlettoOrg: g("delivery").owlettoOrg,
  },
  leadership: {
    id: "leadership",
    label: "Leadership",
    examplePath: "leadership",
    agent: g("leadership").agent,
    model: g("leadership").model,
    skills: g("leadership").skills,
    memory: {
      id: "document",
      description:
        "Turn decisions, blockers, and assignments from source documents into reusable context.",
      entitySelections: {
        Document: "document-node",
        Decision: "document-decision-approved",
        Region: "document-decision-approved",
        Risk: "document-blocker",
        Task: "document-task",
      },
      howItWorks: buildHowItWorks({
        model: {
          detail:
            "Treat source files as evidence objects, then extract decisions, blockers, regions, and tasks into linked structured memory.",
          chips: ["Document", "Decision", "Region", "Risk", "Task"],
        },
        connect: {
          detail:
            "Ingest uploads, cloud docs, PDFs, browser-backed systems, and custom SDK feeds while routing MCP access through the proxy layer.",
          chips: [
            "File upload",
            "Google Drive",
            "PDFs",
            "Browser auth",
            "Custom SDK",
          ],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Let users authorize Drive and knowledge tools with OAuth, attach API-backed sources, or import documents directly when manual capture makes more sense.",
          chips: ["OAuth", "Browser auth", "API keys", "File upload"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          detail:
            "The same decision memory powers leadership agents wherever teams work.",
          chips: ["Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers keep pending decisions, legal blockers, and assigned tasks current as new board materials and follow-ups arrive.",
        },
      }),
      watcher: {
        name: g("leadership").watcher!.name,
        schedule: "Daily at 8 AM",
        prompt:
          "Track board action items: check Elena's forecast delivery, legal review status, and upcoming board packet deadlines.",
        extractionSchema:
          "{ action_items[], blocked_items[], deadlines_approaching[], completion_status }",
        schemaEvolution:
          "Started with decision_status + owner. After two board cycles, added deadline_proximity and cross-reference fields for linked decisions.",
      },
      highlights: [
        { label: "Approved", value: "LATAM expansion budget" },
        { label: "Pending", value: "Warehouse lease decision" },
        { label: "Blocker", value: "Legal review" },
        { label: "Owner", value: "Elena" },
      ],
      nodeHighlights: {
        "document-root": [
          { label: "Source", value: "Board memo" },
          { label: "Approved", value: "LATAM expansion budget" },
          { label: "Pending", value: "Warehouse lease decision" },
          { label: "Assigned", value: "Elena updates forecast" },
        ],
        "document-node": [
          { label: "Type", value: "Document" },
          { label: "Name", value: "Board memo" },
          { label: "Role", value: "Evidence object" },
          { label: "Used for", value: "Decisions and task extraction" },
        ],
        "document-decision-approved": [
          { label: "Type", value: "Decision" },
          { label: "Status", value: "Approved" },
          { label: "Subject", value: "LATAM expansion budget" },
          { label: "Source", value: "Board memo" },
        ],
        "document-decision-pending": [
          { label: "Type", value: "Pending decision" },
          { label: "Subject", value: "Warehouse lease" },
          { label: "Status", value: "Delayed" },
          { label: "Blocked by", value: "Legal review" },
        ],
        "document-blocker": [
          { label: "Type", value: "Risk" },
          { label: "Blocker", value: "Legal review" },
          { label: "Affects", value: "Warehouse lease decision" },
          { label: "State", value: "Pending resolution" },
        ],
        "document-task": [
          { label: "Type", value: "Task" },
          { label: "Owner", value: "Elena" },
          { label: "Action", value: "Update forecast" },
          { label: "Deadline", value: "Before next week's board packet" },
        ],
      },
      recordTree: {
        id: "document-root",
        label: "Record: Board memo extraction",
        kind: "Model record",
        summary:
          "The source memo remains intact while decisions, blockers, and assignments become linked structured memory.",
        chips: ["document-backed", "auditable", "multi-entity"],
        children: [
          {
            id: "document-node",
            label: "Source: board memo",
            kind: "Document",
            summary:
              "The memo is stored as an evidence object so every extracted fact can point back to a durable source.",
            chips: ["source of truth", "artifact"],
          },
          {
            id: "document-decision-approved",
            label: "Decision: approve LATAM budget",
            kind: "Decision",
            summary:
              "Approved outcomes are structured separately from pending or blocked items, so agents summarize accurately.",
            chips: ["approved", "decision"],
          },
          {
            id: "document-decision-pending",
            label: "Decision: warehouse lease delayed",
            kind: "Pending decision",
            summary:
              "Pending outcomes keep their blocker attached so future updates can explain why they are still unresolved.",
            chips: ["pending", "blocked"],
            children: [
              {
                id: "document-blocker",
                label: "Blocker: legal review",
                kind: "Risk",
                summary:
                  "The legal dependency is preserved as its own object, making it queryable across documents and meetings.",
                chips: ["dependency", "legal"],
              },
            ],
          },
          {
            id: "document-task",
            label: "Task: Elena updates forecast",
            kind: "Task",
            summary:
              "Assignments created by the memo can feed downstream workflows while preserving the board memo source.",
            chips: ["owner", "deliverable"],
          },
        ],
      },
      relations: [
        {
          source: "Board memo",
          sourceType: "document",
          label: "approved",
          target: "LATAM expansion budget",
          targetType: "decision",
          note: "Decision state can be surfaced independently from the full memo text.",
        },
        {
          source: "Warehouse lease decision",
          sourceType: "pending-decision",
          label: "blocked_by",
          target: "Legal review",
          targetType: "risk",
          note: "Blockers keep the pending item contextualized.",
        },
        {
          source: "Elena",
          sourceType: "person",
          label: "assigned",
          target: "Updated forecast",
          targetType: "task",
          note: "Ownership becomes reusable operational memory.",
        },
      ],
    },
    owlettoOrg: g("leadership").owlettoOrg,
  },
  "agent-community": {
    id: "agent-community",
    label: "Agent Community",
    examplePath: "agent-community",
    agent: g("agent-community").agent,
    model: g("agent-community").model,
    skills: g("agent-community").skills,
    memory: {
      id: "member",
      description:
        "Build a private member graph from connected profiles, projects, posts, and stated interests so introductions get better over time.",
      entitySelections: {
        Member: "community-member",
        Company: "community-company",
        Project: "community-project",
        Repository: "community-repo",
        Post: "community-post",
        Topic: "community-topic",
        Match: "community-match",
      },
      howItWorks: buildHowItWorks({
        model: {
          title: "Model the member graph",
          detail:
            "Represent members, companies, projects, repos, posts, topics, and introductions as linked objects so the community can remember who is building what and why they should meet.",
          chips: ["Member", "Project", "Repository", "Post", "Topic", "Match"],
        },
        connect: {
          detail:
            "Ingest GitHub, LinkedIn, newsletters, personal websites, and manual profile forms through MCP proxying, public feeds, and Connector SDK integrations.",
          chips: [
            "GitHub",
            "LinkedIn",
            "Substack",
            "Personal website",
            "Manual profile import",
            "Custom SDK",
          ],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          title: "Let members connect their data",
          detail:
            "Use MCP login and OAuth for connected accounts, support RSS and public-site ingestion for newsletters and blogs, and allow manual profile imports without exposing credentials to agents.",
          chips: [
            "MCP login",
            "OAuth",
            "RSS feeds",
            "Manual profile form",
            "CSV import",
          ],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          title: "Reuse context everywhere",
          detail:
            "The same member graph powers community concierge agents in Slack, internal dashboards, and MCP clients like OpenClaw, ChatGPT, and Claude.",
          chips: ["Slack", "Dashboard", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "A scheduled watcher turns new launches, posts, project updates, and hiring signals into suggestions about which members might care and which warm introductions to draft next.",
        },
      }),
      watcher: {
        name: g("agent-community").watcher!.name,
        schedule: "Every 12 hours",
        prompt:
          "Monitor connected profiles, newsletters, websites, and member updates for new launches, posts, hiring signals, funding news, and project changes. Identify which members are likely to care, explain why, and queue approved intro or outreach drafts.",
        extractionSchema:
          "{ signals:[{ type, source, related_topics[], interested_members[], reason, suggested_action }] }",
        schemaEvolution:
          "Started with profile refresh and topic extraction. After repeated runs, added interested_members and suggested_action so the watcher could recommend who should see a launch, who should meet, and which outreach draft to prepare.",
      },
      highlights: [
        { label: "Member", value: "Sarah Chen" },
        { label: "Company", value: "Relay Labs" },
        { label: "Focus", value: "Agent memory, evals, orchestration" },
        {
          label: "Connected sources",
          value: "GitHub, LinkedIn, Substack, website",
        },
        {
          label: "Intro goal",
          value: "Meet founders and engineers building agent infrastructure",
        },
      ],
      nodeHighlights: {
        "community-root": [
          { label: "Member", value: "Sarah Chen" },
          { label: "Company", value: "Relay Labs" },
          { label: "Topics", value: "Agent memory, evals, orchestration" },
          { label: "Sources", value: "GitHub, LinkedIn, Substack, website" },
        ],
        "community-member": [
          { label: "Type", value: "Member" },
          { label: "Name", value: "Sarah Chen" },
          { label: "Role", value: "Founder" },
          { label: "Company", value: "Relay Labs" },
        ],
        "community-company": [
          { label: "Type", value: "Company" },
          { label: "Name", value: "Relay Labs" },
          { label: "Category", value: "Agent infrastructure" },
          { label: "Stage", value: "Early-stage startup" },
        ],
        "community-project": [
          { label: "Type", value: "Project" },
          { label: "Name", value: "Relay Labs platform" },
          { label: "Focus", value: "Orchestration and long-term memory" },
          { label: "Status", value: "Actively building" },
        ],
        "community-repo": [
          { label: "Type", value: "Repository" },
          { label: "Name", value: "eval-orchestrator" },
          { label: "Activity", value: "Recently updated" },
          { label: "Theme", value: "Agent eval tooling" },
        ],
        "community-post": [
          { label: "Type", value: "Post" },
          { label: "Title", value: "Why agent memory needs structure" },
          { label: "Source", value: "Substack" },
          { label: "Topics", value: "Agent memory, developer workflows" },
        ],
        "community-topic": [
          { label: "Type", value: "Topic" },
          { label: "Name", value: "Agent memory" },
          { label: "Evidence", value: "Newsletter + repos" },
          { label: "Why it matters", value: "High-signal matching input" },
        ],
        "community-match": [
          { label: "Type", value: "Match" },
          { label: "Suggested match", value: "Priya Natarajan" },
          {
            label: "Reason",
            value: "Shared agent infra focus, complementary MCP tooling work",
          },
          { label: "Status", value: "Draft intro pending approval" },
        ],
      },
      recordTree: {
        id: "community-root",
        label: "Record: Sarah Chen member graph",
        kind: "Model record",
        summary:
          "Member record combines connected profiles, projects, topics, and intro goals into a reusable community graph.",
        chips: ["community", "member-graph", "timelined"],
        children: [
          {
            id: "community-member",
            label: "Entity: Sarah Chen",
            kind: "Member",
            summary:
              "Primary member node stores role, company, connected sources, and who this member wants to meet.",
            chips: ["primary", "member"],
          },
          {
            id: "community-company",
            label: "Company: Relay Labs",
            kind: "Company",
            summary:
              "Company node holds current organization context so the community graph stays grounded in what the member is building now.",
            chips: ["company", "context"],
          },
          {
            id: "community-project",
            label: "Project: Relay Labs platform",
            kind: "Project",
            summary:
              "Project node captures the member's active work so matching can use current build context rather than stale bios.",
            chips: ["project", "active"],
          },
          {
            id: "community-repo",
            label: "Repository: eval-orchestrator",
            kind: "Repository",
            summary:
              "Repository activity provides concrete technical evidence for skills, interests, and recency.",
            chips: ["repo", "signal"],
          },
          {
            id: "community-post",
            label: "Post: Why agent memory needs structure",
            kind: "Post",
            summary:
              "Newsletter and blog posts reveal what a member is actively thinking about, making topic extraction and matching more current.",
            chips: ["post", "content"],
          },
          {
            id: "community-match",
            label: "Match: Priya Natarajan",
            kind: "Match",
            summary:
              "Derived match node stores why two members should meet and whether an introduction has been approved or sent.",
            chips: ["derived", "intro"],
          },
        ],
      },
      relations: [
        {
          source: "Sarah Chen",
          sourceType: "member",
          label: "works_at",
          target: "Relay Labs",
          targetType: "company",
          note: "Current company context helps explain what the member is building and who is relevant to meet.",
        },
        {
          source: "Sarah Chen",
          sourceType: "member",
          label: "building_project",
          target: "Relay Labs platform",
          targetType: "project",
          note: "Project relationships make intros grounded in current work instead of static bios.",
        },
        {
          source: "Sarah Chen",
          sourceType: "member",
          label: "maintains_repo",
          target: "eval-orchestrator",
          targetType: "repository",
          note: "Recent code activity acts as high-signal evidence for technical interests and expertise.",
        },
        {
          source: "Sarah Chen",
          sourceType: "member",
          label: "writes_about",
          target: "Why agent memory needs structure",
          targetType: "post",
          note: "Public writing reveals current thinking and makes topic extraction richer than static bios.",
        },
        {
          source: "Sarah Chen",
          sourceType: "member",
          label: "interested_in",
          target: "Agent memory",
          targetType: "topic",
          note: "Explicit interests improve matching and let intro drafts explain the overlap clearly.",
        },
        {
          source: "Sarah Chen",
          sourceType: "member",
          label: "matches_with",
          target: "Priya Natarajan",
          targetType: "member",
          note: "Match relationships preserve why an introduction was suggested and avoid duplicate outreach later.",
        },
      ],
    },
    owlettoOrg: g("agent-community").owlettoOrg,
  },
  "market-intelligence": {
    id: "market-intelligence",
    label: "Market Intelligence",
    examplePath: "market-intelligence",
    agent: g("market-intelligence").agent,
    model: g("market-intelligence").model,
    skills: g("market-intelligence").skills,
    memory: {
      id: "brand",
      description:
        "Track brands, products, and market positioning with source-linked evidence.",
      entitySelections: {
        Brand: "brand-entity",
        Product: "brand-product",
      },
      howItWorks: buildHowItWorks({
        model: {
          title: "Model the market",
          detail:
            "Represent brands and products as first-class objects with positioning, features, and competitive relationships.",
          chips: ["Brand", "Product", "Positioning", "Features"],
        },
        connect: {
          detail:
            "Ingest from Product Hunt, review sites, news sources, and social mentions through supported connectors and MCP proxying.",
          chips: [
            "Product Hunt",
            "Review sites",
            "News feeds",
            "Social mentions",
            "Custom SDK",
          ],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Support OAuth for review platforms, RSS feeds for news, and API keys for private sources while keeping credentials scoped outside the agent runtime.",
          chips: ["OAuth", "RSS feeds", "API keys", "Manual import"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          title: "Reuse context everywhere",
          detail:
            "Market intelligence powers competitive analysis agents in Slack, strategy tools, and MCP clients like OpenClaw, ChatGPT, and Claude.",
          chips: ["Slack", "Strategy tools", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers turn new product launches, feature announcements, and market shifts into updated brand and product memory.",
        },
      }),
      watcher: {
        name: g("market-intelligence").watcher!.name,
        schedule: "Every 6 hours",
        prompt:
          "Monitor Airtable for new features, pricing changes, and competitive positioning against similar tools.",
        extractionSchema:
          "{ new_features[], pricing_changes[], positioning_shifts[], competitive_mentions[] }",
        schemaEvolution:
          "Started with product_features + pricing. After tracking for a month, added integrations and target_audience fields to capture positioning evolution.",
      },
      highlights: [
        { label: "Brand", value: "Airtable" },
        { label: "New feature", value: "Airtable Interfaces" },
        { label: "Enhancement", value: "AI features added" },
        {
          label: "Competitive context",
          value: "Compared to Notion in 3 reviews",
        },
      ],
      nodeHighlights: {
        "brand-root": [
          { label: "Brand", value: "Airtable" },
          { label: "New feature", value: "Airtable Interfaces" },
          { label: "Enhancement", value: "AI features added" },
          { label: "Mentions", value: "Compared to Notion in reviews" },
        ],
        "brand-entity": [
          { label: "Type", value: "Brand" },
          { label: "Name", value: "Airtable" },
          { label: "Category", value: "Spreadsheets and Databases" },
          { label: "Recent activity", value: "New AI features" },
        ],
        "brand-product": [
          { label: "Type", value: "Product" },
          { label: "Name", value: "Airtable Interfaces" },
          { label: "Launch date", value: "Recent" },
          { label: "Brand", value: "Airtable" },
        ],
      },
      recordTree: {
        id: "brand-root",
        label: "Record: Airtable market update",
        kind: "Model record",
        summary:
          "Market scan captures product launches, feature additions, and competitive context for the brand.",
        chips: ["market-intel", "competitive", "timelined"],
        children: [
          {
            id: "brand-entity",
            label: "Entity: Airtable",
            kind: "Brand",
            summary:
              "Primary brand node accumulates product launches, positioning, and competitive intelligence.",
            chips: ["primary", "brand"],
          },
          {
            id: "brand-product",
            label: "Product: Airtable Interfaces",
            kind: "Product",
            summary:
              "New product launch is tracked as its own entity with feature set and market positioning.",
            chips: ["product", "launch"],
          },
        ],
      },
      relations: [
        {
          source: "Reviews",
          sourceType: "content",
          label: "mentions",
          target: "Airtable vs Notion",
          targetType: "comparison",
          note: "Competitive mentions are preserved with source context.",
        },
      ],
    },
    owlettoOrg: g("market-intelligence").owlettoOrg,
  },
  careops: {
    id: "careops",
    label: "Healthcare",
    examplePath: "careops",
    agent: g("careops").agent,
    model: g("careops").model,
    skills: g("careops").skills,
    memory: {
      id: "patient",
      description:
        "Coordinate patient care, track treatment progress, and manage therapist assignments.",
      entitySelections: {
        Patient: "patient-entity",
        Appointment: "patient-appointment",
        Treatment: "patient-treatment",
        Therapist: "patient-therapist",
      },
      howItWorks: buildHowItWorks({
        model: {
          title: "Model patient care",
          detail:
            "Represent patients, appointments, treatments, and therapists as linked entities that capture the full care context.",
          chips: ["Patient", "Appointment", "Treatment", "Therapist"],
        },
        connect: {
          detail:
            "Ingest from EHR systems, calendar feeds, patient portals, and email threads through supported connectors and MCP proxying.",
          chips: ["EHR", "Calendars", "Patient portal", "Email", "Custom SDK"],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Support OAuth for EHR and calendar systems, API keys for practice management tools, and HIPAA-compliant imports for patient data.",
          chips: ["OAuth", "EHR integration", "API keys", "Secure import"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          title: "Reuse context everywhere",
          detail:
            "Patient care context powers coordination agents in practice portals, messaging apps, and MCP clients like OpenClaw, ChatGPT, and Claude.",
          chips: [
            "Practice portals",
            "Messaging",
            "OpenClaw",
            "ChatGPT",
            "Claude",
          ],
        },
        fresh: {
          detail:
            "Watchers turn new appointments, treatment plan updates, and therapist assignments into current patient memory.",
        },
      }),
      watcher: {
        name: g("careops").watcher!.name,
        schedule: "Every morning at 7 AM",
        prompt:
          "Check James McManus for appointment changes, treatment progress, and insurance coverage status.",
        extractionSchema:
          "{ next_appointment, treatment_status, therapist_notes[], insurance_status, upcoming_actions[] }",
        schemaEvolution:
          "Started with appointment + therapist. After two months, added treatment_milestones and insurance_renewal_date to capture care progression.",
      },
      highlights: [
        { label: "Patient", value: "James McManus" },
        { label: "Therapist", value: "Nicole Musto" },
        { label: "Next appointment", value: "Tuesday at 2 PM" },
        { label: "Treatment", value: "Weekly exposure therapy" },
        { label: "Insurance", value: "Blue Cross Blue Shield" },
      ],
      nodeHighlights: {
        "patient-root": [
          { label: "Patient", value: "James McManus" },
          { label: "Therapist", value: "Nicole Musto" },
          { label: "Next appointment", value: "Tuesday at 2 PM" },
          { label: "Insurance", value: "Blue Cross Blue Shield" },
        ],
        "patient-entity": [
          { label: "Type", value: "Patient" },
          { label: "Name", value: "James McManus" },
          { label: "Status", value: "Active treatment" },
          { label: "Therapist", value: "Nicole Musto" },
        ],
        "patient-appointment": [
          { label: "Type", value: "Appointment" },
          { label: "When", value: "Tuesday at 2 PM" },
          { label: "Type", value: "Weekly session" },
          { label: "Patient", value: "James McManus" },
        ],
        "patient-treatment": [
          { label: "Type", value: "Treatment" },
          { label: "Plan", value: "Exposure therapy for OCD" },
          { label: "Frequency", value: "Weekly sessions" },
          { label: "Duration", value: "Ongoing" },
        ],
        "patient-therapist": [
          { label: "Type", value: "Therapist" },
          { label: "Name", value: "Nicole Musto" },
          { label: "Credentials", value: "MS, LPC" },
          { label: "Patient", value: "James McManus" },
        ],
      },
      recordTree: {
        id: "patient-root",
        label: "Record: James McManus care update",
        kind: "Model record",
        summary:
          "Patient care becomes a hierarchy of appointments, treatment plans, therapist assignments, and insurance context.",
        chips: ["patient-care", "hipaa-aware", "actionable"],
        children: [
          {
            id: "patient-entity",
            label: "Entity: James McManus",
            kind: "Patient",
            summary:
              "Primary patient node holds treatment status, therapist assignment, and care coordination context.",
            chips: ["primary", "patient"],
          },
          {
            id: "patient-appointment",
            label: "Appointment: Tuesday session",
            kind: "Appointment",
            summary:
              "Scheduled appointments are tracked with treatment context and preparation notes.",
            chips: ["scheduled", "recurring"],
          },
          {
            id: "patient-treatment",
            label: "Treatment: Exposure therapy plan",
            kind: "Treatment",
            summary:
              "Active treatment plan captures therapy type, frequency, and progress milestones.",
            chips: ["active", "evidence-based"],
          },
        ],
      },
      relations: [
        {
          source: "James McManus",
          sourceType: "patient",
          label: "treats",
          target: "Nicole Musto",
          targetType: "therapist",
          note: "Therapist assignment becomes durable care relationship context.",
        },
        {
          source: "James McManus",
          sourceType: "patient",
          label: "has_appointment",
          target: "Tuesday at 2 PM",
          targetType: "appointment",
          note: "Scheduled appointments are linked to patient and treatment plans.",
        },
        {
          source: "James McManus treatment",
          sourceType: "treatment",
          label: "covered_by",
          target: "Blue Cross Blue Shield",
          targetType: "insurance",
          note: "Insurance coverage is tracked for billing and care authorization.",
        },
      ],
    },
    owlettoOrg: g("careops").owlettoOrg,
  },
  ecommerce: {
    id: "ecommerce",
    label: "Ecommerce",
    examplePath: "ecommerce",
    agent: g("ecommerce").agent,
    model: g("ecommerce").model,
    skills: g("ecommerce").skills,
    memory: {
      id: "customer",
      description:
        "Track customers, subscriptions, order history, and preferences across interactions.",
      entitySelections: {
        Customer: "ecommerce-customer",
        Subscription: "ecommerce-subscription",
        Order: "ecommerce-order",
        Product: "ecommerce-product",
      },
      howItWorks: buildHowItWorks({
        model: {
          title: "Model the store",
          detail:
            "Represent customers, subscriptions, orders, and products as linked entities so every interaction starts with full purchase context.",
          chips: ["Customer", "Subscription", "Order", "Product"],
        },
        connect: {
          detail:
            "Ingest from Shopify, subscription platforms, helpdesk tools, and customer communications through supported connectors and MCP proxying.",
          chips: ["Shopify", "Recharge", "Helpdesk", "Email", "Custom SDK"],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Support OAuth for Shopify and subscription platforms, API keys for helpdesk tools, and imports for customer migration data.",
          chips: ["OAuth", "API keys", "CSV import", "Webhooks"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          detail:
            "The same customer memory powers ecommerce agents wherever teams work.",
          chips: ["Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers turn new orders, subscription changes, and support interactions into updated customer memory.",
        },
      }),
      watcher: {
        name: g("ecommerce").watcher!.name,
        schedule: "Every 6 hours",
        prompt:
          "Monitor Emma Torres for new orders, subscription changes, delivery requests, and support interactions.",
        extractionSchema:
          "{ subscription_status, pending_changes[], recent_orders[], communication_preferences, open_requests[] }",
        schemaEvolution:
          "Started with subscription_status + orders. After repeated interactions, added delivery_preferences and skip_history to capture recurring patterns.",
      },
      highlights: [
        { label: "Customer", value: "Emma Torres" },
        { label: "Subscription", value: "Gold plan (monthly)" },
        { label: "Pending request", value: "Skip next delivery" },
        { label: "Preference", value: "Email for order updates" },
      ],
      nodeHighlights: {
        "ecommerce-root": [
          { label: "Customer", value: "Emma Torres" },
          { label: "Plan", value: "Gold (monthly)" },
          { label: "Request", value: "Skip next delivery" },
          { label: "Preference", value: "Email for order updates" },
        ],
        "ecommerce-customer": [
          { label: "Type", value: "Customer" },
          { label: "Name", value: "Emma Torres" },
          { label: "Status", value: "Active subscriber" },
          { label: "Preference", value: "Email communication" },
        ],
        "ecommerce-subscription": [
          { label: "Type", value: "Subscription" },
          { label: "Plan", value: "Gold" },
          { label: "Frequency", value: "Monthly" },
          { label: "Pending", value: "Skip next delivery" },
        ],
        "ecommerce-order": [
          { label: "Type", value: "Order" },
          { label: "Product", value: "Coffee subscription box" },
          { label: "Status", value: "Next delivery pending skip" },
          { label: "Customer", value: "Emma Torres" },
        ],
        "ecommerce-product": [
          { label: "Type", value: "Product" },
          { label: "Name", value: "Coffee subscription box" },
          { label: "Plan tier", value: "Gold" },
          { label: "Delivery", value: "Monthly" },
        ],
      },
      recordTree: {
        id: "ecommerce-root",
        label: "Record: Emma Torres customer update",
        kind: "Model record",
        summary:
          "Customer record combines subscription state, pending requests, and communication preferences into reusable ecommerce context.",
        chips: ["customer-graph", "subscription", "actionable"],
        children: [
          {
            id: "ecommerce-customer",
            label: "Entity: Emma Torres",
            kind: "Customer",
            summary:
              "Primary customer node holds subscription status, preferences, and interaction history.",
            chips: ["primary", "customer"],
          },
          {
            id: "ecommerce-subscription",
            label: "Subscription: Gold plan",
            kind: "Subscription",
            summary:
              "Active subscription tracks plan tier, billing cycle, and pending changes like skips or upgrades.",
            chips: ["active", "recurring"],
          },
          {
            id: "ecommerce-order",
            label: "Order: next delivery",
            kind: "Order",
            summary:
              "Pending order reflects the skip request and will update when the next cycle processes.",
            chips: ["pending", "delivery"],
          },
          {
            id: "ecommerce-product",
            label: "Product: Coffee subscription box",
            kind: "Product",
            summary:
              "Product node links to the subscription plan and delivery schedule.",
            chips: ["product", "catalog"],
          },
        ],
      },
      relations: [
        {
          source: "Emma Torres",
          sourceType: "customer",
          label: "subscribed_to",
          target: "Gold plan",
          targetType: "subscription",
          note: "Subscription relationship tracks plan, billing, and pending changes.",
        },
        {
          source: "Emma Torres",
          sourceType: "customer",
          label: "placed_order",
          target: "Coffee subscription box",
          targetType: "order",
          note: "Order history stays linked to customer for fulfillment and support context.",
        },
        {
          source: "Emma Torres",
          sourceType: "customer",
          label: "has_preference",
          target: "Email communication",
          targetType: "preference",
          note: "Communication preferences persist across interactions and agents.",
        },
      ],
    },
    owlettoOrg: g("ecommerce").owlettoOrg,
  },
  "venture-capital": {
    id: "venture-capital",
    label: "Venture Capital",
    examplePath: "venture-capital",
    agent: g("venture-capital").agent,
    model: g("venture-capital").model,
    skills: g("venture-capital").skills,
    memory: {
      id: "company",
      description:
        "Track companies, founders, funding rounds, and investment signals with full context.",
      entitySelections: {
        Company: "company-entity",
        Founder: "company-founder",
        "Fund Round": "company-round",
        Sector: "company-sector",
        Investor: "company-investor",
      },
      howItWorks: buildHowItWorks({
        model: {
          title: "Model the venture landscape",
          detail:
            "Represent companies, founders, investors, and funding rounds as linked entities for deal tracking and pattern recognition.",
          chips: ["Company", "Founder", "Investor", "Fund Round", "Sector"],
        },
        connect: {
          detail:
            "Ingest from Crunchbase, LinkedIn, news sources, and internal deal memos through supported connectors and MCP proxying.",
          chips: [
            "Crunchbase",
            "LinkedIn",
            "News feeds",
            "Deal memos",
            "Custom SDK",
          ],
          links: [technicalLinks.mcpProxy, technicalLinks.connectorSdk],
        },
        auth: {
          detail:
            "Support OAuth for data providers, API keys for premium sources, and manual imports for proprietary deal information.",
          chips: ["OAuth", "API keys", "CSV import", "Manual entry"],
          links: [technicalLinks.memoryDocs, technicalLinks.mcpAuthFlow],
        },
        reuse: {
          title: "Reuse context everywhere",
          detail:
            "Investment intelligence powers deal review agents in internal tools, messaging apps, and MCP clients like OpenClaw, ChatGPT, and Claude.",
          chips: ["Deal tools", "Slack", "OpenClaw", "ChatGPT", "Claude"],
        },
        fresh: {
          detail:
            "Watchers turn new funding rounds, portfolio updates, and market signals into current company memory.",
        },
      }),
      watcher: {
        name: g("venture-capital").watcher!.name,
        schedule: "Every 12 hours",
        prompt:
          "Check Lovable for new funding, product launches, team growth, and competitive positioning changes.",
        extractionSchema:
          "{ new_funding[], product_launches[], headcount_change, competitive_moves[], market_expansion[] }",
        schemaEvolution:
          "Started with funding + team_size. After tracking for 3 months, added product_milestones and enterprise_customers to capture growth signals.",
      },
      highlights: [
        { label: "Company", value: "Lovable" },
        { label: "Series B", value: "$653M raised" },
        { label: "Valuation", value: "$6.6B" },
        { label: "Founders", value: "Anton Osika, Fabian Hedin" },
        { label: "Sector", value: "AI Developer Tools" },
        { label: "Lead investor", value: "a16z" },
      ],
      nodeHighlights: {
        "company-root": [
          { label: "Company", value: "Lovable" },
          { label: "Funding", value: "Series B: $653M" },
          { label: "Valuation", value: "$6.6B" },
          { label: "Founders", value: "Anton Osika, Fabian Hedin" },
          { label: "Sector", value: "AI Developer Tools" },
        ],
        "company-entity": [
          { label: "Type", value: "Company" },
          { label: "Name", value: "Lovable" },
          { label: "Stage", value: "Series B" },
          { label: "Valuation", value: "$6.6B" },
          { label: "Sector", value: "AI Developer Tools" },
        ],
        "company-founder": [
          { label: "Type", value: "Founder" },
          { label: "Name", value: "Anton Osika" },
          { label: "Role", value: "CEO & Co-Founder" },
          { label: "Company", value: "Lovable" },
        ],
        "company-round": [
          { label: "Type", value: "Fund Round" },
          { label: "Stage", value: "Series B" },
          { label: "Amount", value: "$653M" },
          { label: "Lead", value: "a16z" },
          { label: "Company", value: "Lovable" },
        ],
        "company-sector": [
          { label: "Sector", value: "AI Developer Tools" },
          { label: "Practice area", value: "AI infrastructure" },
          { label: "Companies", value: "Lovable, Bolt, others" },
        ],
        "company-investor": [
          { label: "Type", value: "Investor" },
          { label: "Name", value: "a16z" },
          { label: "Role", value: "Lead investor" },
          { label: "Company", value: "Lovable" },
        ],
      },
      recordTree: {
        id: "company-root",
        label: "Record: Lovable company update",
        kind: "Model record",
        summary:
          "Company record accumulates funding history, founder information, sector placement, and investor relationships.",
        chips: ["portfolio", "timelined", "comprehensive"],
        children: [
          {
            id: "company-entity",
            label: "Entity: Lovable",
            kind: "Company",
            summary:
              "Primary company node holds stage, valuation, and market position context.",
            chips: ["primary", "company"],
          },
          {
            id: "company-founder",
            label: "Founder: Anton Osika",
            kind: "Founder",
            summary:
              "Founders are tracked with role, background, and other portfolio companies they've founded.",
            chips: ["founder", "team"],
          },
          {
            id: "company-round",
            label: "Fund Round: Series B",
            kind: "Fund Round",
            summary:
              "Funding rounds capture amount, lead investor, and competitive context.",
            chips: ["funding", "growth"],
          },
        ],
      },
      relations: [
        {
          source: "Anton Osika",
          sourceType: "founder",
          label: "founded_by",
          target: "Lovable",
          targetType: "company",
          note: "Founder relationships support pattern recognition across successful founders.",
        },
        {
          source: "Lovable",
          sourceType: "company",
          label: "invested_in",
          target: "a16z",
          targetType: "investor",
          note: "Investment relationships track portfolio companies and syndicate partners.",
        },
        {
          source: "Lovable",
          sourceType: "company",
          label: "in_sector",
          target: "AI Developer Tools",
          targetType: "sector",
          note: "Sector placement enables thesis tracking and competitive landscape analysis.",
        },
      ],
    },
    owlettoOrg: g("venture-capital").owlettoOrg,
  },
} satisfies Record<string, LandingUseCaseDefinition>;

export type LandingUseCaseId = keyof typeof landingUseCases;
