import {
  connectorFromFile,
  defineAgent,
  defineAuthProfile,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  reactionFromFile,
  secret,
  skillFromFile,
} from "@lobu/cli/config";
import type FunnelFormConnector from "./funnel-form.connector.ts";
import type funnelDigestReaction from "./funnel-digest.reaction.ts";
import type inboundTriageReaction from "./inbound-triage.reaction.ts";

const crm = defineAgent({
  id: "crm",
  dir: ".",
  name: "crm",
  description:
    "Maintains Lobu's funnel CRM — leads, pilots, inbound triage, weekly digest",
  skills: [skillFromFile("./skills/crm-ops")],
  providers: [
    {
      id: "z-ai",
      model: "z-ai/glm-4.7",
      key: secret("Z_AI_API_KEY"),
    },
  ],
  network: {
    allowed: [
      "github.com",
      ".github.com",
      "api.github.com",
      ".githubusercontent.com",
      "x.com",
      "api.x.com",
      "twitter.com",
      "news.ycombinator.com",
      "hn.algolia.com",
      "api.producthunt.com",
      "api.z.ai",
      ".z.ai",
      "lobu.ai",
      ".dust.tt",
      ".glean.com",
    ],
  },
});

const lead = defineEntityType({
  key: "lead",
  name: "Lead",
  description:
    "A person who has shown a signal toward Lobu — starred, engaged, asked, or talked to us",
  required: ["name", "source", "stage"],
  properties: {
    name: { type: "string", "x-table-label": "Name", "x-table-column": true },
    company: {
      type: "string",
      "x-table-label": "Company",
      "x-table-column": true,
    },
    stage: {
      type: "string",
      enum: ["signal", "trial", "conversation", "pilot", "customer", "cold"],
      "x-table-label": "Stage",
      "x-table-column": true,
    },
    source: {
      type: "string",
      description:
        'Where they first showed up — "github:stargazer", "x:mention", "github:issue-comment", "demo-form", "intro", etc.',
      "x-table-label": "Source",
      "x-table-column": true,
    },
    github_handle: {
      type: "string",
      "x-table-label": "GitHub",
      "x-table-column": true,
    },
    x_handle: { type: "string", "x-table-label": "X" },
    email: { type: "string", "x-table-label": "Email" },
    last_touch: {
      type: "string",
      description: "ISO date of the most recent interaction",
      "x-table-label": "Last touch",
      "x-table-column": true,
    },
    next_action: {
      type: "string",
      "x-table-label": "Next action",
      "x-table-column": true,
    },
    notes: { type: "string" },
  },
});

const pilot = defineEntityType({
  key: "pilot",
  name: "Pilot",
  description:
    "A paid pilot — a company running Lobu for their team under a time-boxed agreement",
  required: ["company", "status"],
  properties: {
    company: {
      type: "string",
      "x-table-label": "Company",
      "x-table-column": true,
    },
    status: {
      type: "string",
      enum: ["active", "won", "lost", "paused"],
      "x-table-label": "Status",
      "x-table-column": true,
    },
    seats: {
      type: "integer",
      "x-table-label": "Seats",
      "x-table-column": true,
    },
    mrr: {
      type: "string",
      description: 'Monthly recurring revenue for the pilot, e.g. "$750"',
      "x-table-label": "MRR",
      "x-table-column": true,
    },
    start_date: {
      type: "string",
      "x-table-label": "Start",
      "x-table-column": true,
    },
    success_metric: {
      type: "string",
      description: "The one metric agreed up front that defines pilot success",
      "x-table-label": "Success metric",
      "x-table-column": true,
    },
    lead_id: {
      type: "string",
      description: "The lead entity this pilot converted from",
    },
  },
});

const converted_to = defineRelationshipType({
  key: "converted-to",
  name: "Converted To",
  description:
    "Links a lead to the pilot it became, so the path from first signal to paying pilot stays explicit.",
});

const funnel_digestWatcher = defineWatcher({
  agent: crm,
  slug: "funnel-digest",
  name: "Weekly funnel digest",
  schedule: "0 9 * * 1",
  notification: { channel: "both", priority: "high" },
  minCooldownSeconds: 3600,
  tags: ["crm", "weekly"],
  reaction: reactionFromFile<typeof funnelDigestReaction>(
    "./funnel-digest.reaction.ts"
  ),
  prompt:
    'Produce the weekly funnel digest and post it to Slack. Keep it short.\n\n1. The single recommended action for the week, on the first line. Pick the\n   move that does the most to get pilot #1 closer (almost always: follow up\n   with the warmest lead in "conversation", or progress whichever pilot\n   conversation is furthest along).\n2. Funnel snapshot: count of `lead` entities per stage; what moved since the\n   last digest (new leads, stage changes, new/updated `pilot` entities).\n3. Top-of-funnel since last digest: new GitHub stars, X mentions/replies,\n   HN/PH activity.\n4. Stale: any lead in `conversation` with no `lead:interaction` in 7+ days —\n   list them for follow-up.\n5. One gap callout if there is one (e.g. "18 new stars, 0 became leads —\n   is inbound-triage catching the right signal?").\n\nTone: a checklist a busy founder reads in 30 seconds. End on the next action,\nnot the status. Remember: the metric that matters is customer conversations\nthis week — if that number is below 3, say so plainly.\n',
  extractionSchema: {
    type: "object",
    required: [
      "top_action",
      "stage_counts",
      "moved",
      "top_of_funnel",
      "stale_leads",
    ],
    properties: {
      top_action: { type: "string" },
      stage_counts: { type: "object" },
      moved: {
        type: "object",
        properties: {
          new_leads: { type: "integer" },
          stage_changes: { type: "integer" },
          pilot_updates: { type: "integer" },
        },
      },
      top_of_funnel: {
        type: "object",
        properties: {
          stars: { type: "integer" },
          x_mentions: { type: "integer" },
          hn_ph_activity: { type: "integer" },
        },
      },
      stale_leads: { type: "array", items: { type: "string" } },
      gap: { type: "string" },
      conversations_this_week: { type: "integer" },
    },
  },
});

const inbound_triageWatcher = defineWatcher({
  agent: crm,
  slug: "inbound-triage",
  name: "Inbound triage",
  schedule: "0 8-22/2 * * *",
  notification: { priority: "normal" },
  minCooldownSeconds: 300,
  tags: ["crm", "triage"],
  reaction: reactionFromFile<typeof inboundTriageReaction>(
    "./inbound-triage.reaction.ts"
  ),
  prompt:
    'Look for new top-of-funnel signals since the last run, across the connectors\nin this org:\n  - GitHub: new stargazers on lobu-ai/lobu; new issues / issue comments /\n    PR comments — especially anything with deployment, self-host, multi-tenant,\n    "how do I", or evaluation language.\n  - X: new @-mentions of Lobu, replies to Burak\'s Lobu threads, quote-tweets.\n  - Hacker News / Product Hunt: new comments or posts mentioning Lobu or OpenClaw.\n\nFor each signal that looks like a real person (not a bot, not a casual star):\n  1. search_memory for an existing `lead` (match github handle / x handle / email).\n  2. If none, create a `lead` entity at the lowest stage the evidence supports\n     (a bare star → "signal"; a deployment-flavored issue comment or a\n     "how do I deploy this for my team" mention → "trial" or "conversation"),\n     with source set to where it came from, and entity_ids linking to the\n     source event. Then save a `lead:created` event.\n  3. If a lead exists, enrich it (add the handle, bump the stage if the new\n     signal warrants it, update last_touch) and save a `lead:interaction` or\n     `lead:stage_changed` event as appropriate.\n\nThen post to Slack: the new/updated leads, ranked by closeness-to-a-paying-pilot,\neach with a one-line recommended next action (e.g. "reply on the issue and offer\na 20-min call"). If nothing notable, post nothing — don\'t manufacture noise.\n',
  extractionSchema: {
    type: "object",
    required: ["new_leads", "enriched_leads", "recommended_actions"],
    properties: {
      new_leads: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            handle: { type: "string" },
            source: { type: "string" },
            stage: { type: "string" },
            why: { type: "string" },
          },
        },
      },
      enriched_leads: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, change: { type: "string" } },
        },
      },
      recommended_actions: { type: "array", items: { type: "string" } },
      notable: { type: "boolean" },
    },
  },
});

const github_accountAuth = defineAuthProfile({
  slug: "github-account",
  connector: "github",
  authKind: "oauth_account",
  name: "GitHub — lobu-ai",
});

const github_appAuth = defineAuthProfile({
  slug: "github-app",
  connector: "github",
  authKind: "oauth_app",
  name: "GitHub OAuth App",
  credentials: {
    GITHUB_CLIENT_ID: secret("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: secret("GITHUB_CLIENT_SECRET"),
  },
});

const x_accountAuth = defineAuthProfile({
  slug: "x-account",
  connector: "x",
  authKind: "oauth_account",
  name: "X — @lobu",
});

const competitor_changelogsConn = defineConnection({
  slug: "competitor-changelogs",
  connector: "website",
  name: "Competitor changelogs",
  config: {
    urls: [
      "https://lobu.ai/changelog",
      "https://docs.dust.tt/changelog",
      "https://www.glean.com/release-notes",
    ],
    max_pages: 10,
  },
  feeds: [
    {
      feed: "pages",
      name: "Changelog pages",
      schedule: "0 7 * * *",
      config: {
        urls: [
          "https://lobu.ai/changelog",
          "https://docs.dust.tt/changelog",
          "https://www.glean.com/release-notes",
        ],
        max_pages: 10,
        parse_sections: false,
      },
    },
  ],
});

const funnel_form_submissionsConn = defineConnection({
  slug: "funnel-form-submissions",
  connector: "funnel-form",
  name: "Demo-request form submissions",
  config: { endpoint: "https://lobu.ai/api/demo-requests" },
  feeds: [
    {
      feed: "submissions",
      name: "Form submissions",
      schedule: "*/15 * * * *",
      config: { endpoint: "https://lobu.ai/api/demo-requests" },
    },
  ],
});

const github_lobuConn = defineConnection({
  slug: "github-lobu",
  connector: "github",
  name: "GitHub — lobu-ai/lobu",
  authProfile: github_accountAuth,
  appAuthProfile: github_appAuth,
  config: { repo_owner: "lobu-ai", repo_name: "lobu" },
  feeds: [
    {
      feed: "stargazers",
      name: "Stars — lobu-ai/lobu",
      schedule: "0 */6 * * *",
      config: { repo_owner: "lobu-ai", repo_name: "lobu" },
    },
    {
      feed: "issues",
      name: "Issues — lobu-ai/lobu",
      schedule: "15 */6 * * *",
      config: { repo_owner: "lobu-ai", repo_name: "lobu", lookback_days: 90 },
    },
    {
      feed: "issue_comments",
      name: "Issue comments — lobu-ai/lobu",
      schedule: "30 */6 * * *",
      config: { repo_owner: "lobu-ai", repo_name: "lobu", lookback_days: 90 },
    },
    {
      feed: "pr_comments",
      name: "PR comments — lobu-ai/lobu",
      schedule: "45 */6 * * *",
      config: { repo_owner: "lobu-ai", repo_name: "lobu", lookback_days: 90 },
    },
  ],
});

const hn_lobuConn = defineConnection({
  slug: "hn-lobu",
  connector: "hackernews",
  name: "Hacker News — lobu",
  config: { search_query: "lobu", lookback_days: 180 },
  feeds: [
    {
      feed: "stories",
      name: "HN stories — lobu",
      schedule: "0 */4 * * *",
      config: { search_query: "lobu", lookback_days: 180 },
    },
  ],
});

const x_mentionsConn = defineConnection({
  slug: "x-mentions",
  connector: "x",
  name: "X — @lobu mentions & replies",
  authProfile: x_accountAuth,
  config: {
    search_query: "@lobu OR lobu.ai",
    search_filter: "live",
    max_scrolls: 10,
  },
  feeds: [
    {
      feed: "tweets",
      name: "X mentions — @lobu",
      schedule: "0 */3 * * *",
      config: {
        search_query: "@lobu OR lobu.ai",
        search_filter: "live",
        max_scrolls: 10,
      },
    },
  ],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof FunnelFormConnector>("./funnel-form.connector.ts"),
  ],
  org: "lobu-crm",
  orgName: "Lobu CRM",
  orgDescription:
    "Funnel CRM for Lobu — leads, pilots, conversations, launch signals",
  agents: [crm],
  entities: [lead, pilot],
  relationships: [converted_to],
  connections: [
    competitor_changelogsConn,
    funnel_form_submissionsConn,
    github_lobuConn,
    hn_lobuConn,
    x_mentionsConn,
  ],
  authProfiles: [github_accountAuth, github_appAuth, x_accountAuth],
  watchers: [funnel_digestWatcher, inbound_triageWatcher],
});
