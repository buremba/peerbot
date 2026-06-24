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
import type NpmDownloadsConnector from "./npm-downloads.connector.ts";
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
      model: "z-ai/glm-5.2",
      key: secret("Z_AI_API_KEY"),
    },
  ],
  // Hosted Lobu Slack bot — no bot token needed. `lobu run` prints a
  // `/lobu link <code>` you redeem by DMing the bot to bind a DM/channel
  // (writes agent_channel_bindings).
  platforms: [
    { type: "slack", surfaces: ["dm", "channel"], codeTtlMinutes: 15 },
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

// Dogfood: Lobu's own production Postgres as a read-only memory + live-metrics
// source for the CRM. Use a least-privilege READ-ONLY role. Self-hosted only —
// the postgres connector is gated off multi-tenant cloud (docs/database-connectors.md).
const lobu_dbAuth = defineAuthProfile({
  slug: "lobu-db",
  connector: "postgres",
  authKind: "env",
  name: "Lobu Production DB (read-only)",
  credentials: {
    DATABASE_URL: secret("LOBU_PROD_READONLY_URL"),
  },
});

const competitor_changelogsConn = defineConnection({
  slug: "competitor-changelogs",
  connector: "website",
  name: "Competitor changelogs",
  // Connector sync settings live on the feed, not the connection — the server
  // stores feed-scoped config on feeds and rejects it on the connection.
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

const github_lobuConn = defineConnection({
  slug: "github-lobu",
  connector: "github",
  name: "GitHub — lobu-ai/lobu",
  authProfile: github_accountAuth,
  appAuthProfile: github_appAuth,
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

const npm_downloadsConn = defineConnection({
  slug: "npm-downloads-lobu-cli",
  connector: "npm-downloads",
  name: "npm downloads — @lobu/cli",
  config: { package: "@lobu/cli" },
  feeds: [
    {
      feed: "weekly",
      name: "Weekly downloads — @lobu/cli",
      schedule: "0 8 * * 1",
      config: { package: "@lobu/cli" },
    },
  ],
});

const lobu_dbConn = defineConnection({
  slug: "lobu-prod-db",
  connector: "postgres",
  name: "Lobu Production DB",
  authProfile: lobu_dbAuth,
  feeds: [
    {
      feed: "query",
      name: "New signups",
      schedule: "*/15 * * * *",
      config: {
        primary_key: "id",
        cursor_column: "created_at",
        // Base SELECT only — the connector adds the keyset WHERE / ORDER BY / LIMIT.
        query: `SELECT u.id, u.email, u.name, u."createdAt" AS created_at, o.slug AS org
                FROM "user" u
                JOIN member m ON m."userId" = u.id
                JOIN organization o ON o.id = m."organizationId"`,
        mapping: { title: "email", occurred_at: "created_at" },
      },
    },
    {
      feed: "query",
      name: "Org activity (daily)",
      schedule: "0 6 * * *",
      config: {
        primary_key: "id",
        cursor_column: "created_at",
        query: `SELECT id, organization_id AS org, connector_key, semantic_type, created_at
                FROM events`,
        mapping: { title: "semantic_type", occurred_at: "created_at" },
      },
    },
  ],
});

// Live, no-copy: funnel counts computed at read time straight from the prod DB
// (an external-backed derived entity — backing.connection pushes the SQL down to
// the connector, read live via query_sql({ connection })).
const funnel_by_org = defineEntityType({
  key: "funnel_by_org",
  name: "Funnel by org",
  description:
    "Signups + last activity per signed-up org, read live from the Lobu prod DB.",
  backing: {
    connection: "lobu-prod-db",
    sql: `SELECT o.slug AS org,
                 count(DISTINCT u.id) AS signups,
                 max(u."createdAt") AS last_signup
          FROM "user" u
          JOIN member m ON m."userId" = u.id
          JOIN organization o ON o.id = m."organizationId"
          GROUP BY o.slug`,
  },
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof NpmDownloadsConnector>(
      "./npm-downloads.connector.ts"
    ),
  ],
  org: "lobu-crm",
  orgName: "Lobu CRM",
  orgDescription:
    "Funnel CRM for Lobu — leads, pilots, conversations, launch signals",
  agents: [crm],
  entities: [lead, pilot, funnel_by_org],
  relationships: [converted_to],
  connections: [
    competitor_changelogsConn,
    github_lobuConn,
    hn_lobuConn,
    npm_downloadsConn,
    x_mentionsConn,
    lobu_dbConn,
  ],
  authProfiles: [
    github_accountAuth,
    github_appAuth,
    x_accountAuth,
    lobu_dbAuth,
  ],
  watchers: [funnel_digestWatcher, inbound_triageWatcher],
});
