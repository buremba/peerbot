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
import type ExaNewsFeedConnector from "./exa-news-feed.connector.ts";
import type founderActivityTrackerReaction from "./founder-activity-tracker.reaction.ts";

const SECTOR_ENUM = ["bio-health", "ai", "fintech", "crypto", "consumer"];

const vcTracking = defineAgent({
  id: "vc-tracking",
  name: "vc-tracking",
  description:
    "Track companies, founders, and investment opportunities for venture firms",
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

const company = defineEntityType({
  key: "company",
  name: "Company",
  description: "Portfolio company or deal pipeline company",
  properties: {
    market: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Market",
    },
    sector: {
      type: "string",
      enum: SECTOR_ENUM,
      "x-table-column": true,
      "x-table-label": "Sector",
    },
    category: {
      type: "string",
      enum: ["portfolio", "recruiter", "prospect"],
      "x-table-column": true,
      "x-table-label": "Category",
    },
    location: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Location",
    },
    domain: {
      type: "string",
      description:
        "Normalized company domain used by identity-engine hosted_domain facts",
      "x-identity-namespace": {
        namespace: "hosted_domain",
        normalize: "lowercase",
      },
      "x-table-column": true,
      "x-table-label": "Domain",
    },
    one_liner: { type: "string" },
    team_size: { type: "integer" },
    founding_year: { type: "integer" },
    funding_raised: { type: "string" },
    valuation: { type: "string" },
    revenue: { type: "string" },
    growth_rate: { type: "string" },
    traction_score: { type: "number" },
    thesis: { type: "string" },
    stage: {
      type: "string",
      enum: [
        "idea",
        "pre-seed",
        "seed",
        "series-a",
        "series-b",
        "series-c",
        "growth",
        "public",
      ],
    },
    linkedin_url: { type: "string", format: "uri" },
    logo_url: { type: "string", format: "uri", description: "Brand logo URL" },
    tagline: { type: "string", description: "One-line brand tagline" },
    brand_voice: {
      type: "string",
      description: "Brand voice / tone-of-voice notes",
    },
    social_handles: {
      type: "object",
      description:
        "Brand social handles by platform (twitter, linkedin, github, …)",
      properties: {
        twitter: { type: "string" },
        linkedin: { type: "string" },
        github: { type: "string" },
        youtube: { type: "string" },
        instagram: { type: "string" },
        tiktok: { type: "string" },
      },
      additionalProperties: { type: "string" },
    },
  },
});

const founder = defineEntityType({
  key: "founder",
  name: "Founder",
  description: "Company founder or co-founder",
  properties: {
    role: { type: "string", "x-table-column": true, "x-table-label": "Role" },
    sector: {
      type: "string",
      enum: SECTOR_ENUM,
      "x-table-column": true,
      "x-table-label": "Sector",
    },
    location: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Location",
    },
    specialties: {
      type: "array",
      items: { type: "string" },
      "x-table-column": true,
      "x-table-label": "Specialties",
    },
    background: { type: "string" },
    linkedin_url: { type: "string", format: "uri" },
    twitter_handle: { type: "string" },
    education: { type: "string" },
    career_history: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
        },
      },
    },
    notable_exits: { type: "array", items: { type: "string" } },
    provenance: {
      type: "string",
      enum: ["inbound", "outbound", "referral", "event", "portfolio"],
    },
  },
});

const fundRound = defineEntityType({
  key: "fund-round",
  name: "Fund Round",
  description: "Investment round (seed, series A, etc.)",
  properties: {
    round_type: {
      type: "string",
      enum: [
        "preseed",
        "seed",
        "series_a",
        "series_b",
        "series_c",
        "series_d",
        "growth",
        "ipo",
      ],
      "x-table-column": true,
      "x-table-label": "Round Type",
    },
    amount_usd: {
      type: "number",
      "x-table-column": true,
      "x-table-label": "Amount (USD)",
    },
    date: {
      type: "string",
      format: "date",
      "x-table-column": true,
      "x-table-label": "Date",
    },
    lead_investor_slug: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Lead Investor",
      "x-link-entity-type": "investor",
      "x-link-lookup-field": "slug",
    },
    post_money_usd: { type: "number" },
    participants: { type: "array", items: { type: "string" } },
  },
});

const investor = defineEntityType({
  key: "investor",
  name: "Investor",
  description: "VC firm, angel investor, or fund",
  properties: {
    investor_type: {
      type: "string",
      enum: [
        "vc_firm",
        "angel",
        "corporate",
        "accelerator",
        "family_office",
        "partner",
      ],
      "x-table-column": true,
      "x-table-label": "Type",
    },
    sector_focus: {
      type: "array",
      items: { type: "string" },
      "x-table-column": true,
      "x-table-label": "Sector Focus",
    },
    website: {
      type: "string",
      format: "uri",
      "x-table-column": true,
      "x-table-label": "Website",
    },
    sector: {
      type: "string",
      enum: SECTOR_ENUM,
      "x-table-column": true,
      "x-table-label": "Sector",
    },
    bio: { type: "string" },
    fund_size: { type: "string" },
    stage_focus: { type: "array", items: { type: "string" } },
    linkedin_url: { type: "string", format: "uri" },
    portfolio_url: { type: "string", format: "uri" },
    typical_check_size: { type: "string" },
  },
});

const jobPosting = defineEntityType({
  key: "job-posting",
  name: "Job Posting",
  description: "Open role at a market.company",
  properties: {
    role: { type: "string", "x-table-column": true, "x-table-label": "Role" },
    title: { type: "string", "x-table-column": true, "x-table-label": "Title" },
    company_id: {
      type: "integer",
      description: "FK to market.company",
      "x-table-column": true,
      "x-table-label": "Company",
      "x-link-entity-type": "company",
    },
    posted_by_founder_id: {
      type: "integer",
      description: "FK to market.founder if posted by a verified founder",
      "x-link-entity-type": "founder",
    },
    posted_by_member_id: {
      type: "integer",
      description:
        "FK to market.$member if posted by an authorized member who isn't a founder",
      "x-link-entity-type": "$member",
    },
    city_id: {
      type: "integer",
      description: "FK to atlas.city (cross-org reference, optional)",
      "x-table-column": true,
      "x-table-label": "City",
    },
    description: { type: "string" },
    status: {
      type: "string",
      enum: ["open", "filled", "closed"],
      "x-table-column": true,
      "x-table-label": "Status",
    },
    posted_at: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time" },
  },
});

const product = defineEntityType({
  key: "product",
  name: "Product",
  description: "Company product tracked for reviews and market signals",
  properties: {
    tagline: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Tagline",
    },
    target_audience: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Target Audience",
    },
    value_proposition: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Value Proposition",
    },
    key_features: { type: "array", items: { type: "string" } },
    differentiators: { type: "string" },
  },
});

const sector = defineEntityType({
  key: "sector",
  name: "Sector",
  description: "Investment thesis / practice area",
  properties: {
    sector_key: {
      type: "string",
      enum: SECTOR_ENUM,
      "x-table-column": true,
      "x-table-label": "Sector Key",
    },
    description: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Description",
    },
    lead_partner_slug: {
      type: "string",
      "x-table-column": true,
      "x-table-label": "Lead Partner",
      "x-link-entity-type": "investor",
      "x-link-lookup-field": "slug",
    },
    color: { type: "string" },
  },
});

const educatedAt = defineRelationshipType({
  key: "educated_at",
  name: "Educated At",
  description:
    "Founder was educated at a university (cross-org reference into atlas.university)",
  rules: [{ source: "founder", target: "university" }],
});

const foundedBy = defineRelationshipType({
  key: "founded_by",
  name: "Founded By",
  description: "Company was founded by this person",
});

const headquarteredIn = defineRelationshipType({
  key: "headquartered_in",
  name: "Headquartered In",
  description:
    "Company is headquartered in a city (cross-org reference into atlas.city)",
  rules: [{ source: "company", target: "city" }],
});

const inIndustry = defineRelationshipType({
  key: "in_industry",
  name: "In Industry",
  description:
    "Company is in an industry (cross-org reference into atlas.industry)",
  rules: [{ source: "company", target: "industry" }],
});

const inSector = defineRelationshipType({
  key: "in_sector",
  name: "In Sector",
});

const investedIn = defineRelationshipType({
  key: "invested_in",
  name: "Invested In",
  description: "Investor has invested in this company",
});

const mentions = defineRelationshipType({
  key: "mentions",
  name: "Mentions",
  description:
    "Loose reference — one entity is mentioned in the context of another",
});

const operatesIn = defineRelationshipType({
  key: "operates_in",
  name: "Operates In",
  description:
    "Company operates in a country or region (cross-org reference into atlas.country or atlas.region)",
  rules: [
    { source: "company", target: "country" },
    { source: "company", target: "region" },
  ],
});

const previouslyAt = defineRelationshipType({
  key: "previously_at",
  name: "Previously At",
});

const primaryRelationshipOwner = defineRelationshipType({
  key: "primary_relationship_owner",
  name: "Primary Relationship Owner",
});

const roundLedBy = defineRelationshipType({
  key: "round_led_by",
  name: "Round Led By",
});

const roundOf = defineRelationshipType({
  key: "round_of",
  name: "Round Of",
});

const sourcedBy = defineRelationshipType({
  key: "sourced_by",
  name: "Sourced By",
});

const usesTechnology = defineRelationshipType({
  key: "uses_technology",
  name: "Uses Technology",
  description:
    "Company uses a technology in its stack (cross-org reference into atlas.technology)",
  rules: [{ source: "company", target: "technology" }],
});

const worksAt = defineRelationshipType({
  key: "works_at",
  name: "Works At",
  rules: [
    { source: "$member", target: "company" },
    { source: "founder", target: "company" },
  ],
});

const founderActivityTracker = defineWatcher({
  agent: vcTracking,
  slug: "founder-activity-tracker",
  name: "Founder Activity Tracker",
  schedule: "0 10 * * *",
  notification: { priority: "normal" },
  tags: ["vc", "founders", "daily"],
  minCooldownSeconds: 600,
  reaction: reactionFromFile<typeof founderActivityTrackerReaction>(
    "./founder-activity-tracker.reaction.ts"
  ),
  prompt:
    "You are a venture capital analyst tracking the public activity of startup founders in your portfolio.\n\n## Founders\n{{#each entities}}\n- {{name}} ({{entity_type}}, ID: {{id}})\n{{/each}}\n\n## Recent Founder Activity\n{{#if sources.founder_posts}}\n{{sources.founder_posts}}\n{{/if}}\n\n---\n\nProduce a structured founder activity report:\n1. **Executive Summary**: 2-3 sentence overview of founder activity and signals.\n2. **Per-Founder Analysis**: For each active founder, summarize their messaging themes, engagement level, and signals about company direction.\n3. **Cross-Portfolio Patterns**: Themes multiple founders discuss.\n4. **Notable Signals**: Flag potential announcements, strategic shifts, or concerns.\n\nBe specific and cite actual tweets/posts as evidence.\n",
  sources: {
    founder_posts:
      "SELECT id, title, payload_text, author_name, source_url, occurred_at, score, origin_type, connector_key FROM events WHERE connector_key IN ('x') AND origin_type IN ('tweet', 'reply') ORDER BY occurred_at DESC LIMIT 300\n",
  },
  reactionsGuidance:
    "When a founder signals hiring activity, fundraising, or pivots, flag for the investment team.\nTrack founders going quiet as a potential concern.\nAlert on any public statements about competitors or market conditions.\n",
});

const opportunityMatcher = defineWatcher({
  agent: vcTracking,
  slug: "opportunity-matcher",
  name: "Opportunity Matcher",
  schedule: "0 */12 * * *",
  notification: { priority: "normal" },
  tags: ["vc", "matching"],
  minCooldownSeconds: 600,
  prompt:
    'You are a community intelligence agent for a private founder community managed by a venture capital fund.\nYour job is to monitor founder activity and identify high-quality introduction opportunities between portfolio founders.\n\n## Community Members\n{{#each entities}}\n**{{name}}** ({{entity_type}})\n{{#if metadata.title}} — {{metadata.title}}{{/if}}\n{{#if metadata.role}} — {{metadata.role}}{{/if}}\n{{/each}}\n\n## Recent Activity\n{{#if sources.content}}\n{{sources.content}}\n{{/if}}\n\n## Instructions\n1. Scan all new content for signals: launches, posts, hiring announcements, funding news, project updates, and collaboration signals.\n2. For each signal, identify which other community founders are likely to care and explain why.\n3. Suggest a concrete action: warm intro draft, shared-interest notification, or flagging for community ops review.\n4. Only suggest introductions where there is a clear, specific overlap — not generic "both work in tech" matches.\n5. Rate each signal\'s strength (high/medium/low) based on timeliness and relevance.\n',
  sources: {
    content:
      "SELECT id, title, payload_text, author_name, source_url, occurred_at, score, origin_type, connector_key FROM events WHERE entity_id IN (SELECT id FROM entities WHERE entity_type = 'founder') ORDER BY occurred_at DESC LIMIT 300\n",
  },
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof ExaNewsFeedConnector>(
      "./exa-news-feed.connector.ts"
    ),
  ],
  org: "market",
  orgName: "Market",
  orgDescription:
    "Track companies, founders, and investment opportunities for venture firms",
  agents: [vcTracking],
  entities: [
    company,
    founder,
    fundRound,
    investor,
    jobPosting,
    product,
    sector,
  ],
  relationships: [
    educatedAt,
    foundedBy,
    headquarteredIn,
    inIndustry,
    inSector,
    investedIn,
    mentions,
    operatesIn,
    previouslyAt,
    primaryRelationshipOwner,
    roundLedBy,
    roundOf,
    sourcedBy,
    usesTechnology,
    worksAt,
  ],
  watchers: [founderActivityTracker, opportunityMatcher],
});
