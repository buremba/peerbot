/**
 * Tool: search_memory
 *
 * Search existing entities and saved memory in the database.
 * Searches all entity types when entity_type not specified.
 * For new entities, write a TS script for `run_sdk` that calls
 * `client.entities.create(...)` then `client.connections.create(...)`.
 */

import { type Static, Type } from '@sinclair/typebox';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { type AuthzScope, authzScopeFromToolContext } from '../authz/scope';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import { getDb } from '../db/client';
import type { Env } from '../index';
import type { FeedReader, SourceKind } from '../lib/feed-reader';
import { readVirtualFeed } from '../lib/connector-pushdown';
import {
  connectionLinkedEntityIdsSql,
  connectionLinkedToBusinessEntitySql,
} from '../authz/channel-about';
import { entityLinkMatchSql, searchContentByText } from '../utils/content-search';
import { resolveBoundChannelRows, stripPlatformPrefix } from '../gateway/channels/bound-channels';
import { filterChannelsForRequester } from '../authz/channel-visibility';
import { toVectorLiteral } from '../utils/entity-management';
import { ToolUserError } from '../utils/errors';
import logger from '../utils/logger';
import { expandSearchQueries } from '../utils/query-expansion';
import { buildEntityUrl, getPublicWebUrl } from '../utils/url-builder';
import { getWorkspaceProvider } from '../workspace';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { getErrorMessage } from "@lobu/core";

// ============================================
// Typebox Schema
// ============================================

export const SearchSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description: 'Search query (entity name). Required unless entity_id is provided.',
      minLength: 1,
    })
  ),
  entity_type: Type.Optional(
    Type.String({
      description: 'Entity type filter. If not provided, searches all entities.',
    })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description: 'Entity ID for direct lookup. Can be used instead of query for exact fetch.',
    })
  ),
  parent_id: Type.Optional(
    Type.Number({
      description: 'Filter by parent entity ID.',
    })
  ),
  market: Type.Optional(
    Type.String({
      description: 'Market/region code (ISO 3166-1 alpha-2)',
    })
  ),
  category: Type.Optional(
    Type.String({
      description: 'Filter by category metadata field',
    })
  ),
  fuzzy: Type.Optional(
    Type.Boolean({
      description: 'Enable fuzzy name matching',
      default: true,
    })
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description: 'Minimum similarity threshold for fuzzy matching (0.0-1.0)',
      default: 0.3,
      minimum: 0,
      maximum: 1,
    })
  ),
  include_connections: Type.Optional(
    Type.Boolean({
      description: 'Include connection details in response (max 20, active first)',
      default: true,
    })
  ),
  include_content: Type.Optional(
    Type.Boolean({
      description:
        'Include semantic content search results alongside entity matches (default: true). Uses the query for vector similarity search across all content in the organization.',
      default: true,
    })
  ),
  content_limit: Type.Optional(
    Type.Number({
      description: 'Max content results when include_content is enabled (default: 5, max: 50)',
      default: 5,
      minimum: 1,
      maximum: 50,
    })
  ),
  query_embedding: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        'Embedding vector for semantic similarity search. When provided, results are ranked by cosine similarity.',
    })
  ),
  metadata_filter: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Filter entities by metadata key-value pairs (e.g. {"category": "preference"})',
    })
  ),
  agent_id: Type.Optional(
    Type.String({
      description:
        "Limit results to memory written by this agent. Filters events where `metadata.agent_id` matches the given id. Agents that opt in (via the `@lobu/openclaw-plugin` autoCapture path) get their saves stamped with their own id automatically; pass the same id here to scope recall to that agent's own writes.",
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Max results (default: 5, max: 100)',
      minimum: 1,
      maximum: 100,
    })
  ),
  include_public_catalogs: Type.Optional(
    Type.Boolean({
      description:
        'Also search public-catalog orgs (visibility=public) — canonical world entities like HMRC, banks, currencies. Defaults to true so agents can discover entities to reference cross-org.',
      default: true,
    })
  ),
});

/**
 * Schema advertised on `tools/list`. Drops the server-internal fields that
 * `SearchSchema` still accepts (so validation passes for internal callers and
 * tests): `query_embedding` (a pre-computed vector the content-search layer
 * re-derives itself when absent) and `agent_id` (the caller's bound agent,
 * resolved from auth context — clients asserting it cross-agent within an org
 * is a footgun, not an affordance). See `ToolDefinition.publicInputSchema`.
 */
const PUBLIC_SEARCH_SCHEMA_INTERNAL_FIELDS = ['query_embedding', 'agent_id'];
export const PublicSearchSchema = Type.Object(
  Object.fromEntries(
    Object.entries(SearchSchema.properties).filter(
      ([key]) => !PUBLIC_SEARCH_SCHEMA_INTERNAL_FIELDS.includes(key)
    )
  )
);

type SearchArgs = Static<typeof SearchSchema>;

// ============================================
// Type Definitions
// ============================================

// Unified entity with all fields (nulls where not applicable)
export const EntitySchema = Type.Object({
  id: Type.Integer(),
  type: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  parent_id: Type.Union([Type.Integer(), Type.Null()]),
  parent_name: Type.Union([Type.String(), Type.Null()]),
  parent_slug: Type.Union([Type.String(), Type.Null()]),
  parent_entity_type: Type.Union([Type.String(), Type.Null()]),
  organization_slug: Type.Union([Type.String(), Type.Null()]),
  stats: Type.Object({
    content_count: Type.Integer(),
    connection_count: Type.Integer(),
    active_connection_count: Type.Integer(),
    children_count: Type.Integer(), // child count for root entities
    watcher_count: Type.Integer(),
  }),
  match_score: Type.Number(),
  match_reason: Type.String(),
});
export type Entity = Static<typeof EntitySchema>;

const ConnectionInfoSchema = Type.Object({
  connection_id: Type.Integer(),
  connector_key: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  config: Type.Record(Type.String(), Type.Unknown()),
  entity_names: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_at: Type.String(),
  updated_at: Type.Union([Type.String(), Type.Null()]),
  content_count: Type.Integer(),
});
type ConnectionInfo = Static<typeof ConnectionInfoSchema>;

interface EntityQueryRow {
  id: number;
  organization_id: string;
  name: string;
  entity_type: string;
  slug: string;
  metadata: Record<string, unknown> | null;
  parent_id: number | null;
  parent_name: string | null;
  parent_slug: string | null;
  parent_entity_type: string | null;
  content_count: number;
  connection_count: number;
  active_connection_count: number;
  children_count: number;
  watcher_count: number;
  match_score?: number;
  match_reason?: string;
  organization_slug?: string | null;
  vector_similarity?: number;
}

interface ChildEntityRow {
  id: number;
  name: string;
  entity_type: string;
  market: string | null;
  content_count: number;
}

const ContentSnippetSchema = Type.Object({
  id: Type.Integer(),
  title: Type.Union([Type.String(), Type.Null()]),
  text_content: Type.String(),
  author_name: Type.Union([Type.String(), Type.Null()]),
  source_url: Type.Union([Type.String(), Type.Null()]),
  platform: Type.String(),
  occurred_at: Type.Union([Type.String(), Type.Null()]),
  similarity: Type.Optional(Type.Number()),
  entity_ids: Type.Array(Type.Integer()),
});
type ContentSnippet = Static<typeof ContentSnippetSchema>;

// A keyword/recency hit from the chat transcript (`channel_messages`). Distinct
// from ContentSnippet on purpose: these are NOT `events`, so they carry no
// event id (their `id` would mislead a get_content follow-up) and no embedding
// similarity. They let search_memory surface past channel conversation without
// a separate get_channel_history tool — see project_conversation_feeds_virtual.
const ConversationSnippetSchema = Type.Object({
  platform: Type.String(),
  channel_id: Type.String(),
  thread_id: Type.Union([Type.String(), Type.Null()]),
  author_name: Type.Union([Type.String(), Type.Null()]),
  /** The sender's resolved person/$member entity id (store-only attribution),
   * or null when unattributed (bot post / no team / unresolved). */
  author_entity_id: Type.Union([Type.Integer(), Type.Null()]),
  text: Type.String(),
  occurred_at: Type.Union([Type.String(), Type.Null()]),
});
type ConversationSnippet = Static<typeof ConversationSnippetSchema>;

// A live block of rows recalled from ONE virtual feed (read via readVirtualFeed's
// search() pushdown). Distinct from ContentSnippet/ConversationSnippet on purpose:
// virtual rows are arbitrary connector columns (Gmail: id/subject/from/date/…),
// so they carry their own `columns` header rather than being coerced into a fixed
// snippet shape that would drop or mislabel columns. Nothing is persisted — these
// are read live from the source at recall time. See project_conversation_feeds_virtual.
const VirtualFeedRowsSchema = Type.Object({
  feed_id: Type.Integer(),
  feed_key: Type.String(),
  columns: Type.Array(Type.Object({ name: Type.String(), type: Type.String() })),
  rows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});
type VirtualFeedRows = Static<typeof VirtualFeedRowsSchema>;

/**
 * Result of `search_memory`. TypeBox-first and the SINGLE source of truth:
 * `UnifiedSearchResult` is `Static<>`-derived from this schema, which is also
 * the tool's `outputSchema`. Every nested type (Entity, ConnectionInfo,
 * ContentSnippet, ConversationSnippet, VirtualFeedRows) is itself
 * schema-derived, so there is no hand-written interface that can drift.
 */
export const UnifiedSearchResultSchema = Type.Object({
  entity_type: Type.Union([Type.String(), Type.Null()]),
  entity: Type.Union([EntitySchema, Type.Null()]),
  matches: Type.Array(EntitySchema),
  connections: Type.Optional(Type.Array(ConnectionInfoSchema)),
  children: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Integer(),
        name: Type.String(),
        type: Type.String(),
        market: Type.Union([Type.String(), Type.Null()]),
        content_count: Type.Integer(),
      })
    )
  ),
  content: Type.Optional(Type.Array(ContentSnippetSchema)),
  /** Past chat-channel messages matching the query, scoped to the agent's own
   * bound channels. Replaces the get_channel_history tool — read past convos
   * through the same search call. */
  conversation_messages: Type.Optional(Type.Array(ConversationSnippetSchema)),
  /** Live rows recalled from opt-in virtual feeds (`config.recall === true`) —
   * one block per feed, read via the connector's `search()` pushdown at request
   * time. Never persisted. */
  virtual_feeds: Type.Optional(Type.Array(VirtualFeedRowsSchema)),
  discovery_status: Type.Optional(
    Type.Union([Type.Literal('not_found'), Type.Literal('complete'), Type.Literal('discovering')])
  ),
  suggestion: Type.Optional(Type.String()),
  view_url: Type.Optional(Type.String()),
  existing_entities: Type.Optional(
    Type.Array(
      Type.Object({
        entity_type: Type.String(),
        entities: Type.Array(
          Type.Object({ id: Type.Integer(), name: Type.String() })
        ),
      })
    )
  ),
  metadata: Type.Object({
    total_matches: Type.Integer(),
    page_size: Type.Integer(),
  }),
});
export type UnifiedSearchResult = Static<typeof UnifiedSearchResultSchema>;

// ============================================
// Result Helpers
// ============================================

function emptyResult(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    entity_type: null,
    entity: null,
    matches: [],
    discovery_status: 'not_found',
    metadata: { total_matches: 0, page_size: 0 },
    ...overrides,
  };
}

function withRecall<T extends UnifiedSearchResult>(
  result: T,
  recall: Partial<UnifiedSearchResult>
): T {
  // Each recall source already omits its facet when empty, so a plain merge is
  // enough — no per-facet guards, no type-switch.
  return Object.assign(result, recall);
}

// ============================================
// Main Function
// ============================================

async function fetchContentSnippets(
  gate: AuthzScope,
  query: string | null,
  contentLimit: number,
  env: Env,
  queryEmbedding?: number[],
  agentId?: string
): Promise<ContentSnippet[]> {
  const result = await searchContentByText(
    query,
    {
      organization_id: gate.organizationId,
      // Enforce the org/private-connection visibility boundary on the recall
      // path, exactly as get_content does. Without visibility_scope the
      // connection-visibility clause is skipped entirely, so search_memory
      // (publicly readable) would expose another member's private-connection
      // content. See get-content-visibility / search-cross-org tests.
      visibility_scope: { organizationId: gate.organizationId, userId: gate.principal },
      limit: contentLimit,
      min_similarity: 0.4,
      query_embedding: queryEmbedding,
      agent_id: agentId,
      // Recall wants the most *relevant* matching content, not the most recent.
      // This also opts into the bounded recall-only candidate path (the implicit
      // default is a chronological date feed).
      sort_by: 'score',
      approximate_candidate_search: true,
    },
    env
  );

  return result.content.map((c) => {
    // payload_text is `string | null` (a content row can have no text body).
    // Coalesce to '' — both to avoid `.length`/`.slice` throwing on null and to
    // keep the (non-nullable) `text_content` schema field honest: "" is the
    // correct representation of no text, so structuredContent stays valid.
    const text = c.payload_text ?? '';
    return {
      id: c.id,
      title: c.title,
      text_content: text.length > 500 ? text.slice(0, 500) + '...' : text,
      author_name: c.author_name,
      source_url: c.source_url,
      platform: c.platform,
      occurred_at: c.occurred_at,
      similarity: c.similarity,
      entity_ids: Array.isArray(c.entity_ids) ? c.entity_ids.map(Number) : [],
    };
  });
}

// Generic "what did we talk about" recall words carry no signal against a
// transcript — if a prompt is ONLY these, keyword matching would return nothing,
// so we fall back to recency (the "catch me up" case get_channel_history served).
const RECALL_STOPWORDS = new Set([
  'the', 'and', 'you', 'our', 'what', 'did', 'was', 'were', 'are', 'has', 'had',
  'about', 'talk', 'talked', 'talking', 'discuss', 'discussed', 'discussion',
  'earlier', 'previous', 'prev', 'past', 'before', 'recent', 'recently', 'lately',
  'message', 'messages', 'thread', 'threads', 'conversation', 'conversations',
  'history', 'said', 'say', 'tell', 'told', 'catch', 'again', 'this', 'that',
  'they', 'them', 'here', 'there', 'with', 'from', 'your', 'mine', 'last', 'into',
]);

/**
 * Keyword/recency hits from the chat transcript (`channel_messages`) — no
 * embeddings. Scoped HARD to the channels the calling agent is bound to
 * (`resolveBoundChannelRows`), which IS the per-agent tenant fence:
 * channel_messages has no agent_id/user_id of its own, so an agent may only
 * recall its own conversations, exactly like read_conversation. channel_messages
 * carries only the recency index, so the scan is bounded to those channels.
 *
 * The bound-channel set is then INTERSECTED with what the requesting USER may
 * read (`filterChannelsForRequester`): for a connection whose channel-ACL graph
 * is materialized + fresh, a channel survives only if the user is `member_of`
 * it, so an agent acting for a user never surfaces a channel the user isn't in.
 * Connections without a fresh ACL graph pass through on the per-agent fence
 * alone (no behavior change). See authz/channel-visibility.
 *
 * Distinctive terms are AND-matched (ILIKE). A prompt with NO distinctive term
 * ("what did we talk about earlier") falls back to the most recent messages in
 * the agent's channels rather than returning nothing.
 */
async function fetchConversationSnippets(
  gate: AuthzScope,
  query: string,
  limit: number
): Promise<ConversationSnippet[]> {
  const sql = getDb();
  // The calling agent (the transcript tenant fence) MUST be present — the
  // conversation reader guards on it before calling, and we defend here too.
  if (!gate.agentId) return [];
  const boundChannels = await resolveBoundChannelRows(sql, {
    organizationId: gate.organizationId,
    agentId: gate.agentId,
  });
  if (boundChannels.length === 0) return [];
  // Per-user ACL gate: drop channels the requester isn't a member of, for
  // connections that have a fresh channel-ACL graph. Non-enforced connections
  // are returned unchanged, so this is a no-op until a workspace is graphed.
  const channels = await filterChannelsForRequester(sql, {
    organizationId: gate.organizationId,
    userId: gate.principal,
    rows: boundChannels,
  });
  if (channels.length === 0) return [];

  // Distinctive >2-char terms (generic recall words dropped). Tokenize on word
  // characters, NOT whitespace — otherwise trailing punctuation ("earlier?",
  // "revenue?") survives as an unmatchable term that both defeats the stopword
  // filter and makes the ILIKE miss. Tokens are alphanumeric, so no LIKE
  // metacharacter (`%` `_` `\`) can appear and no escaping is needed.
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 2 && !RECALL_STOPWORDS.has(t))
    .slice(0, 8);

  // (connection_id, channel_id) pairs the agent can see. A binding's channel_id
  // may be platform-prefixed (`slack:C…`); channel_messages stores the bare id.
  let pairFilter = sql``;
  channels.forEach((c, i) => {
    const channelId = stripPlatformPrefix(c.platform, c.channel_id);
    const clause = sql`(cm.connection_id = ${c.id} AND cm.channel_id = ${channelId})`;
    pairFilter = i === 0 ? clause : sql`${pairFilter} OR ${clause}`;
  });

  // No distinctive term → recency fallback (all channels), else AND of ILIKEs.
  let termFilter = sql`TRUE`;
  terms.forEach((t, i) => {
    const clause = sql`cm.text ILIKE ${`%${t}%`}`;
    termFilter = i === 0 ? clause : sql`${termFilter} AND ${clause}`;
  });

  const rows = (await sql`
    SELECT cm.platform, cm.channel_id, cm.thread_id, cm.author_name,
           cm.author_entity_id, cm.text, cm.occurred_at
    FROM channel_messages cm
    WHERE cm.organization_id = ${gate.organizationId}
      AND (${pairFilter})
      AND (${termFilter})
    ORDER BY cm.occurred_at DESC
    LIMIT ${limit}
  `) as Array<{
    platform: string;
    channel_id: string;
    thread_id: string | null;
    author_name: string | null;
    author_entity_id: number | string | null;
    text: string;
    occurred_at: Date | null;
  }>;

  return rows.map((r) => ({
    platform: r.platform,
    channel_id: r.channel_id,
    thread_id: r.thread_id,
    author_name: r.author_name,
    author_entity_id: r.author_entity_id == null ? null : Number(r.author_entity_id),
    text: r.text.length > 500 ? `${r.text.slice(0, 500)}...` : r.text,
    occurred_at: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
  }));
}

export interface RecallContext {
  query: string | null;
  /** Memory-scope filter for events content — the caller-supplied agent_id arg.
   * This is a CONTENT filter (which agent's memory), NOT a gate field; the
   * tenant/principal/calling-agent identity travels on the {@link AuthzScope}. */
  contentAgentId: string | undefined;
  contentLimit: number;
  env: Env;
  queryEmbedding?: number[];
}

/**
 * The consolidated recall sources — the `lens = 'recall'` row of the feed matrix
 * (see `docs/plans/feeds-and-connections-model.md`), one entry per source KIND:
 * `knowledge` (the `events` store — where data feeds and promoted memory live,
 * source `collected`), `conversation` (the `channel_messages` chat transcript,
 * source `chat-channel`), and `virtual` (opt-in virtual feeds read LIVE at
 * request time, source `virtual-live-dataset`). All read through ONE abstraction
 * — add a kind here + a RECALL_SOURCES entry; nothing branches on the kind.
 */
export type RecallKind = 'knowledge' | 'conversation' | 'virtual';

/** Maps each recall source's human label to its {@link SourceKind} axis value. */
const RECALL_SOURCE_KIND: Record<RecallKind, SourceKind> = {
  knowledge: 'collected',
  conversation: 'chat-channel',
  virtual: 'virtual-live-dataset',
};

/**
 * Max virtual feeds fanned out on a single recall. Each virtual feed spawns a
 * connector subprocess + a live external API round-trip, so unlike the
 * single-query knowledge/conversation sources this one has real per-feed cost.
 * A org with more opt-in feeds than this gets the first N (by id) and a logged
 * truncation — never a silent drop.
 */
const MAX_VIRTUAL_RECALL_FEEDS = 5;

/**
 * A recall source is a {@link FeedReader} on the `(source, lens='recall')` tuple:
 * it owns exactly one source kind and contributes ONLY the result facet it
 * produces (or `{}` when it has none). `canRead(ctx)` lets a source decline a ctx
 * it can't serve (no query text, wrong signal) so `gatherRecall` skips it
 * BRANCH-FREE — the guard lives on the reader, not in a caller-side `if`. Each
 * reader receives the ACL gate ({@link AuthzScope}) as a REQUIRED, typed argument
 * supplied by `gatherRecall` — never buried in `ctx`, so it can't be dropped at
 * the call site. (The gate enforcing the scope is verified by the per-source ACL
 * tests, not by the type.) Readers fail independently.
 */
export type RecallSource = FeedReader<
  SourceKind,
  'recall',
  RecallContext,
  Partial<UnifiedSearchResult>
> & {
  /** Human label for logs + the result facet it owns; maps to `source` via RECALL_SOURCE_KIND. */
  readonly kind: RecallKind;
};

/** `knowledge` — semantic/keyword snippets from the `events` store. */
const knowledgeSource: RecallSource = {
  kind: 'knowledge',
  source: RECALL_SOURCE_KIND.knowledge,
  lens: 'recall',
  // Reads via text OR a precomputed embedding; fetchContentSnippets tolerates a
  // null query (embedding-only), so there is nothing to decline here.
  canRead: () => true,
  read: async (gate, ctx) => {
    const content = await fetchContentSnippets(
      gate,
      ctx.query,
      ctx.contentLimit,
      ctx.env,
      ctx.queryEmbedding,
      ctx.contentAgentId
    );
    return content.length > 0 ? { content } : {};
  },
};

/** `conversation` — keyword/recency hits from the `channel_messages` transcript. */
const conversationSource: RecallSource = {
  kind: 'conversation',
  source: RECALL_SOURCE_KIND.conversation,
  lens: 'recall',
  // Keyword match has no embedding path, so a text query is required. (The
  // calling-agent requirement is gate-dependent and stays in `read`.)
  canRead: (ctx) => Boolean(ctx.query),
  read: async (gate, ctx) => {
    // Needs a calling agent (its bindings are the tenant fence, on the gate).
    // `canRead` already guaranteed a text query. The requesting user
    // (`gate.principal`) is the per-user side of the gate — see
    // fetchConversationSnippets.
    if (!ctx.query || !gate.agentId) return {};
    const conversation_messages = await fetchConversationSnippets(gate, ctx.query, ctx.contentLimit);
    return conversation_messages.length > 0 ? { conversation_messages } : {};
  },
};

/**
 * `virtual` — live rows from opt-in virtual feeds. A virtual feed participates
 * in ambient recall ONLY when its `config.recall === true`; most virtual feeds
 * exist to be SQL-addressable (query_sql) and must NOT tax every search_memory
 * call with a live external round-trip. For each opted-in feed we run
 * `readVirtualFeed` with the query as a recall term (its `search()` pushdown),
 * fenced by the SAME connection-visibility gate readVirtualFeed re-checks — the
 * enumeration below applies it too so we never spawn a subprocess for a feed the
 * caller can't see. Feeds fail INDEPENDENTLY: one feed's live error (expired
 * token, source down) never drops another's rows.
 */
const virtualSource: RecallSource = {
  kind: 'virtual',
  source: RECALL_SOURCE_KIND.virtual,
  lens: 'recall',
  // Recall over a virtual feed is a keyword `search()` — it needs query text.
  canRead: (ctx) => Boolean(ctx.query),
  read: async (gate, ctx) => {
    // `canRead` already guaranteed a text query.
    if (!ctx.query) return {};

    // Candidate opt-in feeds, gated by the same connection visibility every read
    // seam uses. Params: $1 organizationId, $2 principal (compiler). Ordered by
    // id and capped so an org with many feeds gets a bounded, logged fan-out.
    const sql = getDb();
    const vis = compileConnectionRowVisibility(gate, 2, 'c');
    const feedRows = (await sql.unsafe(
      `SELECT f.id, f.feed_key
       FROM feeds f
       JOIN connections c ON c.id = f.connection_id
       WHERE f.organization_id = $1
         AND f.virtual = true
         AND f.status = 'active'
         AND f.deleted_at IS NULL
         AND (f.config->>'recall') = 'true'
         AND c.deleted_at IS NULL
         AND c.status = 'active'
         ${vis.sql}
       ORDER BY f.id
       LIMIT ${MAX_VIRTUAL_RECALL_FEEDS + 1}`,
      [gate.organizationId, ...vis.params],
    )) as unknown as Array<{ id: number; feed_key: string }>;

    if (feedRows.length === 0) return {};
    let candidates = feedRows;
    if (candidates.length > MAX_VIRTUAL_RECALL_FEEDS) {
      candidates = candidates.slice(0, MAX_VIRTUAL_RECALL_FEEDS);
      logger.warn(
        `[search] virtual recall fan-out capped at ${MAX_VIRTUAL_RECALL_FEEDS} feeds ` +
          `for org ${gate.organizationId}; ${feedRows.length - MAX_VIRTUAL_RECALL_FEEDS}+ opted-in feed(s) skipped`
      );
    }

    const blocks = await Promise.all(
      candidates.map(async (f): Promise<VirtualFeedRows | null> => {
        try {
          const live = await readVirtualFeed({
            scope: gate,
            feedId: f.id,
            terms: [ctx.query as string],
            limit: ctx.contentLimit,
          });
          if (live.rows.length === 0) return null;
          return { feed_id: f.id, feed_key: f.feed_key, columns: live.columns, rows: live.rows };
        } catch (err) {
          logger.warn(`[search] virtual feed ${f.id} recall failed: ${getErrorMessage(err)}`);
          return null;
        }
      })
    );
    const virtual_feeds = blocks.filter((b): b is VirtualFeedRows => b !== null);
    return virtual_feeds.length > 0 ? { virtual_feeds } : {};
  },
};

export const RECALL_SOURCES: RecallSource[] = [knowledgeSource, conversationSource, virtualSource];

/** Run every recall reader that CAN serve `ctx` under `gate` and merge their
 * facets into one fragment. A source that returns `false` from `canRead` is
 * skipped BRANCH-FREE — the "needs query text" guard lives on the reader, not in
 * a caller-side type-switch. Readers fail INDEPENDENTLY: BOTH `canRead` and
 * `read` run inside the per-source isolation boundary, so a throw from either one
 * drops only that source's facet (logged), never another's. The `sources` param
 * is injectable so the registry can be tested generically. The gate is a
 * required, explicit argument: it is the ACL boundary every reader compiles
 * against, never buried in `ctx`. */
export async function gatherRecall(
  gate: AuthzScope,
  ctx: RecallContext,
  sources: RecallSource[] = RECALL_SOURCES
): Promise<Partial<UnifiedSearchResult>> {
  const fragments = await Promise.all(
    sources.map(async (source) => {
      try {
        // canRead is inside the try so a throwing predicate isolates to this
        // source (skipped + logged) instead of rejecting the whole gather.
        if (!source.canRead(ctx)) return {} as Partial<UnifiedSearchResult>;
        return await source.read(gate, ctx);
      } catch (err) {
        logger.warn(`[search] recall source '${source.kind}' failed: ${getErrorMessage(err)}`);
        return {} as Partial<UnifiedSearchResult>;
      }
    })
  );
  return Object.assign({}, ...fragments);
}

export const search = withValidatedArgs('search_memory', SearchSchema, searchImpl);

async function searchImpl(
  args: SearchArgs,
  env: Env,
  ctx: ToolContext
): Promise<UnifiedSearchResult> {
  // SDK delegates (`client.knowledge.search`) skip `checkToolAccess`, so
  // re-enforce the mcp:read scope here — but only for MCP token callers
  // (oauth/pat). Session/anonymous/system callers carry no MCP scope dimension
  // (they're gated by member role + public-readability at the query level), which
  // mirrors how extractAuthContext assigns scopes: real scopes for oauth/pat, a
  // not-applicable sentinel otherwise.
  const isMcpTokenCaller = ctx.tokenType === 'oauth' || ctx.tokenType === 'pat';
  if (isMcpTokenCaller && !hasRequiredMcpScope('read', ctx.scopes)) {
    throw new ToolUserError('search_memory requires an MCP session with read access.', 403);
  }

  const includeContent = args.include_content ?? true;
  const contentLimit = Math.min(args.content_limit ?? 5, 50);

  if (!ctx.organizationId) {
    return emptyResult({ suggestion: 'No accessible entities found in this workspace scope' });
  }

  // Validate: must have either query, ID, or embedding
  if (!args.query && !args.entity_id && !args.query_embedding?.length) {
    throw new ToolUserError('Must provide either query, entity_id, or query_embedding', 400);
  }

  // Helper to run content search in parallel. Runs when we have either a text
  // query or a pre-computed embedding — forwarding the embedding lets the
  // content layer skip regenerating it from text.
  const hasContentSignal = Boolean(args.query || args.query_embedding?.length);
  // The caller's bound agent (from auth context) scopes recall by default; an
  // explicit `agent_id` arg is still honored for server-internal cross-agent
  // recall, but is no longer advertised to clients (see PublicSearchSchema).
  // NOTE: deliberately NOT reading `metadata_filter.agent_id` — `metadata_filter`
  // is on the public schema, so honoring it would re-expose the very footgun
  // `PublicSearchSchema` hides.
  const agentIdScope = args.agent_id ?? ctx.agentId ?? undefined;
  // Channel recall is fenced to the CALLING agent's own bindings (ctx.agentId),
  // never a caller-supplied filter — that's the tenant boundary for transcript
  // rows, which have no agent_id of their own. gatherRecall catches per source.
  const recallPromise: Promise<Partial<UnifiedSearchResult>> =
    includeContent && hasContentSignal
      ? gatherRecall(
          authzScopeFromToolContext({
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            agentId: ctx.agentId,
          }),
          {
            query: args.query ?? null,
            contentAgentId: agentIdScope,
            contentLimit,
            env,
            queryEmbedding: args.query_embedding,
          }
        )
      : Promise.resolve({});

  // ========================================
  // ID-BASED LOOKUP (highest priority)
  // ========================================

  if (args.entity_id) {
    const [entity, recall] = await Promise.all([
      fetchEntityById(args.entity_id, env, ctx.organizationId),
      recallPromise,
    ]);
    if (entity) {
      return withRecall(await formatEntityResult([entity], args, ctx), recall);
    }
    return withRecall(
      emptyResult({
        entity_type: args.entity_type || null,
        suggestion: `Entity with ID ${args.entity_id} not found`,
      }),
      recall
    );
  }

  // ========================================
  // TIER 1 CACHE: Name-based search
  // ========================================

  // Truncate query for search — long texts break websearch_to_tsquery and don't improve results
  const query = args.query ? args.query.slice(0, 200).trim() || null : null;
  if (!query && !args.query_embedding?.length) {
    throw new ToolUserError('Must provide a query or query_embedding', 400);
  }

  logger.info(
    `[search] Querying entities for "${query ?? '(vector)'}" (entity_type=${args.entity_type}, fuzzy=${args.fuzzy}, market=${args.market}, has_embedding=${!!args.query_embedding})`
  );

  let [results, recall] = await Promise.all([
    queryEntities(query, args, env, ctx.organizationId),
    recallPromise,
  ]);

  if (results.length === 0 && query && !args.query_embedding?.length) {
    const fallbackQueries = expandSearchQueries(query, { maxVariants: 8 }).slice(1);
    for (const fallbackQuery of fallbackQueries) {
      results = await queryEntities(
        fallbackQuery.slice(0, 200).trim() || null,
        args,
        env,
        ctx.organizationId
      );
      if (results.length > 0) {
        logger.info(
          `[search] Recovered entity matches for "${query}" via fallback variant "${fallbackQuery}"`
        );
        break;
      }
    }
  }

  if (results.length > 0) {
    return withRecall(await formatEntityResult(results, args, ctx), recall);
  }

  // ========================================
  // NOT FOUND: Return empty result with existing entities for context
  // ========================================
  logger.info(`[search] No matches found for "${query}" in existing database`);

  const suggestionText =
    `No matches found for "${query}" in existing database.\n\n` +
    '**Next steps:** call `run_sdk` with a TS script over `client`:\n' +
    `1. Create the entity: \`await client.entities.create({ type: '<entity_type>', name: '${query}' })\` (optionally pass parent_id for hierarchy)\n` +
    "2. Create a connection: `await client.connections.create({ connector_key: '<connector>', ... })`, then scope it with `await client.feeds.create({ ... })`\n" +
    '3. Wait for ingestion to start automatically, then discover watchers with `client.watchers.list(...)` and inspect results with `client.knowledge.read(...)` / `client.watchers.get(...)`.\n\n' +
    '**Alternative:** If you know this entity should exist, verify the spelling or try a different search term.';

  // Fetch top entities per type so the LLM knows what exists
  const existing_entities = await fetchTopEntitiesByType(ctx.organizationId);

  return withRecall(
    emptyResult({ suggestion: suggestionText, existing_entities }),
    recall
  );
}

// ============================================
// Workspace Context Helpers
// ============================================

async function fetchTopEntitiesByType(
  organizationId: string
): Promise<Array<{ entity_type: string; entities: Array<{ id: number; name: string }> }>> {
  const sql = getDb();
  const rows = await sql`
    SELECT e.id, e.name, et.slug AS entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${organizationId}
      AND e.deleted_at IS NULL
    ORDER BY (SELECT COUNT(*) FROM current_event_records ev WHERE ${sql.unsafe(entityLinkMatchSql('e.id::bigint', 'ev'))}) DESC
    LIMIT 30
  `;

  const byType = new Map<string, Array<{ id: number; name: string }>>();
  for (const row of rows) {
    const type = row.entity_type as string;
    if (!byType.has(type)) byType.set(type, []);
    const list = byType.get(type)!;
    if (list.length < 5) {
      list.push({ id: Number(row.id), name: row.name as string });
    }
  }

  return [...byType.entries()].map(([entity_type, entities]) => ({ entity_type, entities }));
}

// ============================================
// Query Helper Functions
// ============================================

// Build the entity SELECT projection. The count subqueries (events,
// connections, watchers, children) are tenant-private operational data:
// running them globally for a public-catalog entity would leak other
// tenants' activity volumes through aggregate counts. Each count is
// gated on `e.organization_id = $callerOrg` so we return zeros for
// cross-org rows. Caller passes the parameter index for their org.
function entitySelectColumns(callerOrgParamIdx: number): string {
  const ownOrg = `e.organization_id = $${callerOrgParamIdx}`;
  return `
  e.id, e.organization_id, e.name, et.slug AS entity_type, e.slug, e.metadata, e.parent_id,
  pe.name as parent_name, pe.slug as parent_slug, pet.slug as parent_entity_type,
  CASE WHEN ${ownOrg} THEN
    COALESCE((
      SELECT COUNT(*) FROM current_event_records ev
      WHERE ${entityLinkMatchSql('e.id::bigint', 'ev')}
        AND ev.organization_id = e.organization_id
    ), 0)
  ELSE 0 END as content_count,
  CASE WHEN ${ownOrg} THEN
    COALESCE((
      SELECT COUNT(DISTINCT cn.connector_key)
      FROM feeds f
      JOIN connections cn ON cn.id = f.connection_id
      WHERE e.id = ANY(f.entity_ids)
        AND f.organization_id = e.organization_id
        AND f.deleted_at IS NULL
        AND cn.deleted_at IS NULL
    ), 0)
  ELSE 0 END as connection_count,
  CASE WHEN ${ownOrg} THEN
    COALESCE((
      SELECT COUNT(DISTINCT cn.connector_key)
      FROM feeds f
      JOIN connections cn ON cn.id = f.connection_id
      WHERE e.id = ANY(f.entity_ids)
        AND f.organization_id = e.organization_id
        AND f.deleted_at IS NULL
        AND cn.deleted_at IS NULL
        AND cn.status = 'active'
    ), 0)
  ELSE 0 END as active_connection_count,
  CASE WHEN ${ownOrg} THEN
    COALESCE((SELECT COUNT(*) FROM entities c WHERE c.parent_id = e.id AND c.organization_id = e.organization_id), 0)
  ELSE 0 END as children_count,
  CASE WHEN ${ownOrg} THEN
    COALESCE((SELECT COUNT(*) FROM watchers i WHERE e.id = ANY(i.entity_ids) AND i.organization_id = e.organization_id), 0)
  ELSE 0 END as watcher_count`;
}

const ENTITY_JOINS = `
  FROM entities e
  JOIN entity_types et ON et.id = e.entity_type_id
  LEFT JOIN entities pe ON e.parent_id = pe.id
  LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id`;

/**
 * Query entities by name with optional filters
 * - entity_type: filter by specific type
 * - parent_id: filter by specific parent
 * - category, market: additional filters
 * - query_embedding: vector similarity search
 * - metadata_filter: key-value metadata conditions
 * - organizationId: organization IDs the user can read from
 */
async function queryEntities(
  query: string | null,
  args: SearchArgs,
  _env: Env,
  organizationId: string
) {
  const sql = getDb();
  const fuzzyEnabled = args.fuzzy ?? true;
  const hasEmbedding = !!args.query_embedding?.length;
  const defaultLimit = hasEmbedding ? 20 : fuzzyEnabled ? 5 : 1;
  const limit = args.limit ?? defaultLimit;

  // Build dynamic WHERE conditions
  const conditions: string[] = ['e.deleted_at IS NULL'];
  const params: unknown[] = [];
  let paramIdx = 1;

  const addParam = (value: unknown): number => {
    params.push(value);
    return paramIdx++;
  };

  // Query text param — only push when we have a text query
  const queryParamIdx = query ? addParam(query) : null;

  // Embedding param — only push when we have an embedding (avoids null::vector type error)
  const embeddingParamIdx = hasEmbedding ? addParam(toVectorLiteral(args.query_embedding!)) : null;

  // Query match condition: text match OR vector match
  if (query) {
    if (fuzzyEnabled) {
      const textCondition = `(LOWER(e.name) LIKE '%' || LOWER($${queryParamIdx}) || '%' OR LOWER(e.name) = LOWER($${queryParamIdx}) OR similarity(LOWER(e.name), LOWER($${queryParamIdx})) > 0.3 OR e.content_tsv @@ websearch_to_tsquery('english', $${queryParamIdx}))`;
      conditions.push(
        hasEmbedding ? `(${textCondition} OR e.embedding IS NOT NULL)` : textCondition
      );
    } else {
      conditions.push(`LOWER(e.name) = LOWER($${queryParamIdx})`);
    }
  } else if (hasEmbedding) {
    conditions.push('e.embedding IS NOT NULL');
  }

  // Organization filter — caller's org always; public-catalog orgs when the
  // flag is on (default), so an agent looking up "Apple" finds tenant-local
  // and canonical hits in one call. The result row carries the org_id so the
  // agent can tell which is which. The same param index is reused by the
  // count subqueries in entitySelectColumns(orgParamIdx), which gate
  // operational counts (events, connections, watchers) on caller-org rows
  // so cross-org public results don't leak other tenants' activity.
  const includePublic = args.include_public_catalogs ?? true;
  const orgParamIdx = addParam(organizationId);
  if (includePublic) {
    conditions.push(
      `(e.organization_id = $${orgParamIdx} OR EXISTS (SELECT 1 FROM organization o WHERE o.id = e.organization_id AND o.visibility = 'public'))`
    );
  } else {
    conditions.push(`e.organization_id = $${orgParamIdx}`);
  }

  if (args.entity_type) conditions.push(`et.slug = $${addParam(args.entity_type)}`);
  if (args.parent_id) conditions.push(`e.parent_id = $${addParam(args.parent_id)}`);
  if (args.category)
    conditions.push(`e.metadata::jsonb->>'category' = $${addParam(args.category)}`);
  if (args.market) {
    const idx = addParam(args.market);
    conditions.push(
      `(e.metadata::jsonb->>'main_market' = $${idx} OR e.metadata::jsonb->>'market' = $${idx})`
    );
  }

  // Metadata filter: arbitrary key-value conditions
  if (args.metadata_filter) {
    for (const [key, value] of Object.entries(args.metadata_filter)) {
      conditions.push(`e.metadata->>'${key.replace(/'/g, "''")}' = $${addParam(value)}`);
    }
  }

  // Structured agent_id filter. The top-level `agent_id` arg is the only
  // accepted form — it's server-internal (resolved from auth context in
  // searchImpl, or passed by server-internal callers); it is NOT advertised
  // on the public schema (see PublicSearchSchema). Do NOT honor
  // `metadata_filter.agent_id` — `metadata_filter` is public, so honoring it
  // would re-expose the cross-agent footgun the field split hides.
  const agentIdFilter = args.agent_id;
  if (agentIdFilter) {
    conditions.push(`e.metadata->>'agent_id' = $${addParam(agentIdFilter)}`);
  }

  const whereClause = conditions.join(' AND ');

  // Build scoring expression
  let scoreExpr: string;
  let matchReason: string;
  let vectorSimExpr: string;

  if (hasEmbedding) {
    // Blended scoring: 0.6 vector + 0.3 text + 0.1 name
    vectorSimExpr = `CASE WHEN e.embedding IS NOT NULL THEN 1 - (e.embedding <=> $${embeddingParamIdx}::vector) ELSE 0 END`;
    const textRankExpr =
      queryParamIdx !== null
        ? `COALESCE(ts_rank_cd(e.content_tsv, websearch_to_tsquery('english', $${queryParamIdx})), 0)`
        : '0';
    const nameSimExpr =
      queryParamIdx !== null ? `similarity(LOWER(e.name), LOWER($${queryParamIdx}))` : '0';
    scoreExpr = `(${vectorSimExpr}) * 0.6 + (${textRankExpr}) * 0.3 + (${nameSimExpr}) * 0.1`;
    matchReason = 'vector_blend';
  } else if (fuzzyEnabled && queryParamIdx !== null) {
    vectorSimExpr = 'NULL';
    scoreExpr = `CASE WHEN LOWER(e.name) = LOWER($${queryParamIdx}) THEN 1.0 ELSE similarity(LOWER(e.name), LOWER($${queryParamIdx})) END`;
    matchReason = 'fuzzy_match';
  } else {
    vectorSimExpr = 'NULL';
    scoreExpr = '1.0';
    matchReason = 'exact_name';
  }

  const rows = await sql.unsafe<EntityQueryRow>(
    `SELECT ${entitySelectColumns(orgParamIdx)},
      ${scoreExpr} as match_score,
      '${matchReason}' as match_reason,
      ${vectorSimExpr} as vector_similarity
    ${ENTITY_JOINS}
    WHERE ${whereClause}
    ORDER BY (e.organization_id = $${orgParamIdx}) DESC, match_score DESC
    LIMIT ${limit}`,
    params
  );

  await attachOrganizationSlugs(rows);

  return rows;
}

async function fetchEntityById(entityId: number, _env: Env, organizationId: string) {
  const sql = getDb();

  // Caller's org or any visibility=public catalog. Lets entity_id lookup find
  // canonical entities (HMRC, banks) the agent has discovered via search.
  // Operational counts (events, connections, watchers) are gated on
  // caller-org so cross-org public hits don't leak other tenants' activity.
  const result = await sql.unsafe<EntityQueryRow>(
    `SELECT ${entitySelectColumns(2)}
    ${ENTITY_JOINS}
    LEFT JOIN organization eo ON eo.id = e.organization_id
    WHERE e.id = $1
      AND (e.organization_id = $2 OR eo.visibility = 'public')
      AND e.deleted_at IS NULL`,
    [entityId, organizationId]
  );

  if (result.length === 0) return null;

  await attachOrganizationSlugs(result);
  return result[0];
}

// ============================================
// Formatting Helper Functions
// ============================================

async function formatEntityResult(
  entityRows: EntityQueryRow[],
  args: SearchArgs,
  ctx: ToolContext
): Promise<UnifiedSearchResult> {
  // Map rows to unified Entity format (all fields, nulls where not applicable)
  const matches: Entity[] = entityRows.map((row) => ({
    id: Number(row.id),
    type: row.entity_type,
    name: row.name,
    slug: row.slug,
    metadata: row.metadata ?? {},
    parent_id: row.parent_id != null ? Number(row.parent_id) : null,
    parent_name: row.parent_name ?? null,
    parent_slug: row.parent_slug ?? null,
    parent_entity_type: row.parent_entity_type ?? null,
    organization_slug: row.organization_slug ?? null,
    stats: {
      content_count: Number(row.content_count) || 0,
      connection_count: Number(row.connection_count) || 0,
      active_connection_count: Number(row.active_connection_count) || 0,
      children_count: Number(row.children_count) || 0,
      watcher_count: Number(row.watcher_count) || 0,
    },
    match_score: Number(row.match_score) || 1.0,
    match_reason: row.match_reason || 'exact_name',
  }));

  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  const primaryEntity = matches[0];
  const primaryRow = entityRows[0];
  const entityType = primaryEntity.type;
  const isRootEntity = !primaryEntity.parent_id;

  // Fetch connections if requested (default: true). Public-catalog entities
  // are referenced by many tenants; running fetchConnectionsForEntity on
  // them would surface other tenants' private connection metadata
  // (display_name, config, feed entity names). Connections are per-tenant
  // operational data, never canonical, so skip them entirely for cross-org
  // public results.
  let connections: ConnectionInfo[] | undefined;
  const primaryIsCallerOrg =
    String(primaryRow.organization_id) === ctx.organizationId;
  if ((args.include_connections ?? true) && primaryIsCallerOrg) {
    connections = await fetchConnectionsForEntity(primaryEntity.id);
  }

  // Fetch children for root entities (no parent). Children are scoped to
  // the primary's own org — preserves the parent-org boundary and stops
  // tenant-private "child of HMRC"-style rows from leaking when the primary
  // is a cross-org public entity. content_count is zeroed for cross-org
  // primaries to match the same invariant the parent's stats follow.
  let children: UnifiedSearchResult['children'];
  if (isRootEntity) {
    const childRows = await getDb()<ChildEntityRow>`
      SELECT
        e.id,
        e.name,
        et.slug AS entity_type,
        e.metadata::jsonb->>'market' as market,
        CASE WHEN ${primaryIsCallerOrg} THEN
          COALESCE(
            (SELECT COUNT(*) FROM current_event_records ev
              WHERE e.id = ANY(ev.entity_ids)
                AND ev.organization_id = e.organization_id),
            0
          )
        ELSE 0 END as content_count
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.parent_id = ${primaryEntity.id}
        AND e.organization_id = ${primaryRow.organization_id}
      ORDER BY e.created_at DESC
    `;
    children = childRows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      type: row.entity_type,
      market: row.market,
      content_count: Number(row.content_count),
    }));
  }

  // Generate helpful suggestion based on connection status
  let suggestion: string;
  if (matches.length === 1) {
    const activeConnections =
      connections?.filter((c) => c.status === 'active').length ||
      primaryEntity.stats.active_connection_count;
    const pausedConnections = connections?.filter((c) => c.status === 'paused').length || 0;

    if (activeConnections === 0 && pausedConnections === 0) {
      suggestion = `Entity "${primaryEntity.name}" found with no connections. Use manage_connections to add one and start collection.`;
    } else if (activeConnections === 0 && pausedConnections > 0) {
      suggestion = `Entity "${primaryEntity.name}" has ${pausedConnections} paused connection(s). Reactivate a connection to resume collection.`;
    } else {
      suggestion = `Entity "${primaryEntity.name}" found with ${activeConnections} active connection(s).`;
    }
  } else {
    suggestion = `Found ${matches.length} matching entities.`;
  }

  // Build view URL for the primary entity
  let viewUrl: string | undefined;
  if (primaryEntity.organization_slug) {
    viewUrl = buildEntityUrl(
      {
        ownerSlug: primaryEntity.organization_slug,
        entityType: entityType,
        slug: primaryEntity.slug,
        parentType: primaryEntity.parent_entity_type ?? null,
        parentSlug: primaryEntity.parent_slug ?? null,
      },
      baseUrl
    );
  }

  return {
    entity_type: entityType,
    entity: primaryEntity,
    matches,
    connections,
    children,
    discovery_status: 'complete',
    suggestion,
    view_url: viewUrl,
    metadata: {
      total_matches: matches.length,
      page_size: matches.length,
    },
  };
}

async function fetchConnectionsForEntity(entityId: number): Promise<ConnectionInfo[]> {
  const sql = getDb();
  const result = await sql`
    SELECT
      c.id as connection_id,
      c.connector_key,
      c.display_name,
      c.status,
      c.config,
      (
        SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
        FROM entities ent
        WHERE ent.deleted_at IS NULL
          AND ent.id IN ${sql.unsafe(connectionLinkedEntityIdsSql('c'))}
      ) as entity_names,
      c.created_at,
      c.updated_at,
      COALESCE(COUNT(f.id), 0) as content_count
    FROM connections c
    LEFT JOIN current_event_records f ON f.connection_id = c.id
    WHERE ${sql.unsafe(connectionLinkedToBusinessEntitySql(String(entityId), 'c', 'c.organization_id'))}
    GROUP BY c.id, c.connector_key, c.display_name, c.status, c.config, c.created_at, c.updated_at
    ORDER BY
      CASE c.status
        WHEN 'active' THEN 1
        WHEN 'paused' THEN 2
        ELSE 4
      END,
      c.created_at DESC
    LIMIT 20
  `;

  return result as ConnectionInfo[];
}

async function attachOrganizationSlugs(rows: EntityQueryRow[]): Promise<void> {
  if (rows.length === 0) return;

  const orgIds = Array.from(new Set(rows.map((row) => row.organization_id))).filter(Boolean);
  if (orgIds.length === 0) return;

  const slugById = await getWorkspaceProvider().getOrgSlugs(orgIds);

  for (const row of rows) {
    row.organization_slug = slugById.get(row.organization_id) ?? null;
  }
}
