import {
  defineAgent,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/sdk";

const agentCommunity = defineAgent({
  id: "agent-community",
  name: "agent-community",
  description:
    "Discover aligned members, explain why they should meet, and draft warm introductions",
  dir: "./agents/agent-community",
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

const match = defineEntityType({
  key: "match",
  name: "Match",
  description:
    "A suggested introduction between two members with reasons and confidence",
  properties: {
    member_a: {
      type: "string",
      "x-table-label": "Member A",
      "x-table-column": true,
    },
    member_b: {
      type: "string",
      "x-table-label": "Member B",
      "x-table-column": true,
    },
    reason: {
      type: "string",
      "x-table-label": "Reason",
      "x-table-column": true,
    },
    status: {
      type: "string",
      "x-table-label": "Status",
      "x-table-column": true,
    },
  },
});

const post = defineEntityType({
  key: "post",
  name: "Post",
  description:
    "A blog post, newsletter, or public writing by a community member",
  properties: {
    title: { type: "string", "x-table-label": "Title", "x-table-column": true },
    source: {
      type: "string",
      "x-table-label": "Source",
      "x-table-column": true,
    },
    author: {
      type: "string",
      "x-table-label": "Author",
      "x-table-column": true,
    },
    topics: {
      type: "string",
      "x-table-label": "Topics",
      "x-table-column": true,
    },
  },
});

const topic = defineEntityType({
  key: "topic",
  name: "Topic",
  description:
    "A durable interest or subject area used for member matching and discovery",
  properties: {
    topic_name: {
      type: "string",
      "x-table-label": "Topic",
      "x-table-column": true,
    },
    evidence: {
      type: "string",
      "x-table-label": "Evidence",
      "x-table-column": true,
    },
    member_count: {
      type: "string",
      "x-table-label": "Members",
      "x-table-column": true,
    },
    relevance: { type: "string", "x-table-label": "Relevance" },
  },
});

const interestedIn = defineRelationshipType({
  key: "interested-in",
  name: "Interested In",
  description:
    "Store durable interests and goals that can be reused across matching and introductions.",
});

const introducedTo = defineRelationshipType({
  key: "introduced-to",
  name: "Introduced To",
  description:
    "Track completed introductions so the system avoids duplicate outreach and preserves relationship history.",
});

const matchesWith = defineRelationshipType({
  key: "matches-with",
  name: "Matches With",
  description:
    "Represent suggested introductions with reasons and confidence so outreach history is auditable.",
});

const writesAbout = defineRelationshipType({
  key: "writes-about",
  name: "Writes About",
  description:
    "Capture blog posts, newsletters, and public writing so matching includes current thinking, not just static bios.",
});

const opportunityMatcher = defineWatcher({
  agent: agentCommunity,
  slug: "opportunity-matcher",
  name: "Opportunity matcher",
  schedule: "0 */12 * * *",
  notification: { priority: "normal" },
  tags: ["community", "matching"],
  minCooldownSeconds: 300,
  reaction: "./models/reactions/opportunity-matcher.reaction.ts",
  prompt:
    "Monitor connected profiles, newsletters, websites, and member updates for new launches, posts, hiring signals, funding news, and project changes. Identify which members are likely to care, explain why, and queue approved intro or outreach drafts.\n",
  extractionSchema: {
    type: "object",
    required: ["signals"],
    properties: {
      signals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            source: { type: "string" },
            related_topics: { type: "array", items: { type: "string" } },
            interested_members: { type: "array", items: { type: "string" } },
            reason: { type: "string" },
            suggested_action: { type: "string" },
          },
        },
      },
    },
  },
});

export default defineConfig({
  org: "agent-community",
  orgName: "Agent Community",
  orgDescription:
    "Discover aligned members, explain why they should meet, and draft warm introductions",
  agents: [agentCommunity],
  entities: [match, post, topic],
  relationships: [interestedIn, introducedTo, matchesWith, writesAbout],
  watchers: [opportunityMatcher],
});
