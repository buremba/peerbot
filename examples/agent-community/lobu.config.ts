import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineSkill,
  defineEntityType,
  defineRelationshipType,
  defineBehavior,
  reactionFromFile,
  secret,
} from "@lobu/cli/config";
import type DiscoursePostsConnector from "./discourse-posts.connector.ts";
import type opportunityMatcherReaction from "./opportunity-matcher.reaction.ts";

const opportunityMatcherSkill = defineSkill({
  name: "opportunity-matcher",
  content:
    "Monitor connected profiles, newsletters, websites, and member updates for new launches, posts, hiring signals, funding news, and project changes. Identify which members are likely to care, explain why, and queue approved intro or outreach drafts.\n",
});

const agentCommunity = defineAgent({
  id: "agent-community",
  skills: [opportunityMatcherSkill],
  name: "agent-community",
  description:
    "Discover aligned members, explain why they should meet, and draft warm introductions",
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

const opportunityMatcher = defineBehavior({
  agent: agentCommunity,
  slug: "opportunity-matcher",
  name: "Opportunity matcher",
  triggers: [{ kind: "schedule", cron: "0 */12 * * *" }],
  notification: { priority: "normal" },
  tags: ["community", "matching"],
  minCooldownSeconds: 300,
  reaction: reactionFromFile<typeof opportunityMatcherReaction>(
    "./opportunity-matcher.reaction.ts"
  ),
  skills: ["opportunity-matcher"],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof DiscoursePostsConnector>(
      "./discourse-posts.connector.ts"
    ),
  ],
  org: "agent-community",
  orgName: "Agent Community",
  orgDescription:
    "Discover aligned members, explain why they should meet, and draft warm introductions",
  agents: [agentCommunity],
  entities: [match, post, topic],
  relationships: [interestedIn, introducedTo, matchesWith, writesAbout],
  behaviors: [opportunityMatcher],
});
