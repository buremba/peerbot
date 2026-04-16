import type { UseCase } from "./types";
import {
  landingUseCases,
  technicalLinks,
  type HowItWorksPanel,
  type LandingUseCaseDefinition,
  type LandingUseCaseId,
  type MemoryEventLog,
  type MemoryExample,
  type SkillWorkspacePreviewData,
} from "./use-case-definitions";

type RuntimeStep = {
  title: string;
  detail: string;
  chips?: string[];
};

type RuntimeJourney = {
  requestLabel: string;
  request: string;
  summary: string;
  steps: RuntimeStep[];
  outcomeLabel: string;
  outcome: string[];
};

type RuntimeJourneyInput = Omit<
  RuntimeJourney,
  "requestLabel" | "outcomeLabel"
>;

type CampaignMeta = {
  title: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  ctaHref: string;
  ctaLabel: string;
};

export type SurfaceId = "landing" | "skills" | "memory";

export type SurfaceHeroCopy = {
  title: string;
  highlight?: string;
  description: string;
  startTitle?: string;
};

type SurfaceHeroCopyConfig = {
  default: SurfaceHeroCopy;
  byUseCase?: Partial<Record<LandingUseCaseId, SurfaceHeroCopy>>;
};

export type ShowcaseSkillWorkspacePreview = SkillWorkspacePreviewData & {
  useCaseId: LandingUseCaseId;
  examplePath: string;
};

export type ShowcaseMemoryExample = MemoryExample & {
  useCaseId: LandingUseCaseId;
  examplePath: string;
};

export type LandingUseCaseChatScenarios = {
  permission: UseCase;
  skill: UseCase;
  settings: UseCase;
};

export type LandingUseCaseShowcase = {
  id: LandingUseCaseId;
  label: string;
  examplePath: string;
  campaign: CampaignMeta;
  runtime: RuntimeJourney;
  skills: ShowcaseSkillWorkspacePreview;
  memory: ShowcaseMemoryExample;
  chatScenarios?: LandingUseCaseChatScenarios;
};

const docsLinks = {
  owlettoDocs: { label: "What is Owletto?", href: "/getting-started/memory/" },
  ...technicalLinks,
};

const memoryStepPanels: Record<
  LandingUseCaseId,
  Partial<Record<"connect" | "auth" | "reuse", HowItWorksPanel>>
> = {
  "market-intelligence": {
    connect: {
      title: "Market intel source inputs",
      description:
        "Brand and product memory comes from monitoring the channels where competitive signals appear.",
      items: [
        {
          meta: "Product Hunt",
          label: "Launch tracking",
          detail:
            "Monitor product launches, feature announcements, and upvotes for competitive positioning signals.",
        },
        {
          meta: "Crunchbase",
          label: "Funding database",
          detail:
            "Pull funding rounds, investor syndicates, and valuation changes for company growth tracking.",
        },
        {
          meta: "Review sites",
          label: "Customer feedback",
          detail:
            "Aggregate reviews and comparisons to understand how products are positioned against alternatives.",
        },
        {
          meta: "News & social",
          label: "Market chatter",
          detail:
            "Track mentions, feature announcements, and strategic moves across news and social channels.",
        },
      ],
    },
    auth: {
      title: "How market data is connected",
      description:
        "Connect product and brand data sources while keeping API keys outside the agent runtime.",
      items: [
        {
          meta: "API key",
          label: "Premium databases",
          detail:
            "Store Crunchbase, PitchBook, or other research platform keys centrally for company and funding data.",
        },
        {
          meta: "RSS feeds",
          label: "News and reviews",
          detail:
            "Pull industry news, blog coverage, and review updates through RSS without per-request auth.",
        },
        {
          meta: "Web scraping",
          label: "Public websites",
          detail:
            "Monitor company blogs, changelogs, and pricing pages for product and positioning updates.",
        },
        {
          meta: "Agent boundary",
          label: "Scoped access",
          detail:
            "The market agent receives extracted insights, not raw credentials or database dumps.",
        },
      ],
    },
    reuse: {
      title: "Market intelligence agents",
      description:
        "The same brand and product memory powers competitive analysis wherever teams work.",
      items: [
        {
          label: "Competitive analysis",
          detail: "Drafts comparison briefs with latest features and pricing.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Deal screen assistant",
          detail:
            "Checks company signals and market position before investment.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
        {
          label: "Product strategist",
          detail: "Reuses positioning insights across go-to-market planning.",
          platform: { id: "claude", label: "Claude" },
        },
      ],
    },
  },
  "agent-community": {
    connect: {
      title: "Community source inputs",
      description:
        "Member context comes from the places people already publish work, identity, and intent.",
      items: [
        {
          meta: "GitHub",
          label: "Code and repo activity",
          detail:
            "Track maintained repositories, contribution patterns, and technical areas of focus from connected GitHub accounts.",
        },
        {
          meta: "LinkedIn",
          label: "Role and company context",
          detail:
            "Pull current title, company, and professional background to keep the member graph aligned with real-world changes.",
        },
        {
          meta: "Newsletter / blog",
          label: "Public writing and interests",
          detail:
            "Use Substack, RSS, and personal blogs to capture what members are actively thinking and writing about.",
        },
        {
          meta: "Profile import",
          label: "Member-provided context",
          detail:
            "Collect explicit goals, interests, and who the member wants to meet through forms or manual imports.",
        },
      ],
    },
    auth: {
      title: "How members connect accounts",
      description:
        "Members connect accounts through MCP auth flows and operators can supplement that with public feeds or imports.",
      items: [
        {
          meta: "MCP login",
          label: "Connected accounts",
          detail:
            "Use MCP/OAuth login for sources like GitHub and LinkedIn without exposing raw credentials to agents.",
        },
        {
          meta: "Public feeds",
          label: "Websites and newsletters",
          detail:
            "Pull RSS, Substack, and public website content directly when a source does not require a private login.",
        },
        {
          meta: "Manual import",
          label: "Profile setup",
          detail:
            "Let members or operators fill in a profile form or upload a structured import for goals, tags, and intro preferences.",
        },
        {
          meta: "Agent boundary",
          label: "Scoped access",
          detail:
            "The community agent works with structured member context and approved workflows, not raw account credentials.",
        },
      ],
    },
    reuse: {
      title: "Community agents and workflows",
      description:
        "The same member graph can power discovery, concierge, and intro workflows wherever the community already operates.",
      items: [
        {
          label: "Community concierge",
          detail: "Answers questions like who should meet this week and why.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Member search agent",
          detail:
            "Finds members by topic, project, or recent activity using the shared graph.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
        {
          label: "Intro drafting workflow",
          detail:
            "Prepares warm intro drafts for Slack or email and waits for approval before sending.",
          platform: { id: "claude", label: "Claude" },
        },
      ],
    },
  },
  ecommerce: {
    connect: {
      title: "Ecommerce source inputs",
      description:
        "Customer and subscription memory comes from the platforms where purchase and support activity happens.",
      items: [
        {
          meta: "Shopify",
          label: "Store and order data",
          detail:
            "Pull customer profiles, order history, and product catalog from the Shopify Admin API.",
        },
        {
          meta: "Subscriptions",
          label: "Recurring billing",
          detail:
            "Sync subscription plans, billing cycles, skips, and cancellations from Recharge or native Shopify subscriptions.",
        },
        {
          meta: "Helpdesk",
          label: "Support interactions",
          detail:
            "Capture customer requests, resolutions, and follow-ups from support channels.",
        },
        {
          meta: "Email & chat",
          label: "Customer communications",
          detail:
            "Track delivery preferences, complaints, and feedback from direct customer messages.",
        },
      ],
    },
    auth: {
      title: "How store data is connected",
      description:
        "Connect ecommerce platforms while keeping API credentials outside the agent runtime.",
      items: [
        {
          meta: "OAuth",
          label: "Shopify and subscriptions",
          detail:
            "Authorize Shopify Admin API and subscription platform access once for customer and order data.",
        },
        {
          meta: "API key",
          label: "Helpdesk and tools",
          detail:
            "Store scoped credentials centrally for support ticketing and communication tools.",
        },
        {
          meta: "Webhooks",
          label: "Real-time events",
          detail:
            "Receive order, subscription, and fulfillment updates as they happen without polling.",
        },
        {
          meta: "Agent boundary",
          label: "Scoped access",
          detail:
            "The ecommerce agent receives customer context, not raw store credentials or payment data.",
        },
      ],
    },
    reuse: {
      title: "Ecommerce agents",
      description:
        "The same customer and subscription memory powers ecommerce agents wherever teams work.",
      items: [
        {
          label: "Subscription manager",
          detail:
            "Handles plan changes, skips, and upgrades with customer context and approval flows.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Order support agent",
          detail:
            "Resolves order inquiries, tracks deliveries, and processes returns.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
        {
          label: "Customer insights assistant",
          detail:
            "Summarizes customer history, preferences, and lifetime value for support and sales.",
          platform: { id: "claude", label: "Claude" },
        },
      ],
    },
  },
  careops: {
    connect: {
      title: "Care operations source inputs",
      description:
        "Patient care memory is built from the systems clinical and operational teams already use.",
      items: [
        {
          meta: "EHR",
          label: "Patient records",
          detail:
            "Pull treatment history, diagnoses, and care plans from the electronic health record system.",
        },
        {
          meta: "Calendar",
          label: "Appointments",
          detail:
            "Sync scheduled sessions, cancellations, and availability from therapist calendars.",
        },
        {
          meta: "Email",
          label: "Patient communications",
          detail:
            "Capture handoff notes, treatment updates, and follow-up commitments from email threads.",
        },
        {
          meta: "Patient portal",
          label: "Self-reported data",
          detail:
            "Import patient-reported outcomes, symptom trackers, and feedback through the patient portal.",
        },
      ],
    },
    auth: {
      title: "How patient data is connected",
      description:
        "Connect clinical systems while maintaining HIPAA compliance and credential isolation.",
      items: [
        {
          meta: "OAuth",
          label: "EHR and calendar",
          detail:
            "Authorize read-only access to patient schedules and treatment history for care coordination.",
        },
        {
          meta: "Service account",
          label: "Internal practice tools",
          detail:
            "Use practice management credentials for scheduling and insurance verification.",
        },
        {
          meta: "Secure import",
          label: "Patient records",
          detail:
            "Load HIPAA-compliant imports for new patients or transferring from other providers.",
        },
        {
          meta: "Isolation",
          label: "Agent boundary",
          detail:
            "The care agent receives context, not raw patient data or PHI directly.",
        },
      ],
    },
    reuse: {
      title: "Care coordination agents",
      description:
        "The same patient care memory powers clinical workflows wherever the team works.",
      items: [
        {
          label: "Care coordinator",
          detail:
            "Checks appointment availability and treatment progress before scheduling.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Handoff assistant",
          detail:
            "Summarizes care status and treatment progress when handing off between therapists.",
          platform: { id: "claude", label: "Claude" },
        },
        {
          label: "Therapist assistant",
          detail:
            "Drafts session notes and treatment plan updates based on patient conversations.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
      ],
    },
  },
  "venture-capital": {
    connect: {
      title: "Venture capital source inputs",
      description:
        "Company and deal memory comes from public databases, proprietary sources, and internal deal memos.",
      items: [
        {
          meta: "Data providers",
          label: "Company databases",
          detail:
            "Pull funding rounds, company descriptions, and team data from Crunchbase, PitchBook, or similar platforms.",
        },
        {
          meta: "Web scraping",
          label: "Company websites",
          detail:
            "Monitor company blogs, engineering blogs, and job postings for growth and product signals.",
        },
        {
          meta: "News API",
          label: "Press and announcements",
          detail:
            "Track funding announcements, leadership changes, and strategic moves from news and press releases.",
        },
        {
          meta: "Internal",
          label: "Deal memos and notes",
          detail:
            "Import investment committee memos, sourcing notes, and partnership discussions for private context.",
        },
      ],
    },
    auth: {
      title: "How deal data is connected",
      description:
        "Connect data providers and internal tools while keeping credentials isolated from workers.",
      items: [
        {
          meta: "API key",
          label: "Premium databases",
          detail:
            "Store Crunchbase API keys or PitchBook credentials centrally for company and funding data.",
        },
        {
          meta: "RSS",
          label: "Company news feeds",
          detail:
            "Pull company blog RSS feeds, tech press, and announcement lists without per-request auth.",
        },
        {
          meta: "Web auth",
          label: "Private portals",
          detail:
            "Authorize access to investor portals or private company databases for portfolio monitoring.",
        },
        {
          meta: "Agent boundary",
          label: "Credential isolation",
          detail:
            "The VC agent receives extracted company insights, not raw database access.",
        },
      ],
    },
    reuse: {
      title: "Venture capital agents",
      description:
        "The same company and deal memory powers investment workflows across the firm.",
      items: [
        {
          label: "Deal screener",
          detail:
            "Checks company signals, funding history, and team background before first calls.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Portfolio monitor",
          detail:
            "Tracks portfolio company growth, competitive moves, and follow-on opportunities.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
        {
          label: "IC assistant",
          detail:
            "Prep investment committee memos with company context and market analysis.",
          platform: { id: "claude", label: "Claude" },
        },
      ],
    },
  },
  legal: {
    connect: {
      title: "Legal source inputs",
      description:
        "The contract graph is built from the systems and artifacts legal teams already use.",
      items: [
        {
          meta: "Upload",
          label: "Draft agreement",
          detail:
            "Capture the latest NDA, redlines, or negotiated fallback language directly from a file upload.",
        },
        {
          meta: "Sync",
          label: "Shared legal drive",
          detail:
            "Pull prior templates, playbooks, and approved fallback clauses from the team document workspace.",
        },
        {
          meta: "MCP",
          label: "Research tools",
          detail:
            "Bring in legal research or internal clause libraries through MCP-backed integrations.",
        },
        {
          meta: "Pipeline",
          label: "Clause extraction",
          detail:
            "Feed parser output into structured entities so venue, residuals, and term risk stay queryable.",
        },
      ],
    },
    auth: {
      title: "How access is handled",
      description:
        "Operators connect the data source once, and workers only receive the approved memory/tool surface.",
      items: [
        {
          meta: "OAuth",
          label: "Drive and document systems",
          detail:
            "Counsel can connect shared docs without exposing tokens to the review agent.",
        },
        {
          meta: "Credential",
          label: "Research providers",
          detail:
            "API-backed legal tools stay behind the gateway proxy with centrally managed secrets.",
        },
        {
          meta: "Manual",
          label: "Negotiated drafts",
          detail:
            "One-off uploads work even when a contract never lives in a connected SaaS app.",
        },
        {
          meta: "Isolation",
          label: "Runtime boundary",
          detail:
            "The worker sees extracted context and proxy URLs, not raw account credentials.",
        },
      ],
    },
    reuse: {
      title: "Legal agents",
      description:
        "The same contract memory powers legal agents wherever teams work.",
      items: [
        {
          label: "Risk review agent",
          detail:
            "Flags unresolved clauses and approval blockers in active negotiations.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Negotiation assistant",
          detail:
            "Recalls fallback language and prior concessions before the next draft.",
          platform: { id: "claude", label: "Claude" },
        },
        {
          label: "Counterparty brief agent",
          detail:
            "Summarizes prior asks, objections, and open terms for the same external party.",
          platform: { id: "chatgpt", label: "ChatGPT" },
        },
        {
          label: "Draft prep workflow",
          detail:
            "Carries approved edits and unresolved risks into the next review cycle.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
      ],
    },
  },
  devops: {
    connect: {
      title: "Operational events",
      description:
        "Turn live operational signals into structured incident memory.",
      table: {
        columns: ["Entity", "Events", "Sources", "Added context"],
        rows: [
          [
            "Alerts",
            "Triggered, resolved, severity changed",
            "PagerDuty, Datadog",
            "State, urgency, impact",
          ],
          [
            "Code",
            "PRs, fixes, rollbacks",
            "GitHub, GitLab",
            "Change timeline",
          ],
          [
            "Deploys",
            "Started, failed, rolled back",
            "CI/CD, Argo, Kubernetes",
            "Rollout history",
          ],
          [
            "Notes",
            "Updates, handoffs, comments",
            "Slack, incident tools",
            "Decisions and context",
          ],
        ],
      },
    },
    auth: {
      title: "Connected accounts",
      description:
        "Let teams bring the tools they already use, while keeping credentials outside the worker.",
      table: {
        columns: ["Account", "Brought by", "Access", "Used for"],
        rows: [
          ["GitHub / GitLab", "User", "OAuth", "PRs, commits, diffs"],
          [
            "Slack / Linear / Notion",
            "User",
            "OAuth",
            "Notes, tickets, team context",
          ],
          [
            "PagerDuty / Datadog",
            "User or admin",
            "OAuth / token",
            "Alerts and incident state",
          ],
          [
            "AWS / GCP / Kubernetes",
            "Org admin",
            "Service account",
            "Infra and deploy metadata",
          ],
          ["Incident history", "Org", "Import / sync", "Memory bootstrap"],
        ],
      },
    },
    reuse: {
      title: "DevOps agents",
      description:
        "The same incident memory powers operational agents wherever teams work.",
      items: [
        {
          label: "Incident responder",
          detail: "Answers what broke, what changed, and what’s blocked now.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Deploy safety agent",
          detail: "Checks rollback readiness and deploy risk before action.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
        {
          label: "Status update agent",
          detail:
            "Drafts current impact and remediation updates from live state.",
          platform: { id: "chatgpt", label: "ChatGPT" },
        },
        {
          label: "Postmortem assistant",
          detail:
            "Reuses the same timeline for follow-up analysis and action items.",
          platform: { id: "claude", label: "Claude" },
        },
      ],
    },
  },
  support: {
    connect: {
      title: "Support source inputs",
      description:
        "Relationship memory comes from the same channels support teams already work in every day.",
      items: [
        {
          meta: "Inbox",
          label: "Message threads",
          detail:
            "Capture promises, preference changes, and ownership notes directly from conversations.",
        },
        {
          meta: "CRM",
          label: "Account sync",
          detail:
            "Pull company context, owners, and lifecycle state from the customer system of record.",
        },
        {
          meta: "Email",
          label: "Follow-up history",
          detail:
            "Attach promised summaries, deadlines, and replies to the right person record.",
        },
        {
          meta: "Knowledge",
          label: "Internal tools",
          detail:
            "Bring in structured account data or operational notes through MCP and custom integrations.",
        },
      ],
    },
    auth: {
      title: "How customer data is connected",
      description:
        "Support teams can authorize inboxes, CRMs, and imports without handing secrets to the runtime.",
      items: [
        {
          meta: "OAuth",
          label: "Inbox and calendar context",
          detail:
            "Connect communication tools so preferences and follow-ups stay in sync.",
        },
        {
          meta: "API key",
          label: "Internal support systems",
          detail:
            "Store scoped credentials centrally for ticketing or account lookup tools.",
        },
        {
          meta: "Import",
          label: "Historical contacts",
          detail:
            "Load CSV or manual records to seed memory before the next live conversation.",
        },
        {
          meta: "Isolation",
          label: "Agent boundary",
          detail:
            "The support agent receives context, not the raw credentials behind it.",
        },
      ],
    },
    reuse: {
      title: "Support agents",
      description:
        "The same relationship memory powers support agents wherever teams work.",
      items: [
        {
          label: "Support responder",
          detail:
            "Drafts replies that match customer preferences and the latest promises.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Handoff assistant",
          detail:
            "Keeps owners, commitments, and next steps intact when a case moves teams.",
          platform: { id: "claude", label: "Claude" },
        },
        {
          label: "Account context agent",
          detail:
            "Recalls who the contact is, what they own, and what was promised last.",
          platform: { id: "chatgpt", label: "ChatGPT" },
        },
        {
          label: "Follow-up workflow",
          detail:
            "Turns prior asks into durable next actions that future workflows can pick up.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
      ],
    },
  },
  finance: {
    connect: {
      title: "Finance source inputs",
      description:
        "Variance memory stays credible because it is tied back to ledgers, payment systems, and close artifacts.",
      items: [
        {
          meta: "ERP",
          label: "General ledger data",
          detail:
            "Pull account state and period close context from the finance system of record.",
        },
        {
          meta: "Payments",
          label: "Stripe payouts and refunds",
          detail:
            "Bring payout timing and refund behavior into the same variance graph.",
        },
        {
          meta: "Import",
          label: "CSV reconciliations",
          detail:
            "Load one-off analyses and exceptions without losing the source artifact behind them.",
        },
        {
          meta: "Workflow",
          label: "Close checklist",
          detail:
            "Connect reporting milestones and unresolved items to the same operational record.",
        },
      ],
    },
    auth: {
      title: "How finance data is connected",
      description:
        "Sensitive financial access stays scoped and auditable while agents still get the context they need.",
      items: [
        {
          meta: "API key",
          label: "Finance SaaS tools",
          detail:
            "Use centrally managed credentials for accounting and payment providers.",
        },
        {
          meta: "Service account",
          label: "Internal pipelines",
          detail:
            "Attach warehouse or reconciliation jobs without exposing long-lived secrets.",
        },
        {
          meta: "Manual",
          label: "Exception imports",
          detail:
            "Allow operators to load one-off close evidence when automation is not the right path.",
        },
        {
          meta: "Isolation",
          label: "Worker boundary",
          detail:
            "The agent reasons over reconciled state, not raw credentials or unrestricted system access.",
        },
      ],
    },
    reuse: {
      title: "Finance agents",
      description:
        "The same variance memory powers finance agents wherever teams work.",
      items: [
        {
          label: "Variance analyst",
          detail:
            "Explains why an account moved and what still needs reconciliation before close.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Reporting assistant",
          detail:
            "Carries reconciliation context into month-end updates and leadership reporting.",
          platform: { id: "claude", label: "Claude" },
        },
        {
          label: "Exception triage agent",
          detail:
            "Surfaces which refunds, payouts, or adjustments still need owner follow-up.",
          platform: { id: "chatgpt", label: "ChatGPT" },
        },
        {
          label: "Audit prep workflow",
          detail:
            "Keeps explanations attached to the originating systems and imported evidence.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
      ],
    },
  },
  sales: {
    connect: {
      title: "Revenue source inputs",
      description:
        "Account memory is strongest when commercial, product, and support signals land in one graph.",
      items: [
        {
          meta: "CRM",
          label: "Account updates",
          detail:
            "Track account ownership, renewal timing, and opportunity movement from the CRM.",
        },
        {
          meta: "Product",
          label: "Usage and rollout signals",
          detail:
            "Bring expansion health and adoption trends into the renewal story.",
        },
        {
          meta: "Support",
          label: "Risk signals",
          detail:
            "Attach escalations and service friction to the same account record.",
        },
        {
          meta: "Notes",
          label: "Internal call notes",
          detail:
            "Preserve pricing concerns, champion feedback, and next steps from humans in the loop.",
        },
      ],
    },
    auth: {
      title: "How revenue systems are connected",
      description:
        "Sales and ops tools can be authorized safely while memory stays reusable across agents.",
      items: [
        {
          meta: "OAuth",
          label: "CRM and GTM SaaS",
          detail:
            "Connect account systems without injecting raw tokens into the worker.",
        },
        {
          meta: "API key",
          label: "Product and support data",
          detail:
            "Store provider credentials centrally for telemetry or health signals.",
        },
        {
          meta: "Service account",
          label: "Internal pipelines",
          detail:
            "Sync warehouse or scoring outputs into the account graph on a schedule.",
        },
        {
          meta: "Import",
          label: "Historical account state",
          detail:
            "Seed memory from spreadsheets or exports before automations are wired up.",
        },
      ],
    },
    reuse: {
      title: "Revenue agents",
      description:
        "The same account memory powers revenue agents wherever teams work.",
      items: [
        {
          label: "Renewal prep agent",
          detail:
            "Pulls current risks, owners, and blockers before a customer call or QBR.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Forecast brief assistant",
          detail:
            "Generates consistent leadership updates from the same account memory.",
          platform: { id: "claude", label: "Claude" },
        },
        {
          label: "Expansion context agent",
          detail:
            "Recalls which team owns the rollout, where adoption is growing, and what is blocking expansion.",
          platform: { id: "chatgpt", label: "ChatGPT" },
        },
        {
          label: "Next-step workflow",
          detail:
            "Hands the right commercial follow-up to chat agents and planning tools.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
      ],
    },
  },
  delivery: {
    connect: {
      title: "Project source inputs",
      description:
        "Project memory comes from issue trackers, docs, chat, and app events — not from one fragile weekly summary.",
      items: [
        {
          meta: "Tracker",
          label: "GitHub and Linear",
          detail:
            "Pull blockers, milestones, and implementation status from delivery systems.",
        },
        {
          meta: "Chat",
          label: "Slack updates",
          detail:
            "Capture informal status changes and dependency mentions from the team thread.",
        },
        {
          meta: "Docs",
          label: "Launch and planning docs",
          detail:
            "Attach review notes and project artifacts to the same graph as the rollout itself.",
        },
        {
          meta: "Events",
          label: "Internal app signals",
          detail:
            "Ingest app-specific rollout or milestone updates through MCP and SDK integrations.",
        },
      ],
    },
    auth: {
      title: "How project systems are connected",
      description:
        "Delivery tools can stay integrated without turning the worker into a secret holder.",
      items: [
        {
          meta: "OAuth",
          label: "Engineering tools",
          detail:
            "Authorize GitHub, Linear, and docs once, then route requests through the proxy layer.",
        },
        {
          meta: "API key",
          label: "Internal services",
          detail:
            "Use scoped credentials for app-specific rollout metadata and delivery dashboards.",
        },
        {
          meta: "Webhook",
          label: "Historical or event imports",
          detail:
            "Feed older project state and new events into memory without manual copy-paste.",
        },
        {
          meta: "Isolation",
          label: "Agent boundary",
          detail:
            "The planner sees shared context, while auth stays outside the runtime.",
        },
      ],
    },
    reuse: {
      title: "Delivery agents",
      description:
        "The same project memory powers delivery agents wherever teams work.",
      items: [
        {
          label: "Standup agent",
          detail:
            "Answers what is blocked, who owns it, and which milestone is at risk.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Planning assistant",
          detail:
            "Brings prior docs, owners, and dependencies into the next planning session.",
          platform: { id: "claude", label: "Claude" },
        },
        {
          label: "Launch readiness agent",
          detail:
            "Uses one shared memory graph for rollout status, docs, and unresolved risks.",
          platform: { id: "chatgpt", label: "ChatGPT" },
        },
        {
          label: "Stakeholder update workflow",
          detail:
            "Generates Monday risk updates from the same project record leadership already trusts.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
      ],
    },
  },
  leadership: {
    connect: {
      title: "Decision source inputs",
      description:
        "Executive memory should stay tied to source documents and follow-up evidence, not a lossy summary.",
      items: [
        {
          meta: "Upload",
          label: "Board memo and packet files",
          detail:
            "Treat the original document as evidence while extracting decisions and assignments from it.",
        },
        {
          meta: "Drive",
          label: "Cloud document systems",
          detail:
            "Sync docs and presentations from connected workspaces without copying them by hand.",
        },
        {
          meta: "Browser",
          label: "Authenticated knowledge systems",
          detail:
            "Use browser-backed access for tools that do not expose a clean API surface.",
        },
        {
          meta: "SDK",
          label: "Custom internal feeds",
          detail:
            "Attach finance, legal, or operating context through MCP and Connector SDK integrations.",
        },
      ],
    },
    auth: {
      title: "How document access is handled",
      description:
        "Leaders and operators can connect the right document systems while keeping auth outside the worker.",
      items: [
        {
          meta: "OAuth",
          label: "Drive and docs",
          detail:
            "Authorize cloud document providers once for recurring imports and lookups.",
        },
        {
          meta: "Browser auth",
          label: "Knowledge tools",
          detail:
            "Use browser-based sessions when source systems require interactive login.",
        },
        {
          meta: "API key",
          label: "Attached data services",
          detail:
            "Combine document context with internal APIs or external knowledge tools behind the proxy.",
        },
        {
          meta: "Manual",
          label: "Direct uploads",
          detail:
            "Allow operators to capture important memos immediately, even before connectors are set up.",
        },
      ],
    },
    reuse: {
      title: "Leadership agents",
      description:
        "The same decision memory powers leadership agents wherever teams work.",
      items: [
        {
          label: "Decision recall agent",
          detail:
            "Answers what was approved, what is blocked, and which region or budget line it affects.",
          platform: { id: "claude", label: "Claude" },
        },
        {
          label: "Assignment tracker",
          detail:
            "Keeps action items visible across future workflows and follow-ups.",
          platform: { id: "slack", label: "Slack" },
        },
        {
          label: "Document QA assistant",
          detail:
            "Answers from the extracted graph without re-reading every memo in full.",
          platform: { id: "chatgpt", label: "ChatGPT" },
        },
        {
          label: "Board prep workflow",
          detail:
            "Carries pending decisions and blockers into the next briefing cycle.",
          platform: { id: "openclaw", label: "OpenClaw" },
        },
      ],
    },
  },
};

const runtimeContent: Record<LandingUseCaseId, RuntimeJourneyInput> = {
  legal: {
    request:
      "Review Redwood's NDA, flag risk, and tell me what still needs counsel approval.",
    summary:
      "Run a legal review agent in chat, bundle the tools it needs, and keep contract context in shared memory for the next draft.",
    steps: [
      {
        title: "Runtime handles the live task",
        detail:
          "Lobu receives the request in chat, opens the right skill bundle, and runs the review inside a sandboxed worker.",
      },
      {
        title: "Skills bring the right tools",
        detail:
          "The legal skill bundles research access, contract workflows, network policy, and instructions into one installable unit.",
      },
      {
        title: "Memory keeps legal context durable",
        detail:
          "Owletto stores the contract, clause, risk, and counterparty graph so future reviews begin with the same evidence.",
      },
    ],
    outcome: [
      "Clause-level risk summary with citations",
      "Recommended edits and unresolved approval items",
      "Durable contract context for future negotiation turns",
    ],
  },
  devops: {
    request: "What's blocking today's deploy, and can we roll back safely?",
    summary:
      "Combine live operational checks with persistent incident memory so on-call engineers get a useful answer fast.",
    steps: [
      {
        title: "Runtime gathers the live state",
        detail:
          "Lobu checks incidents, PRs, and deploy tools in a sandbox and asks for approval before any risky action.",
        chips: ["PagerDuty", "GitHub", "k8s", "approvals"],
      },
      {
        title: "Skills package the ops workflow",
        detail:
          "The DevOps skill bundles MCP servers, allowed domains, and instructions for triage, rollback, and handoff.",
        chips: ["MCP", "network allowlist", "tool policy"],
      },
      {
        title: "Memory tracks the incident graph",
        detail:
          "Owletto links the current outage to affected services, triggering deploys, and remediation work so context survives handoffs.",
        chips: ["incident memory", "service graph"],
      },
    ],
    outcome: [
      "A current deploy-risk answer with blockers called out",
      "Incident and rollback context shared across the team",
      "Fewer repeated explanations during on-call handoffs",
    ],
  },
  support: {
    request:
      "Draft a response for Alex Kim, note the owner, and remind me about the Thursday follow-up.",
    summary:
      "Use one support workflow to pull account context, draft the next response, and keep relationship memory updated for the next conversation.",
    steps: [
      {
        title: "Runtime responds in the channel the team already uses",
        detail:
          "Lobu receives the support request in chat, runs the agent safely, and can trigger approvals or routing when needed.",
        chips: ["Slack", "WhatsApp", "REST API"],
      },
      {
        title: "Skills connect the operational systems",
        detail:
          "The support bundle can talk to ticketing, knowledge, and escalation tools without leaking credentials to workers.",
        chips: ["Zendesk", "knowledge base", "auth proxy"],
      },
      {
        title: "Memory remembers the relationship",
        detail:
          "Owletto stores the contact, organization, communication preferences, and promised follow-up so the next reply starts from context.",
        chips: ["contact memory", "follow-ups", "preferences"],
      },
    ],
    outcome: [
      "Faster first replies with consistent context",
      "Less re-triage across shifts and escalations",
      "Shared memory for owners, preferences, and next steps",
    ],
  },
  finance: {
    request:
      "Explain the Stripe variance on Account 4100 and prep the month-end note.",
    summary:
      "Let a finance operator agent pull live sources, explain the variance, and store structured reconciliation context for the close.",
    steps: [
      {
        title: "Runtime reads live finance systems safely",
        detail:
          "Lobu runs the reconciliation flow in a sandbox and uses configured tools to inspect payment and accounting sources.",
        chips: ["sandbox", "close workflow", "tool access"],
      },
      {
        title: "Skills bundle accounting integrations",
        detail:
          "The finance skill package carries the MCP servers, domains, and instructions needed for reconciliations and reporting.",
        chips: ["QuickBooks", "Stripe", "CSV tools"],
      },
      {
        title: "Memory keeps variance context durable",
        detail:
          "Owletto saves the account, variance, source transactions, and reporting destination so the next close starts with history.",
        chips: ["variance memory", "reporting context"],
      },
    ],
    outcome: [
      "A structured explanation for the variance",
      "Operator-ready notes for the month-end deck",
      "Shared finance context across reconciliation runs",
    ],
  },
  sales: {
    request:
      "What changed in Northstar before the October renewal, and what should we do next?",
    summary:
      "Combine revenue signals, rollout context, and shared account memory so teams can act before renewal risk grows.",
    steps: [
      {
        title: "Runtime works the live account question",
        detail:
          "Lobu answers from chat, runs the revenue workflow in a sandbox, and can request approval before any external action.",
        chips: ["chat", "sandbox", "approval flow"],
      },
      {
        title: "Skills package the GTM systems",
        detail:
          "The sales bundle can pull CRM, call, and account-health signals through one installable unit.",
        chips: ["Salesforce", "Gong", "HubSpot"],
      },
      {
        title: "Memory tracks the account graph",
        detail:
          "Owletto stores the account, region, pilot, and renewal-risk signals so commercial context compounds over time.",
        chips: ["account memory", "renewal risk"],
      },
    ],
    outcome: [
      "Renewal summaries grounded in account evidence",
      "Expansion and risk signals in one place",
      "Shared context across sales, CS, and leadership",
    ],
  },
  delivery: {
    request:
      "Give me the Monday Phoenix rollout update with blockers, owners, and the next escalation.",
    summary:
      "Use one delivery workflow to inspect live rollout tools, summarize blockers, and keep the project graph fresh.",
    steps: [
      {
        title: "Runtime drives the live status update",
        detail:
          "Lobu runs the delivery assistant in chat, pulls the current state, and keeps execution inside your infrastructure.",
        chips: ["chat", "self-hosted", "sandbox"],
      },
      {
        title: "Skills bundle rollout systems",
        detail:
          "The delivery bundle connects issue tracking, source control, and docs so one install brings the full workflow.",
        chips: ["Linear", "GitHub", "docs"],
      },
      {
        title: "Memory preserves the project graph",
        detail:
          "Owletto stores milestones, blockers, stakeholders, and artifacts so every update starts from current project context.",
        chips: ["project memory", "blockers", "owners"],
      },
    ],
    outcome: [
      "Consistent rollout updates with owners and blockers",
      "Project context that survives across standups and escalations",
      "A reusable project graph for planning and reporting",
    ],
  },
  leadership: {
    request:
      "Summarize this board memo: what was approved, what is blocked, and who owns the next action?",
    summary:
      "Turn executive materials into a workflow where agents can answer live questions and keep decision context durable.",
    steps: [
      {
        title: "Runtime handles the active executive request",
        detail:
          "Lobu processes the memo or chat message in a sandbox, applies the right instructions, and returns an operator-ready summary.",
        chips: ["docs", "chat", "sandbox"],
      },
      {
        title: "Skills package the source systems",
        detail:
          "The leadership bundle can reach board materials, shared docs, and meeting-note tools through one installable workflow.",
        chips: ["Google Drive", "meeting notes", "board packets"],
      },
      {
        title: "Memory keeps decision history reusable",
        detail:
          "Owletto stores decisions, blockers, regions, and assignments so future executive reviews start with the same context.",
        chips: ["decision memory", "assignments", "blockers"],
      },
    ],
    outcome: [
      "Action-oriented board summaries grounded in source material",
      "Durable decision history across review cycles",
      "Clear owners and blockers for follow-up work",
    ],
  },
  "agent-community": {
    request:
      "Who in the community should Sarah meet this week, and draft intro messages for the best two matches.",
    summary:
      "Build a private member graph from connected professional profiles, then use watcher-driven opportunity matching to turn launches, posts, and project updates into warm introductions.",
    steps: [
      {
        title: "Runtime handles member matching safely",
        detail:
          "Lobu runs the community workflow in a sandbox, answers matching questions in chat, and asks for approval before any outreach is sent.",
        chips: ["Slack", "email", "approval flow"],
      },
      {
        title: "Skills package member connectors",
        detail:
          "The community bundle connects GitHub, LinkedIn, newsletters, websites, and manual profile imports through one installable workflow.",
        chips: ["GitHub", "LinkedIn", "Substack", "profile imports"],
      },
      {
        title: "Memory keeps the member graph current",
        detail:
          "Owletto stores members, companies, projects, topics, and match history so new launches, posts, and project updates can trigger relevant intros instead of manual research.",
        chips: ["member graph", "connected profiles", "intro history"],
      },
    ],
    outcome: [
      "Higher-quality member discovery and introductions",
      "Fresh profile context without manual curation",
      "Approved outreach with durable match history",
    ],
  },
  "market-intelligence": {
    request:
      "What's new with Airtable this week, and how do they compare to Notion?",
    summary:
      "Track brands and products across the competitive landscape so teams can reuse market intelligence in every conversation.",
    steps: [
      {
        title: "Runtime gathers market signals",
        detail:
          "Lobu monitors brands, products, and competitive positioning from news, reviews, and social channels in a sandbox.",
        chips: ["Product Hunt", "Crunchbase", "reviews", "social"],
      },
      {
        title: "Skills package market research tools",
        detail:
          "The market intelligence skill bundles content monitors, research databases, and comparison tools through one installable unit.",
        chips: ["web monitoring", "Crunchbase", "comparison"],
      },
      {
        title: "Memory builds the brand graph",
        detail:
          "Owletto stores brands, products, mentions, and positioning so every competitive analysis starts with the same evidence.",
        chips: ["brand memory", "mentions", "positioning"],
      },
    ],
    outcome: [
      "Weekly competitive scans with feature and pricing changes",
      "Durable brand and product memory for pattern recognition",
      "Shared market context across product and strategy teams",
    ],
  },
  ecommerce: {
    request:
      "Switch Emma's subscription from monthly to annual and skip next month's delivery.",
    summary:
      "Automate subscription management and order operations so customers get fast resolution and the team keeps full context.",
    steps: [
      {
        title: "Runtime handles the customer request",
        detail:
          "Lobu receives the request in chat, pulls the customer's subscription and order state, and asks for approval before making changes.",
        chips: ["Slack", "WhatsApp", "approval flow"],
      },
      {
        title: "Skills connect the store systems",
        detail:
          "The ecommerce skill bundles Shopify, subscription management, and customer tools through one installable workflow.",
        chips: ["Shopify", "Recharge", "customer tools"],
      },
      {
        title: "Memory preserves the customer graph",
        detail:
          "Owletto stores customers, subscriptions, orders, and preferences so every interaction starts with full purchase context.",
        chips: ["customer memory", "subscriptions", "preferences"],
      },
    ],
    outcome: [
      "Faster subscription and order changes with approval flows",
      "Customer context that persists across interactions",
      "Shared memory across support, sales, and operations",
    ],
  },
  careops: {
    request:
      "Check James McManus's appointment status and summarize his treatment progress.",
    summary:
      "Coordinate patient care across therapists, appointments, and treatment plans so clinical context is always available.",
    steps: [
      {
        title: "Runtime accesses care systems",
        detail:
          "Lobu checks calendars, EHR systems, and patient portals in a sandbox and can request approval before any sensitive access.",
        chips: ["EHR", "calendars", "patient portals"],
      },
      {
        title: "Skills bundle care coordination tools",
        detail:
          "The careops bundle connects scheduling, treatment tracking, and insurance verification through one installable unit.",
        chips: ["calendar sync", "EHR integration", "insurance"],
      },
      {
        title: "Memory preserves the care graph",
        detail:
          "Owletto stores patients, appointments, treatments, and therapist assignments so care coordination continues across handoffs.",
        chips: ["patient memory", "therapists", "treatments"],
      },
    ],
    outcome: [
      "Current patient status and appointment availability",
      "Treatment progress summaries across sessions",
      "Shared care coordination across clinical staff",
    ],
  },
  "venture-capital": {
    request:
      "What's the latest on Lovable, and what other AI dev tools should we track?",
    summary:
      "Combine portfolio tracking, deal sourcing, and market signals so investment teams can reuse company context.",
    steps: [
      {
        title: "Runtime checks portfolio and pipeline",
        detail:
          "Lobu pulls company data, funding rounds, and market signals from multiple sources in a sandbox.",
        chips: ["Crunchbase", "LinkedIn", "news feeds"],
      },
      {
        title: "Skills package deal flow tools",
        detail:
          "The VC skill bundles company databases, founder tracking, and market monitoring through one installable unit.",
        chips: ["deal tracking", "founder research", "market scans"],
      },
      {
        title: "Memory builds the venture graph",
        detail:
          "Owletto stores companies, founders, investors, and sectors so deal context compounds over time.",
        chips: ["portfolio memory", "deal flow", "network"],
      },
    ],
    outcome: [
      "Company summaries with funding and team history",
      "Portfolio health and competitive signals",
      "Shared context across partners and associates",
    ],
  },
};

function enrichMemory(
  useCaseId: LandingUseCaseId,
  memory: LandingUseCaseDefinition["memory"]
): LandingUseCaseDefinition["memory"] {
  return {
    ...memory,
    howItWorks: memory.howItWorks.map((step) => ({
      ...step,
      links:
        step.id === "model"
          ? [...(step.links ?? []), docsLinks.owlettoDocs]
          : step.id === "reuse"
            ? [
                ...(step.links ?? []),
                docsLinks.slackInstall,
                {
                  label: "Connect from ChatGPT",
                  href: `/connect-from/chatgpt/for/${useCaseId}`,
                },
                {
                  label: "Connect from Claude",
                  href: `/connect-from/claude/for/${useCaseId}`,
                },
                {
                  label: "Install to OpenClaw",
                  href: `/connect-from/openclaw/for/${useCaseId}`,
                },
              ]
            : step.id === "fresh"
              ? [...(step.links ?? []), docsLinks.watcherDocs]
              : step.links,
      panel:
        step.panel ??
        (step.id === "connect" || step.id === "auth" || step.id === "reuse"
          ? memoryStepPanels[useCaseId][step.id]
          : undefined),
    })),
  };
}

function toSkillPreview(
  useCaseId: LandingUseCaseId,
  useCase: LandingUseCaseDefinition
): ShowcaseSkillWorkspacePreview {
  const { skills } = useCase;

  return {
    useCaseId,
    examplePath: useCase.examplePath,
    name: useCase.label,
    description: skills.description,
    agentId: skills.agentId,
    skillId: skills.skillId,
    skills: skills.skills,
    nixPackages: skills.nixPackages,
    allowedDomains: skills.allowedDomains,
    mcpServer: skills.mcpServer,
    providerId: skills.providerId,
    model: skills.model,
    apiKeyEnv: skills.apiKeyEnv,
    identity: useCase.agent.identity,
    soul: useCase.agent.soul,
    user: useCase.agent.user,
    skillInstructions: skills.skillInstructions,
  };
}

function buildMemoryEventLog(
  useCase: LandingUseCaseDefinition
): MemoryEventLog {
  const primaryHighlight = useCase.memory.highlights[0]?.value ?? useCase.label;
  const relation = useCase.memory.relations[0];
  const entityPreview = useCase.model.entities.slice(0, 3).join(", ");

  return {
    title: "Evidence trail",
    description:
      "Each memory update is recorded as a timestamped event so operators can inspect how a prompt became durable system context.",
    columns: ["Time", "Event kind", "Source", "What changed"],
    highlightedRows: [0, 1],
    rows: [
      [
        "10:14:02.100",
        "source_ingested",
        useCase.memory.sourceLabel,
        `Captured source evidence for ${primaryHighlight}`,
      ],
      [
        "10:14:04.850",
        "extraction_completed",
        "memory pipeline",
        `Identified ${entityPreview}`,
      ],
      [
        "10:14:05.120",
        "relation_linked",
        "record builder",
        relation
          ? `${relation.source} ${relation.label} ${relation.target}`
          : `Updated ${useCase.memory.id} record relationships`,
      ],
      [
        "10:14:05.400",
        "watcher_scheduled",
        useCase.memory.watcher.name,
        `Scheduled ${useCase.memory.watcher.schedule.toLowerCase()}`,
      ],
    ],
  };
}

function toMemoryExample(
  useCaseId: LandingUseCaseId,
  useCase: LandingUseCaseDefinition
): ShowcaseMemoryExample {
  const memory = enrichMemory(useCaseId, useCase.memory);

  return {
    useCaseId,
    examplePath: useCase.examplePath,
    id: memory.id,
    tab: useCase.label,
    title: useCase.label,
    description: memory.description,
    sourceLabel: memory.sourceLabel,
    sourceText: memory.sourceText,
    entityTypes: useCase.model.entities,
    entitySelections: memory.entitySelections,
    howItWorks: memory.howItWorks,
    eventLog: memory.eventLog ?? buildMemoryEventLog(useCase),
    highlights: memory.highlights,
    nodeHighlights: memory.nodeHighlights,
    watcher: memory.watcher,
    recordTree: memory.recordTree,
    relations: memory.relations,
  };
}

function toCampaignMeta(
  useCaseId: LandingUseCaseId,
  useCase: LandingUseCaseDefinition,
  runtime: RuntimeJourneyInput
): CampaignMeta {
  return {
    title: `Deploy secure ${useCase.label.toLowerCase()} agents on your infrastructure`,
    description: runtime.summary,
    seoTitle: `${useCase.label} AI agents on your infrastructure - Lobu`,
    seoDescription: runtime.summary,
    ctaHref: `/for/${useCaseId}`,
    ctaLabel: `Open ${useCase.label} page`,
  };
}

const chatScenarioContent: Partial<
  Record<LandingUseCaseId, LandingUseCaseChatScenarios>
> = {
  devops: {
    permission: {
      id: "devops-permission",
      tabLabel: "Permission",
      title: "Pull live incident state",
      description: "Agent asks to reach PagerDuty before querying incidents.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow api.pagerduty.com",
      botName: "DevOps",
      botInitial: "D",
      botColor: "#f97316",
      messages: [
        { role: "user", text: "What's on fire right now?" },
        {
          role: "bot",
          text: "Can't reach api.pagerduty.com — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow api.pagerduty.com", action: "link" }],
        },
        { role: "user", text: "Allow for 1 hour" },
        {
          role: "bot",
          text: "2 open incidents:\n• INC-4821 P1 checkout-api 5xx (12m)\n• INC-4820 P2 redis-cache latency (28m)\n\nBoth started after deploy #3491.",
        },
      ],
    },
    skill: {
      id: "devops-skill",
      tabLabel: "Rollback",
      title: "Safe rollback with approval",
      description:
        "Agent checks deploy state and waits for confirmation before any write.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent runs a safe rollback",
      botName: "DevOps",
      botInitial: "D",
      botColor: "#f97316",
      messages: [
        { role: "user", text: "Roll back checkout-api" },
        {
          role: "bot",
          text: "checkout-api at 2.1% error rate (baseline 0.3%), up since deploy #3491 17min ago.\n\nReady to roll back to #3490. Confirm?",
          buttons: [{ label: "Approve rollback", action: "link" }],
        },
        { role: "user", text: "Approved" },
        {
          role: "bot",
          text: "Rolled back. Error rate dropping — 0.6% and falling. INC-4821 updated. I'll confirm baseline in 5min.",
        },
      ],
    },
    settings: {
      id: "devops-settings",
      tabLabel: "Handoff",
      title: "Structured handoff for the night team",
      description:
        "Agent summarizes incident state from memory so the next engineer has full context.",
      settingsLabel: "Incident memory",
      chatLabel: "Agent generates a handoff brief",
      botName: "DevOps",
      botInitial: "D",
      botColor: "#f97316",
      messages: [
        {
          role: "user",
          text: "Give the night team a handoff for checkout-api",
        },
        {
          role: "bot",
          text: "Handoff brief:\n• Active: INC-4821, P1, checkout-api EU degradation\n• Trigger: deploy 2026.04.13.2 (17:42 UTC)\n• Blocker: PR #482 must merge before rollback is safe\n• Owner: you (reassign before sign-off)",
        },
        {
          role: "user",
          text: "PR #482 just merged. Post the handoff to #incidents",
        },
        {
          role: "bot",
          text: "Posted to #incidents with updated status: rollback unblocked. Incident memory updated — PR #482 marked merged.",
        },
      ],
    },
  },
  support: {
    permission: {
      id: "support-permission",
      tabLabel: "Permission",
      title: "Read ticket history",
      description:
        "Agent asks to reach Zendesk before pulling account context.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow yourco.zendesk.com",
      botName: "Support",
      botInitial: "S",
      botColor: "#8b5cf6",
      messages: [
        { role: "user", text: "Draft a reply for Alex Kim at Redwood" },
        {
          role: "bot",
          text: "Can't reach yourco.zendesk.com — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow yourco.zendesk.com", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "Alex last wrote Tuesday — open ticket #7732 on webhook retries. Draft ready, flagged for your review before I send.",
        },
      ],
    },
    skill: {
      id: "support-skill",
      tabLabel: "Draft",
      title: "Draft a reply with context",
      description:
        "Agent pulls ticket history and drafts a reply before anything is sent.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent drafts a customer reply",
      botName: "Support",
      botInitial: "S",
      botColor: "#8b5cf6",
      messages: [
        { role: "user", text: "Draft a reply for Alex Kim at Redwood" },
        {
          role: "bot",
          text: "Alex has ticket #7732 open — webhook retries, 2 days old. Last promise: fix shipped by Friday.\n\nDraft ready. Want me to attach the release note?",
          buttons: [{ label: "Review draft", action: "link" }],
        },
        { role: "user", text: "Yes, send it" },
        {
          role: "bot",
          text: "Sent with the release note attached. Thursday follow-up reminder set. Ticket status updated to pending-customer.",
        },
      ],
    },
    settings: {
      id: "support-settings",
      tabLabel: "Follow-ups",
      title: "What's due today from memory",
      description:
        "Agent recalls open follow-ups without checking any external system.",
      settingsLabel: "Contact memory",
      chatLabel: "Agent recalls open follow-ups",
      botName: "Support",
      botInitial: "S",
      botColor: "#8b5cf6",
      messages: [
        { role: "user", text: "What follow-ups are due today?" },
        {
          role: "bot",
          text: "3 due today:\n• Alex Kim (Acme Health) — send the vendor onboarding draft by Thursday\n• Marcus Webb (Redwood) — confirm SLA terms by EOD\n• Ji-young Park (Northline) — schedule onboarding call",
        },
        { role: "user", text: "What does Alex prefer for communication?" },
        {
          role: "bot",
          text: "Alex Kim prefers weekly email summaries. Last contact was Tuesday — ticket #7732 on webhook retries. The draft should go by email, not Slack.",
        },
      ],
    },
  },
  legal: {
    permission: {
      id: "legal-permission",
      tabLabel: "Permission",
      title: "Fetch a counterparty's draft",
      description: "Agent asks to reach the counterparty's contract portal.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow contracts.redwood.com",
      botName: "Legal",
      botInitial: "L",
      botColor: "#0ea5e9",
      messages: [
        { role: "user", text: "Review Redwood's latest NDA draft" },
        {
          role: "bot",
          text: "Can't reach contracts.redwood.com — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow contracts.redwood.com", action: "link" }],
        },
        { role: "user", text: "Allow for this session" },
        {
          role: "bot",
          text: "Pulled v4. Two clauses changed since v3:\n• §7 indemnity — narrowed cap, OK\n• §12 IP — new carve-out, needs counsel review",
        },
      ],
    },
    skill: {
      id: "legal-skill",
      tabLabel: "Redline",
      title: "Redline against standard terms",
      description:
        "Agent drafts redlines and flags items that need counsel before anything goes out.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent redlines an MSA",
      botName: "Legal",
      botInitial: "L",
      botColor: "#0ea5e9",
      messages: [
        { role: "user", text: "Redline this MSA against our standard" },
        {
          role: "bot",
          text: "6 redlines across 4 sections. §12 IP and §18 liability cap flagged for counsel — both deviate materially.\n\nNothing goes out until you approve.",
          buttons: [{ label: "Send §12 to counsel", action: "link" }],
        },
        { role: "user", text: "Send §12 to counsel" },
        {
          role: "bot",
          text: "Sent to counsel@yourco.com. Tracking as open — I'll surface the reply when it lands and hold the remaining redlines until cleared.",
        },
      ],
    },
    settings: {
      id: "legal-settings",
      tabLabel: "Recall",
      title: "Recall Redwood's open risks",
      description:
        "Agent pulls what it already knows about Redwood before the next negotiation turn.",
      settingsLabel: "Contract memory",
      chatLabel: "Agent recalls contract context",
      botName: "Legal",
      botInitial: "L",
      botColor: "#0ea5e9",
      messages: [
        {
          role: "user",
          text: "What are the open risks on Redwood before I reply?",
        },
        {
          role: "bot",
          text: "From the Redwood NDA review:\n• Residuals clause — broad language still present\n• Confidentiality term — no cap, needs counsel sign-off\n• Venue — Delaware (their ask, not standard)\n\nAll three are unresolved from v4.",
        },
        { role: "user", text: "Has the confidentiality term come up before?" },
        {
          role: "bot",
          text: "Yes — flagged in v2 and v3. They haven't moved on it. Last note: counsel said any term over 5 years needs sign-off before we accept.",
        },
      ],
    },
  },
  sales: {
    permission: {
      id: "sales-permission",
      tabLabel: "Permission",
      title: "Pull account context",
      description: "Agent asks to reach Salesforce before prepping the call.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow yourco.my.salesforce.com",
      botName: "Sales",
      botInitial: "S",
      botColor: "#10b981",
      messages: [
        { role: "user", text: "Prep me for the Redwood renewal call" },
        {
          role: "bot",
          text: "Can't reach yourco.my.salesforce.com — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow Salesforce", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "Redwood, Enterprise, ARR $180k, renewal in 12 days.\n• 2 open tickets (both resolved this week)\n• Exec sponsor changed — new CFO: Priya R.\n• Last usage dip: -8% in March",
        },
      ],
    },
    skill: {
      id: "sales-skill",
      tabLabel: "Account",
      title: "Renewal risk brief",
      description:
        "Agent surfaces account signals and drafts a renewal brief before the call.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent preps a renewal brief",
      botName: "Sales",
      botInitial: "S",
      botColor: "#10b981",
      messages: [
        { role: "user", text: "Which pilots are at risk?" },
        {
          role: "bot",
          text: "3 at risk:\n• Acme — no exec sponsor named\n• Northwind — usage -40% MoM\n• Globex — procurement stalled 2 weeks",
        },
        { role: "user", text: "Draft a renewal brief for Northwind" },
        {
          role: "bot",
          text: "Brief ready: ARR $180k, renewal in 12d, champion changed (new CFO: Priya R.), usage dip since March. Want me to add the 2 resolved tickets as a positive signal?",
        },
      ],
    },
    settings: {
      id: "sales-settings",
      tabLabel: "History",
      title: "Account context before the call",
      description:
        "Agent recalls what changed at an account so the rep walks in prepared.",
      settingsLabel: "Account memory",
      chatLabel: "Agent recalls account history",
      botName: "Sales",
      botInitial: "S",
      botColor: "#10b981",
      messages: [
        {
          role: "user",
          text: "What changed at Northwind before the October renewal?",
        },
        {
          role: "bot",
          text: "Key changes:\n• Usage dropped -40% MoM from August\n• Exec sponsor changed — new CFO: Priya R. (joined Sept)\n• 2 support tickets opened and resolved\n• Procurement stalled for 2 weeks in September",
        },
        { role: "user", text: "Has Priya been on any calls with us?" },
        {
          role: "bot",
          text: "Not in memory. No logged calls or meetings with Priya R. yet. First intro was the renewal prep note sent last week.",
        },
      ],
    },
  },
  leadership: {
    permission: {
      id: "leadership-permission",
      tabLabel: "Permission",
      title: "Read this week's updates",
      description:
        "Agent asks to reach Notion before summarizing team updates.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow yourco.notion.site",
      botName: "Chief of Staff",
      botInitial: "C",
      botColor: "#ec4899",
      messages: [
        { role: "user", text: "What shipped this week across the org?" },
        {
          role: "bot",
          text: "Can't reach yourco.notion.site — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow Notion", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "This week:\n• Platform — shipped multi-region failover\n• Growth — launched partner portal beta\n• Ops — closed 3 P1 incidents, MTTR down 22%",
        },
      ],
    },
    skill: {
      id: "leadership-skill",
      tabLabel: "Decisions",
      title: "Open decisions and blockers",
      description:
        "Agent surfaces what's unresolved and who owns the next step.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent pulls open decisions",
      botName: "Chief of Staff",
      botInitial: "C",
      botColor: "#ec4899",
      messages: [
        {
          role: "user",
          text: "What decisions are still open from Q1 planning?",
        },
        {
          role: "bot",
          text: "4 open:\n• Hiring plan for Growth (Dara)\n• EU region GTM (Priya)\n• Pricing revamp (blocked on finance)\n• Analytics rebuild (in discovery)",
        },
        { role: "user", text: "What's blocking the pricing revamp?" },
        {
          role: "bot",
          text: "CFO review was scheduled March 28 — postponed, no new date set. Finance sign-off is the only open gate. Want me to draft a nudge to schedule it?",
        },
      ],
    },
    settings: {
      id: "leadership-settings",
      tabLabel: "Open Items",
      title: "What's unresolved from the board cycle",
      description:
        "Agent recalls open decisions and assignments from the last board memo.",
      settingsLabel: "Decision memory",
      chatLabel: "Agent recalls open board items",
      botName: "Chief of Staff",
      botInitial: "C",
      botColor: "#ec4899",
      messages: [
        { role: "user", text: "Which Q1 action items are still open?" },
        {
          role: "bot",
          text: "4 still open:\n• Hiring plan for Growth — owner: Dara, no update since March\n• EU region GTM — owner: Priya, in progress\n• Pricing revamp — blocked on CFO review (postponed)\n• Analytics rebuild — in discovery, no owner named",
        },
        { role: "user", text: "What was approved in the last board memo?" },
        {
          role: "bot",
          text: "From March memo:\n• APAC expansion budget — approved\n• Q2 headcount plan — approved\n• Infra migration timeline — approved with conditions\n\nAll three had owners assigned at the time.",
        },
      ],
    },
  },
  finance: {
    permission: {
      id: "finance-permission",
      tabLabel: "Permission",
      title: "Read ledger data",
      description:
        "Agent asks to reach NetSuite before running a reconciliation.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow yourco.netsuite.com",
      botName: "Finance",
      botInitial: "F",
      botColor: "#0ea5e9",
      messages: [
        { role: "user", text: "Reconcile March Stripe payouts to the GL" },
        {
          role: "bot",
          text: "Can't reach yourco.netsuite.com — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow NetSuite", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "$412,308 in Stripe payouts vs $411,922 in GL. 3 variances:\n• $180 refund booked next-month\n• $206 FX delta on EUR charges\n• Remaining balances tie.",
        },
      ],
    },
    skill: {
      id: "finance-skill",
      tabLabel: "Exceptions",
      title: "Flag AP exceptions for review",
      description:
        "Agent surfaces exceptions and queues them for sign-off before anything posts.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent flags AP exceptions",
      botName: "Finance",
      botInitial: "F",
      botColor: "#0ea5e9",
      messages: [
        {
          role: "user",
          text: "Flag exceptions over $5k in this week's AP run",
        },
        {
          role: "bot",
          text: "7 exceptions: 2 missing POs, 1 duplicate invoice ($12,400 to Acme), 4 awaiting approval.\n\nLargest: $42k to Global Suppliers — no matching PO.",
        },
        { role: "user", text: "Send to Priya for sign-off" },
        {
          role: "bot",
          text: "Sent. Priya has the 7 items with links to source docs. Nothing posts until she approves the $42k line.",
        },
      ],
    },
    settings: {
      id: "finance-settings",
      tabLabel: "Close Status",
      title: "What's still open before close",
      description:
        "Agent recalls outstanding items from the current close run.",
      settingsLabel: "Variance memory",
      chatLabel: "Agent recalls open close items",
      botName: "Finance",
      botInitial: "F",
      botColor: "#0ea5e9",
      messages: [
        { role: "user", text: "What's still unresolved from the March close?" },
        {
          role: "bot",
          text: "2 items still open:\n• $180 refund — booked to April instead of March\n• $206 FX delta on EUR charges — no journal entry yet\n\nAll other variances on Account 4100 are tied.",
        },
        { role: "user", text: "Who owns the FX delta item?" },
        {
          role: "bot",
          text: "Unassigned as of last run. Priya reviewed the AP exceptions but didn't pick this one up. Want me to flag it to her?",
        },
      ],
    },
  },
  delivery: {
    permission: {
      id: "delivery-permission",
      tabLabel: "Permission",
      title: "Pull project status",
      description:
        "Agent asks to reach Jira before assembling a rollout report.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow yourco.atlassian.net",
      botName: "Delivery",
      botInitial: "D",
      botColor: "#14b8a6",
      messages: [
        { role: "user", text: "Status on the Q2 onboarding rollout?" },
        {
          role: "bot",
          text: "Can't reach yourco.atlassian.net — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow Atlassian", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "Q2 onboarding: 58% complete, 2d slip vs plan.\n• Blocked: ONB-318 (design review)\n• At risk: ONB-322 (dep on legal)\n• Next milestone: pilot kickoff May 6.",
        },
      ],
    },
    skill: {
      id: "delivery-skill",
      tabLabel: "Blockers",
      title: "Blockers, owners, and next actions",
      description:
        "Agent pulls who owns what and surfaces anything unassigned.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent surfaces open blockers",
      botName: "Delivery",
      botInitial: "D",
      botColor: "#14b8a6",
      messages: [
        { role: "user", text: "Who owns each open blocker this week?" },
        {
          role: "bot",
          text: "5 open:\n• ONB-318 → Dara (design)\n• API-94 → Luis (backend)\n• SEC-22 → Priya (sec review)\n• ONB-322 → Legal\n• DATA-61 → Unassigned",
        },
        { role: "user", text: "Assign DATA-61 to Marcus" },
        {
          role: "bot",
          text: "DATA-61 assigned to Marcus. He's been notified. Blocker count holds at 5 — if this clears today, Q2 milestone stays on track.",
        },
      ],
    },
    settings: {
      id: "delivery-settings",
      tabLabel: "Escalation",
      title: "What needs escalation today",
      description:
        "Agent surfaces items that are unassigned or at risk of missing the milestone.",
      settingsLabel: "Project memory",
      chatLabel: "Agent surfaces escalation candidates",
      botName: "Delivery",
      botInitial: "D",
      botColor: "#14b8a6",
      messages: [
        { role: "user", text: "What needs to be escalated today on Phoenix?" },
        {
          role: "bot",
          text: "2 items:\n• DATA-61 — unassigned, blocks the May 6 pilot kickoff\n• ONB-322 — waiting on Legal, no update in 4 days\n\nBoth will push the milestone if not resolved today.",
        },
        { role: "user", text: "What's ONB-322 waiting on from Legal?" },
        {
          role: "bot",
          text: "Contract review for the pilot partner. Assigned to the legal team on Apr 8, no response logged since. Last touchpoint was the kickoff doc shared that week.",
        },
      ],
    },
  },
  "agent-community": {
    permission: {
      id: "community-permission",
      tabLabel: "Permission",
      title: "Read member directory",
      description:
        "Agent asks to reach the community platform before matching members.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow yourco.circle.so",
      botName: "Community",
      botInitial: "C",
      botColor: "#8b5cf6",
      messages: [
        { role: "user", text: "Find 5 members working on RAG eval tooling" },
        {
          role: "bot",
          text: "Can't reach yourco.circle.so — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow Circle", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "5 member matches:\n• Maya R. — shipped eval harness in #ml-infra\n• Dev K. — posted benchmark last week\n• Lin C. — asking for RAG ground truth\n• Priya N. — hiring for eval work\n• Sam T. — wrote the eval FAQ.",
        },
      ],
    },
    skill: {
      id: "community-skill",
      tabLabel: "Match",
      title: "Member matching and intro drafts",
      description:
        "Agent matches members by recent activity and drafts intros for your review.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent matches and drafts intros",
      botName: "Community",
      botInitial: "C",
      botColor: "#8b5cf6",
      messages: [
        { role: "user", text: "Who's active in #ai-safety this month?" },
        {
          role: "bot",
          text: "Top 8 active: Priya, Dev, Maya, Lin, Sam, Alex, Rui, Chen. 3 new members joined this week.",
        },
        { role: "user", text: "Draft intros for the 3 new members" },
        {
          role: "bot",
          text: "3 intro drafts ready — each personalized to stated interests and matched to existing members. Send to channel or DMs?",
          buttons: [{ label: "Review drafts", action: "link" }],
        },
      ],
    },
    settings: {
      id: "community-settings",
      tabLabel: "Intro History",
      title: "Which intros led to meetings",
      description:
        "Agent recalls what happened after previous intros from the match history.",
      settingsLabel: "Match memory",
      chatLabel: "Agent recalls intro outcomes",
      botName: "Community",
      botInitial: "C",
      botColor: "#8b5cf6",
      messages: [
        {
          role: "user",
          text: "Which intros I sent last month actually led to meetings?",
        },
        {
          role: "bot",
          text: "3 confirmed meetings from April intros:\n• Maya R. ↔ Dev K. — met Apr 9, started collaborating on eval harness\n• Lin C. ↔ Priya N. — met Apr 14, Priya shared a hiring role\n• Sam T. ↔ Alex W. — meeting scheduled Apr 22",
        },
        { role: "user", text: "Any intros that didn't land?" },
        {
          role: "bot",
          text: "2 no-responses: Rui C. intro to Chen M. (sent Apr 3), and the Substack intro to a new member (sent Apr 11). Both are still within the 2-week follow-up window.",
        },
      ],
    },
  },
  "market-intelligence": {
    permission: {
      id: "market-permission",
      tabLabel: "Permission",
      title: "Fetch competitor signals",
      description:
        "Agent asks to reach Crunchbase before pulling funding data.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow crunchbase.com",
      botName: "Market Intel",
      botInitial: "M",
      botColor: "#eab308",
      messages: [
        { role: "user", text: "Did Acme's competitor raise recently?" },
        {
          role: "bot",
          text: "Can't reach crunchbase.com — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow Crunchbase", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "Yes — Northwind raised $48M Series B two weeks ago (led by Sequoia).\nHead count jumped from 42 → 61 on LinkedIn.\nNew product page: launched April 8.",
        },
      ],
    },
    skill: {
      id: "market-skill",
      tabLabel: "Scan",
      title: "Weekly competitive scan",
      description:
        "Agent surfaces launches, pricing changes, and positioning moves.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent scans the competitive landscape",
      botName: "Market Intel",
      botInitial: "M",
      botColor: "#eab308",
      messages: [
        { role: "user", text: "What launched in our category this week?" },
        {
          role: "bot",
          text: "6 launches: Northwind Cloud (#2 on PH), 2 OSS entrants, 3 feature expansions by incumbents.\n\nNorthwind added SSO at $199/mo — you bundle it at $149/mo.",
        },
        {
          role: "user",
          text: "How does their pricing compare to ours overall?",
        },
        {
          role: "bot",
          text: "Northwind: $49/mo starter vs your $39/mo. Enterprise gap closed on the SSO tier. Their seat limit is stricter — worth flagging in competitive decks.",
        },
      ],
    },
    settings: {
      id: "market-settings",
      tabLabel: "Pricing",
      title: "Competitor pricing changes this quarter",
      description:
        "Agent recalls pricing and positioning moves from the tracked competitor watchlist.",
      settingsLabel: "Brand memory",
      chatLabel: "Agent recalls competitive pricing signals",
      botName: "Market Intel",
      botInitial: "M",
      botColor: "#eab308",
      messages: [
        {
          role: "user",
          text: "Any pricing changes from tracked competitors this quarter?",
        },
        {
          role: "bot",
          text: "3 moves logged:\n• Northwind Cloud — added SSO tier at $199/mo (Apr 8)\n• Acme Tools — dropped starter from $59 to $39 (Mar 22)\n• Notion — removed seat cap on Pro (Feb 28)\n\nNorthwind and Acme are the biggest shifts.",
        },
        {
          role: "user",
          text: "How does Acme's new $39 price compare to ours?",
        },
        {
          role: "bot",
          text: "You're at $39/mo too — now tied on starter price. Acme's $39 includes 5 seats vs your 3. Worth flagging before the next pricing review.",
        },
      ],
    },
  },
  careops: {
    permission: {
      id: "careops-permission",
      tabLabel: "Permission",
      title: "Read the care platform",
      description:
        "Agent asks to reach the care platform before reviewing a patient.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow yourco.healthie.com",
      botName: "CareOps",
      botInitial: "C",
      botColor: "#ec4899",
      messages: [
        { role: "user", text: "Prep a follow-up plan for Jordan Lee" },
        {
          role: "bot",
          text: "Can't reach yourco.healthie.com — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow Healthie", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "Jordan Lee — intake 3 weeks ago, last visit Tuesday.\n• Outstanding: lab results review\n• Next scheduled: May 2\n• Draft follow-up plan queued for your review.",
        },
      ],
    },
    skill: {
      id: "careops-skill",
      tabLabel: "Check-in",
      title: "Overdue check-ins and outreach drafts",
      description:
        "Agent surfaces overdue patients and drafts outreach for your review before sending.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent surfaces overdue check-ins",
      botName: "CareOps",
      botInitial: "C",
      botColor: "#ec4899",
      messages: [
        { role: "user", text: "Which patients are overdue for a check-in?" },
        {
          role: "bot",
          text: "12 overdue, 4 over 60 days.\nTop priorities: Jordan L., Sam C., Priya R., Devon K.",
        },
        { role: "user", text: "Draft outreach for Jordan L." },
        {
          role: "bot",
          text: "Draft ready — friendly follow-up referencing their last session (Apr 2) and next available slot. Pending your review before sending.",
          buttons: [{ label: "Review draft", action: "link" }],
        },
      ],
    },
    settings: {
      id: "careops-settings",
      tabLabel: "Session Notes",
      title: "Recall last session notes before a visit",
      description:
        "Agent pulls what it knows about a patient before the next care interaction.",
      settingsLabel: "Care memory",
      chatLabel: "Agent recalls patient session context",
      botName: "CareOps",
      botInitial: "C",
      botColor: "#ec4899",
      messages: [
        {
          role: "user",
          text: "What were the notes from Jordan's last session?",
        },
        {
          role: "bot",
          text: "Jordan Lee — last session Apr 2:\n• Focus: anxiety management, CBT progress noted\n• Action: lab results review still outstanding\n• Next scheduled: May 2\n• Therapist: Dr. Reyes",
        },
        { role: "user", text: "Any concerns flagged since then?" },
        {
          role: "bot",
          text: "One follow-up flag: Jordan missed the lab results reminder sent Apr 10. No response logged. Suggest reaching out before the May 2 visit.",
        },
      ],
    },
  },
  ecommerce: {
    permission: {
      id: "ecommerce-permission",
      tabLabel: "Permission",
      title: "Pull order data",
      description: "Agent asks to reach Shopify before investigating an order.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow yourco.myshopify.com",
      botName: "Store",
      botInitial: "S",
      botColor: "#22c55e",
      messages: [
        { role: "user", text: "Where's order #10482?" },
        {
          role: "bot",
          text: "Can't reach yourco.myshopify.com — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow Shopify", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: 'Order #10482 shipped Apr 12, delivered Apr 15. Customer opened a "where is it" ticket today — tracking shows delivered to mailroom. Drafted reply with photo proof.',
        },
      ],
    },
    skill: {
      id: "ecommerce-skill",
      tabLabel: "Inventory",
      title: "Low stock and purchase orders",
      description:
        "Agent flags low SKUs and raises a draft PO before anything goes to the supplier.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent flags low stock",
      botName: "Store",
      botInitial: "S",
      botColor: "#22c55e",
      messages: [
        { role: "user", text: "Which SKUs are low in stock?" },
        {
          role: "bot",
          text: "7 below reorder point:\n• SKU-1204 — 2 left\n• SKU-1187 — 4 left\n• 5 more flagged\n\nSKU-1204 has 3 open orders incoming — needs PO today.",
        },
        { role: "user", text: "Raise a PO for SKU-1204" },
        {
          role: "bot",
          text: "Draft PO: 50 units from Global Goods Ltd. ($2,100). Awaiting your approval before it goes to the supplier.",
          buttons: [{ label: "Approve PO", action: "link" }],
        },
      ],
    },
    settings: {
      id: "ecommerce-settings",
      tabLabel: "Customer",
      title: "Recall a customer's full context",
      description:
        "Agent pulls what it knows about a customer before handling their request.",
      settingsLabel: "Customer memory",
      chatLabel: "Agent recalls customer context",
      botName: "Store",
      botInitial: "S",
      botColor: "#22c55e",
      messages: [
        { role: "user", text: "What's Emma's subscription and order history?" },
        {
          role: "bot",
          text: "Emma Davis:\n• Plan: monthly, switching to annual (pending confirmation)\n• Last order: #10482, delivered Apr 15\n• Delivery skip: requested for May\n• Preference: no promotional emails",
        },
        { role: "user", text: "Has she contacted support recently?" },
        {
          role: "bot",
          text: "One ticket this week — 'where is my order' for #10482. Resolved Apr 16 with tracking confirmation. No other open issues.",
        },
      ],
    },
  },
  "venture-capital": {
    permission: {
      id: "vc-permission",
      tabLabel: "Permission",
      title: "Pull deal flow data",
      description:
        "Agent asks to reach Affinity before summarizing the pipeline.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Allow affinity.co",
      botName: "Deal Flow",
      botInitial: "D",
      botColor: "#f43f5e",
      messages: [
        { role: "user", text: "What's in the pipeline this week?" },
        {
          role: "bot",
          text: "Can't reach affinity.co — not in the agent's allowed domains.\n\nGrant access?",
          buttons: [{ label: "Allow Affinity", action: "link" }],
        },
        { role: "user", text: "Allow" },
        {
          role: "bot",
          text: "12 deals moved stages this week:\n• 4 new intros (2 warm, 2 cold)\n• 3 into diligence\n• 2 term sheet drafts\n• 3 passed with rationale logged.",
        },
      ],
    },
    skill: {
      id: "vc-skill",
      tabLabel: "Research",
      title: "Co-investor and network research",
      description:
        "Agent searches the portfolio graph and surfaces relationship context.",
      settingsLabel: "Domains and tool permissions",
      chatLabel: "Agent researches co-investors",
      botName: "Deal Flow",
      botInitial: "D",
      botColor: "#f43f5e",
      messages: [
        {
          role: "user",
          text: "Find co-investors we've backed with in AI infra",
        },
        {
          role: "bot",
          text: "6 repeat co-investors since 2023: Accel, Benchmark, Sequoia, Index, Lux, USV.\nStrongest overlap: Accel (4 shared deals).",
        },
        { role: "user", text: "Who at Accel handles AI infra?" },
        {
          role: "bot",
          text: "Amit Sharma — 4 shared deals including Cortex and Relay. Last intro was 8 months ago via Sarah. Want me to draft a re-intro note?",
        },
      ],
    },
    settings: {
      id: "vc-settings",
      tabLabel: "Portfolio",
      title: "Latest signals on a tracked company",
      description:
        "Agent recalls what it knows about a company from the portfolio and watchlist memory.",
      settingsLabel: "Venture memory",
      chatLabel: "Agent recalls company signals",
      botName: "Deal Flow",
      botInitial: "D",
      botColor: "#f43f5e",
      messages: [
        { role: "user", text: "What's the latest on Lovable?" },
        {
          role: "bot",
          text: "Lovable — AI dev tools, seed stage:\n• Last funding: $2.5M (Jan, undisclosed lead)\n• Team: 8 → 14 in 90 days\n• Product: shipped live preview in March\n• Category signal: 3 competitors entered since Q4",
        },
        { role: "user", text: "Any warm paths into the team?" },
        {
          role: "bot",
          text: "One connection: Amit Sharma (Accel) co-invested in a prior company with the Lovable CEO. Last contact 8 months ago. Want me to draft a re-intro note?",
        },
      ],
    },
  },
};

export const landingUseCaseShowcases: LandingUseCaseShowcase[] = (
  Object.entries(landingUseCases) as Array<
    [LandingUseCaseId, LandingUseCaseDefinition]
  >
).map(([useCaseId, useCase]) => {
  const input = runtimeContent[useCaseId];
  const runtime: RuntimeJourney = {
    ...input,
    requestLabel: "Incoming request",
    outcomeLabel: "What the team gets",
  };

  return {
    id: useCaseId,
    label: useCase.label,
    examplePath: useCase.examplePath,
    campaign: toCampaignMeta(useCaseId, useCase, input),
    runtime,
    skills: toSkillPreview(useCaseId, useCase),
    memory: toMemoryExample(useCaseId, useCase),
    chatScenarios: chatScenarioContent[useCaseId],
  };
});

export const DEFAULT_LANDING_USE_CASE_ID: LandingUseCaseId = "devops";

const surfaceHeroCopy: Record<SurfaceId, SurfaceHeroCopyConfig> = {
  landing: {
    default: {
      title: "Your AI team, running on your infrastructure",
      highlight: "AI team",
      description:
        "Sandboxed persistent agents powered by the OpenClaw harness, long-term memory, and installable skills.",
    },
    byUseCase: {
      legal: {
        title: "Trusted AI agents for contract review",
        highlight: "contract review",
        description:
          "Sandboxed legal agents with durable contract memory, secure tool access, and full control in your infrastructure.",
      },
      devops: {
        title: "AI agents for incident response",
        highlight: "incident response",
        description:
          "Give on-call teams agents that inspect deploys, correlate alerts, and keep incident context across every handoff.",
      },
      support: {
        title: "Support agents with customer memory",
        highlight: "customer memory",
        description:
          "Persistent support agents with customer context, follow-up memory, and safe access to the systems your team already uses.",
      },
      finance: {
        title: "Finance agents for close and reconciliation",
        highlight: "close and reconciliation",
        description:
          "Run finance workflows with agents that preserve account context, track exceptions, and operate safely inside your environment.",
      },
      sales: {
        title: "Revenue agents for every account",
        highlight: "every account",
        description:
          "Track pilots, buying signals, renewal risk, and account history with agents that keep shared deal context over time.",
      },
      delivery: {
        title: "Delivery agents for project execution",
        highlight: "project execution",
        description:
          "Give teams agents that track milestones, blockers, ownership, and reporting context across the full rollout lifecycle.",
      },
      leadership: {
        title: "Leadership agents for decision support",
        highlight: "decision support",
        description:
          "Turn documents, decisions, blockers, and assignments into reusable context for faster executive follow-through.",
      },
      "agent-community": {
        title: "Community agents for member matching",
        highlight: "member matching",
        description:
          "Build agents that understand member identity, interests, relationships, and intent across your community's real activity.",
      },
      "market-intelligence": {
        title: "Market intelligence agents",
        highlight: "Market intelligence",
        description:
          "Track companies, launches, competitors, and market signals with agents that keep research structured and continuously fresh.",
      },
      careops: {
        title: "Care coordination agents",
        highlight: "Care coordination",
        description:
          "Help care teams track people, follow-ups, and operational state with agents that preserve structured context across workflows.",
      },
      ecommerce: {
        title: "Ecommerce agents for customer operations",
        highlight: "customer operations",
        description:
          "Run ecommerce workflows with agents that connect store systems, preserve customer context, and act with current operational state.",
      },
      "venture-capital": {
        title: "Investment agents for deal flow",
        highlight: "deal flow",
        description:
          "Track firms, partners, deals, and diligence signals with agents that keep investment context structured and reusable.",
      },
    },
  },
  skills: {
    default: {
      title: "Build reliable agents with skills",
      highlight: "skills",
      description:
        "A skill isn't a prompt template, it's a full sandboxed computer. All capabilities bundled into one installable unit.",
      startTitle: "Start a new agent in seconds",
    },
    byUseCase: {
      legal: { title: "Skills for secure legal workflows" },
      devops: { title: "Skills for incident response agents" },
      support: { title: "Skills for customer operations agents" },
      finance: { title: "Skills for finance workflows" },
      sales: { title: "Skills for account and pipeline agents" },
      delivery: { title: "Skills for rollout and status workflows" },
      leadership: { title: "Skills for executive workflows" },
      "agent-community": { title: "Skills for community workflows" },
      "market-intelligence": {
        title: "Skills for research and monitoring agents",
      },
      careops: { title: "Skills for care coordination workflows" },
      ecommerce: { title: "Skills for ecommerce workflows" },
      "venture-capital": { title: "Skills for sourcing and diligence agents" },
    },
  },
  memory: {
    default: {
      title: "Build long-term collective memory",
      highlight: "collective memory",
      description:
        "Owletto gives all your agents the same durable graph: connectors, recall, and managed auth without leaking credentials to the runtime.",
      startTitle: "Start Owletto in seconds",
    },
    byUseCase: {
      legal: { title: "Contract memory for legal agents" },
      devops: { title: "Incident memory for ops teams" },
      support: { title: "Shared customer memory for support agents" },
      finance: { title: "Structured finance memory for every close" },
      sales: { title: "Account memory for revenue teams" },
      delivery: { title: "Project memory for delivery teams" },
      leadership: { title: "Decision memory for leadership agents" },
      "agent-community": { title: "Member memory for community agents" },
      "market-intelligence": {
        title: "Shared market memory for research agents",
      },
      careops: { title: "Care memory for coordination agents" },
      ecommerce: { title: "Customer memory for store agents" },
      "venture-capital": { title: "Deal memory for venture teams" },
    },
  },
};

export const landingUseCaseOptions = landingUseCaseShowcases.map((useCase) => ({
  id: useCase.id,
  label: useCase.label,
}));

export function getLandingUseCaseShowcase(
  useCaseId?: string
): LandingUseCaseShowcase {
  return (
    landingUseCaseShowcases.find((useCase) => useCase.id === useCaseId) ??
    landingUseCaseShowcases.find(
      (useCase) => useCase.id === DEFAULT_LANDING_USE_CASE_ID
    ) ??
    landingUseCaseShowcases[0]
  );
}

export function getSurfaceHeroCopy(
  surface: SurfaceId,
  useCaseId?: LandingUseCaseId
): SurfaceHeroCopy {
  const config = surfaceHeroCopy[surface];
  const useCaseCopy = useCaseId ? config.byUseCase?.[useCaseId] : undefined;

  return {
    ...config.default,
    ...useCaseCopy,
  };
}

export const showcaseSkillWorkspacePreviews = landingUseCaseShowcases.map(
  (useCase) => useCase.skills
);

export const showcaseMemoryExamples = landingUseCaseShowcases.map(
  (useCase) => useCase.memory
);

export function getSkillsPrompt(showcase: LandingUseCaseShowcase) {
  const workspace = showcase.skills;

  return `Run \`npx @lobu/cli@latest init\` to set up a new Lobu agent for ${showcase.label}. Create lobu.toml with [agents.${workspace.agentId}] pointing at ./agents/${workspace.agentId}, add IDENTITY.md, SOUL.md, and USER.md under agents/${workspace.agentId}/, and add a shared skill in skills/${workspace.skillId}/SKILL.md with nix packages, a network allowlist, and MCP servers for ${workspace.skills.join(", ")}. Keep tool policy in lobu.toml. Keep the workflow aligned with this request: ${showcase.runtime.request}`;
}

export function getMemoryPrompt(showcase: LandingUseCaseShowcase) {
  const memory = showcase.memory;

  return `Run \`npx owletto@latest init\` to initialize Owletto memory for ${showcase.label}. Model these entities: ${memory.entityTypes.join(", ")}. Use this source text as the first example: "${memory.sourceText}". Keep the extracted memory durable, typed, and linked so the runtime can reuse it across future tasks.`;
}

const OWLETTO_URL = "https://owletto.com";
const OWLETTO_MCP_URL = `${OWLETTO_URL}/mcp`;

export function getOwlettoOrgSlug(useCaseId?: LandingUseCaseId) {
  if (!useCaseId) return undefined;
  const def = landingUseCases[useCaseId];
  return "owlettoOrg" in def ? def.owlettoOrg : undefined;
}

export function getOwlettoUrl(useCaseId?: LandingUseCaseId) {
  const orgSlug = getOwlettoOrgSlug(useCaseId);
  return orgSlug ? `${OWLETTO_URL}/${orgSlug}` : OWLETTO_URL;
}

export function getOwlettoMcpUrl() {
  return OWLETTO_MCP_URL;
}

export function getOwlettoScopedMcpUrl(useCaseId?: LandingUseCaseId) {
  const orgSlug = getOwlettoOrgSlug(useCaseId);
  return orgSlug ? `${OWLETTO_MCP_URL}/${orgSlug}` : OWLETTO_MCP_URL;
}

export function getOwlettoBaseUrl() {
  return OWLETTO_URL;
}

export type LandingUseCaseWorkspaceOption = {
  id: LandingUseCaseId;
  label: string;
  orgSlug?: string;
};

export const landingUseCaseWorkspaceOptions: LandingUseCaseWorkspaceOption[] =
  landingUseCaseShowcases.map((useCase) => ({
    id: useCase.id,
    label: useCase.label,
    orgSlug: getOwlettoOrgSlug(useCase.id),
  }));
