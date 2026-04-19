import { performance } from 'node:perf_hooks';
import { type PgliteBackend, startPgliteBackend } from '../../../__tests__/setup/pglite-backend';
import {
  cleanupTestDatabase,
  getTestDb,
  setupTestDatabase,
} from '../../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../../__tests__/setup/test-fixtures';
import { clearMcpSessions, post } from '../../../__tests__/setup/test-helpers';
import { closeDbSingleton } from '../../../db/client';
import { generateEmbeddings } from '../../../utils/embeddings';
import type {
  BenchmarkAdapter,
  BenchmarkSuite,
  RetrievalResult,
  RetrieveContext,
  RetrievedMemory,
  ScenarioContext,
  TrialContext,
} from '../types';

interface ManageEntityCreateResult {
  action: 'create';
  entity: { id: number };
}

interface SaveKnowledgeResult {
  id: number;
}

interface SearchKnowledgeResult {
  entity?: { id: number } | null;
  matches?: Array<{ id: number }>;
}

interface ReadKnowledgeResult {
  content?: Array<{
    title: string | null;
    text_content: string;
    metadata: Record<string, unknown>;
    similarity?: number;
    combined_score?: number;
  }>;
}

interface ListLinksResult {
  relationships?: Array<{
    relationship_type_slug: string;
    from_entity_name?: string;
    to_entity_name?: string;
    metadata?: Record<string, unknown> | null;
    confidence: number;
  }>;
}

function isHistoricalLookup(prompt: string): boolean {
  return /\b(original|initial|earliest|first|previous|prior|before|formerly|used to)\b/i.test(
    prompt
  );
}

interface ConversationTurn {
  index: number;
  speaker: string;
  diaId?: string;
  utterance: string;
}

interface SplitConversation {
  header: string; // e.g. "Session date: 1:56 pm on 8 May, 2023"
  turns: ConversationTurn[];
}

/**
 * Detect and split a LoCoMo-style conversation session into per-turn chunks.
 *
 * Input format (from `benchmarks/memory/suites/locomo.50.json`):
 *   Session date: 1:56 pm on 8 May, 2023
 *
 *   Turn 1 (Caroline) [dia_id=D1:1]: Hey Mel! ...
 *   Turn 2 (Melanie) [dia_id=D1:2]: Hey Caroline! ...
 *
 * When the whole session is stored as a single event, its embedding averages across all
 * 18+ turns and long sessions dominate top-K for every query ("popularity bias"). Splitting
 * into per-turn events keeps embeddings narrow and lets specific utterances win on their
 * own content. Returns null for content that does not match the conversation format so
 * callers can fall through to a single-event save.
 */
function splitConversationSession(content: string): SplitConversation | null {
  const turnRegex = /\n\n(?=Turn \d+ \([^)]+\))/;
  const parts = content.split(turnRegex);
  if (parts.length < 2) return null;

  const header = parts[0]?.trim() ?? '';
  const turns: ConversationTurn[] = [];
  const turnLineRegex = /^Turn (\d+) \(([^)]+)\)(?: \[dia_id=([^\]]+)\])?:\s*([\s\S]*)$/;

  for (let i = 1; i < parts.length; i += 1) {
    const raw = parts[i]?.trim() ?? '';
    const match = raw.match(turnLineRegex);
    if (!match) return null; // Not a conversation format — fall back to single-event save.
    const [, indexStr, speaker, diaId, utterance] = match;
    turns.push({
      index: Number.parseInt(indexStr ?? '0', 10),
      speaker: (speaker ?? '').trim(),
      diaId: diaId?.trim() || undefined,
      utterance: (utterance ?? '').trim(),
    });
  }

  if (turns.length === 0) return null;
  return { header, turns };
}

let pgliteBackend: PgliteBackend | null = null;
let databaseReady = false;

async function ensurePglite(): Promise<void> {
  const benchmarkDatabaseUrl = process.env.OWLETTO_BENCHMARK_DATABASE_URL?.trim();

  if (benchmarkDatabaseUrl) {
    process.env.DATABASE_URL = benchmarkDatabaseUrl;
    process.env.PGSSLMODE = 'disable';
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY ??
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  } else if (!pgliteBackend) {
    pgliteBackend = await startPgliteBackend();
    process.env.DATABASE_URL = pgliteBackend.url;
    process.env.PGSSLMODE = 'disable';
    process.env.OWLETTO_DISABLE_PREPARE = '1';
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY ??
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  }

  if (!databaseReady) {
    await setupTestDatabase();
    databaseReady = true;
  }
}

export class OwlettoInprocessBenchmarkAdapter implements BenchmarkAdapter {
  readonly id: string;
  readonly label: string;

  private readonly entityIds = new Map<string, number>();
  private readonly eventIds = new Map<string, number>();
  private token: string | null = null;
  private userId: string | null = null;
  private orgId: string | null = null;
  private orgSlug: string | null = null;
  private sessionId: string | null = null;
  private scenariosIngested = 0;

  constructor(
    private readonly config: {
      id: string;
      label: string;
      topK?: number;
      searchLimit?: number;
      readLimit?: number;
      linkLimit?: number;
      embedWrites?: boolean;
      /**
       * Override combined_score vector weight (0..1) for semantic reads. Higher values
       * favor vector similarity over lexical text rank. Useful for conversational
       * corpora (LoCoMo) where keyword overlap creates false positives. Default: content-search's 0.6.
       */
      vectorWeight?: number;
      /**
       * Multiplier for how many events read_knowledge fetches before the adapter dedupes
       * by benchmark_step_id. Needed for per-turn-chunked conversations where one step
       * maps to many events. Default: 4 (so readLimit=8 → SQL limit=32).
       */
      readOverfetch?: number;
    }
  ) {
    this.id = config.id;
    this.label = config.label;
  }

  async reset(_ctx: TrialContext): Promise<void> {
    await ensurePglite();
    await cleanupTestDatabase();
    clearMcpSessions();
    this.entityIds.clear();
    this.eventIds.clear();
    this.scenariosIngested = 0;

    const org = await createTestOrganization({
      name: 'Memory Benchmark Org',
      slug: 'memory-benchmark',
    });
    this.orgId = org.id;
    this.orgSlug = org.slug;
    const user = await createTestUser({ email: 'bench@test.example.com', name: 'Benchmark User' });
    this.userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient({ client_name: 'Memory Benchmark Runner' });
    const access = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin profile:read',
    });
    this.token = access.token;
    this.sessionId = null;
  }

  async setup(ctx: TrialContext): Promise<void> {
    await this.seedEntityTypes(ctx.suite);
    await this.seedRelationshipTypes(ctx.suite);
  }

  async ingestScenario(ctx: ScenarioContext): Promise<void> {
    // Per-scenario DB reset so retrieval only sees this scenario's events. The runner
    // ingests all scenarios sequentially without wiping in between; without this, by the
    // time scenario N runs, the DB contains events from scenarios 1..N-1 as well, and the
    // client-side benchmark_scenario_id filter silently drops cross-scenario hits,
    // starving the ranker. First scenario skips because reset() + setup() already ran.
    if (this.scenariosIngested > 0) {
      const trialCtx: TrialContext = {
        runId: ctx.runId,
        trialIndex: ctx.trialIndex,
        suite: ctx.suite,
      };
      await this.reset(trialCtx);
      await this.setup(trialCtx);
    }
    this.scenariosIngested += 1;

    const scenarioEventIds: number[] = [];

    for (const entity of ctx.scenario.entities) {
      const result = await this.callTool<ManageEntityCreateResult>('manage_entity', {
        action: 'create',
        entity_type: entity.entityType,
        name: entity.name,
        metadata: {
          ...(entity.metadata ?? {}),
          benchmark_run_id: ctx.runId,
          benchmark_scenario_id: ctx.scenario.id,
          benchmark_entity_ref: entity.ref,
        },
      });
      this.entityIds.set(this.entityKey(ctx.runId, ctx.scenario.id, entity.ref), result.entity.id);
    }

    for (const step of ctx.scenario.steps) {
      if (step.kind === 'memory') {
        const entityIds = step.entityRefs.map((ref) =>
          this.requireEntityId(ctx.runId, ctx.scenario.id, ref)
        );
        // For conversation-style sessions (LoCoMo), split into per-turn events so each
        // turn gets its own focused embedding. supersedes can't refer into a chunked
        // session (LoCoMo never uses supersedes), so fall back to single-event save
        // when supersession is needed.
        const split = !step.supersedes ? splitConversationSession(step.content) : null;
        if (split && split.turns.length > 1) {
          let firstEventId: number | null = null;
          for (const turn of split.turns) {
            const turnTitle = `${step.title} — Turn ${turn.index} (${turn.speaker})`;
            // Keep the session date header in every turn's payload so retrieved turns
            // still carry temporal context for the answerer.
            const turnContent = [
              split.header,
              '',
              `Turn ${turn.index} (${turn.speaker}): ${turn.utterance}`,
            ]
              .filter(Boolean)
              .join('\n');
            const saveResult = await this.callTool<SaveKnowledgeResult>('save_knowledge', {
              entity_ids: entityIds,
              title: turnTitle,
              content: turnContent,
              semantic_type: step.semanticType,
              metadata: {
                ...(step.metadata ?? {}),
                benchmark_run_id: ctx.runId,
                benchmark_scenario_id: ctx.scenario.id,
                benchmark_step_id: step.id,
                turn_index: turn.index,
                turn_speaker: turn.speaker,
                ...(turn.diaId ? { turn_dia_id: turn.diaId } : {}),
              },
            });
            scenarioEventIds.push(saveResult.id);
            if (firstEventId == null) firstEventId = saveResult.id;
          }
          if (firstEventId != null) {
            this.eventIds.set(this.stepKey(ctx.runId, ctx.scenario.id, step.id), firstEventId);
          }
          continue;
        }

        const saveResult = await this.callTool<SaveKnowledgeResult>('save_knowledge', {
          entity_ids: entityIds,
          title: step.title,
          content: step.content,
          semantic_type: step.semanticType,
          supersedes_event_id: step.supersedes
            ? this.requireStepEventId(ctx.runId, ctx.scenario.id, step.supersedes)
            : undefined,
          metadata: {
            ...(step.metadata ?? {}),
            benchmark_run_id: ctx.runId,
            benchmark_scenario_id: ctx.scenario.id,
            benchmark_step_id: step.id,
          },
        });
        this.eventIds.set(this.stepKey(ctx.runId, ctx.scenario.id, step.id), saveResult.id);
        scenarioEventIds.push(saveResult.id);
        continue;
      }

      await this.callTool('manage_entity', {
        action: 'link',
        from_entity_id: this.requireEntityId(ctx.runId, ctx.scenario.id, step.fromRef),
        to_entity_id: this.requireEntityId(ctx.runId, ctx.scenario.id, step.toRef),
        relationship_type_slug: step.relationshipType,
        confidence: step.confidence ?? 1,
        source: 'api',
        metadata: {
          ...(step.metadata ?? {}),
          benchmark_run_id: ctx.runId,
          benchmark_scenario_id: ctx.scenario.id,
          benchmark_step_id: step.id,
          statement: step.content,
        },
      });
    }

    await this.embedScenarioEventsIfConfigured(scenarioEventIds);
  }

  async dispose(): Promise<void> {
    if (!pgliteBackend) return;
    // Close the postgres.js singleton pool BEFORE shutting down pglite's socket
    // server. Otherwise idle connections in the pool outlive the socket and
    // any follow-up query rejects with ECONNREFUSED as an unhandled rejection.
    await closeDbSingleton();
    await pgliteBackend.stop();
    pgliteBackend = null;
    databaseReady = false;
  }

  async retrieve(ctx: RetrieveContext): Promise<RetrievalResult> {
    const startedAt = performance.now();
    const entityIds = new Set<number>();
    const retrieved = new Map<string, RetrievedMemory>();
    const includeSuperseded = isHistoricalLookup(ctx.prompt);

    // With per-turn chunking, one LoCoMo session yields ~18 events all sharing the same
    // benchmark_step_id. read_knowledge returns events, the adapter dedupes to step_ids,
    // so we need to over-fetch enough candidates that dedup still produces topK unique
    // sessions even when a single session's turns dominate the raw top-N.
    const readOverfetch = this.config.readOverfetch ?? 4;
    const baseReadLimit = this.config.readLimit ?? this.config.topK ?? 8;
    const overFetchedLimit = Math.max(baseReadLimit, baseReadLimit * readOverfetch);

    const search = await this.callTool<SearchKnowledgeResult>('search_knowledge', {
      query: ctx.prompt,
      include_content: false,
      fuzzy: true,
      limit: this.config.searchLimit ?? 5,
    });
    if (typeof search.entity?.id === 'number') entityIds.add(search.entity.id);
    for (const match of search.matches ?? []) {
      if (typeof match.id === 'number') entityIds.add(match.id);
    }

    const globalContent = await this.callTool<ReadKnowledgeResult>('read_knowledge', {
      query: ctx.prompt,
      limit: overFetchedLimit,
      ...(this.config.vectorWeight !== undefined && {
        vector_weight: this.config.vectorWeight,
      }),
    });
    for (const item of globalContent.content ?? []) {
      const stepId = this.readBenchmarkStepId(item.metadata);
      if (!stepId || retrieved.has(stepId)) continue;
      if (
        item.metadata?.benchmark_run_id !== ctx.runId ||
        item.metadata?.benchmark_scenario_id !== ctx.scenarioId
      )
        continue;
      retrieved.set(stepId, {
        id: stepId,
        text: item.text_content,
        score: item.combined_score ?? item.similarity ?? 0.5,
        sourceType: 'memory',
        metadata: item.metadata,
      });
    }

    for (const entityId of entityIds) {
      if (retrieved.size < ctx.topK) {
        const scopedContent = await this.callTool<ReadKnowledgeResult>('read_knowledge', {
          entity_id: entityId,
          query: ctx.prompt,
          limit: overFetchedLimit,
          ...(this.config.vectorWeight !== undefined && {
            vector_weight: this.config.vectorWeight,
          }),
        });
        for (const item of scopedContent.content ?? []) {
          const stepId = this.readBenchmarkStepId(item.metadata);
          if (!stepId || retrieved.has(stepId)) continue;
          if (
            item.metadata?.benchmark_run_id !== ctx.runId ||
            item.metadata?.benchmark_scenario_id !== ctx.scenarioId
          )
            continue;
          retrieved.set(stepId, {
            id: stepId,
            text: item.text_content,
            score: item.combined_score ?? item.similarity ?? 0.5,
            sourceType: 'memory',
            metadata: item.metadata,
          });
        }
      }

      // For historical-lookup prompts ("original/earliest/first/prior..."), fetch superseded
      // versions explicitly — they won't surface via the default semantic read because the
      // scoped query path hides them by default.
      if (includeSuperseded) {
        const supersededContent = await this.callTool<ReadKnowledgeResult>('read_knowledge', {
          entity_id: entityId,
          query: ctx.prompt,
          limit: overFetchedLimit,
          include_superseded: true,
          ...(this.config.vectorWeight !== undefined && {
            vector_weight: this.config.vectorWeight,
          }),
        } as Record<string, unknown>);
        for (const item of supersededContent.content ?? []) {
          const stepId = this.readBenchmarkStepId(item.metadata);
          if (!stepId || retrieved.has(stepId)) continue;
          if (
            item.metadata?.benchmark_run_id !== ctx.runId ||
            item.metadata?.benchmark_scenario_id !== ctx.scenarioId
          )
            continue;
          retrieved.set(stepId, {
            id: stepId,
            text: item.text_content,
            score: item.combined_score ?? item.similarity ?? 0.5,
            sourceType: 'memory',
            metadata: item.metadata,
          });
        }
      }

      if (retrieved.size >= ctx.topK) continue;

      const links = await this.callTool<ListLinksResult>('manage_entity', {
        action: 'list_links',
        entity_id: entityId,
        direction: 'both',
        limit: this.config.linkLimit ?? this.config.topK ?? 8,
      });
      for (const relationship of links.relationships ?? []) {
        const stepId = this.readBenchmarkStepId(relationship.metadata);
        if (!stepId || retrieved.has(stepId)) continue;
        if (
          relationship.metadata?.benchmark_run_id !== ctx.runId ||
          relationship.metadata?.benchmark_scenario_id !== ctx.scenarioId
        )
          continue;
        retrieved.set(stepId, {
          id: stepId,
          text:
            typeof relationship.metadata?.statement === 'string'
              ? relationship.metadata.statement
              : `${relationship.from_entity_name ?? 'Unknown'} ${relationship.relationship_type_slug} ${relationship.to_entity_name ?? 'Unknown'}`,
          score: relationship.confidence,
          sourceType: 'relationship',
          metadata: relationship.metadata ?? undefined,
        });
      }
    }

    const topItems = [...retrieved.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, ctx.topK);

    // Retrieval matched on narrow per-turn embeddings (precision). The answerer needs
    // the surrounding turns + session header to extract multi-turn facts like "Where
    // has Melanie camped?" and to anchor temporal phrases like "Last Friday". Rebuild
    // full session text in place from all turn events sharing a step_id.
    if (topItems.some((item) => this.itemHasTurnChunking(item))) {
      await this.reconstructSessionTextInPlace(topItems, ctx);
    }

    // Compact per-session date map on top, so the LLM can resolve relative phrases into
    // absolute dates without scanning every full-session block.
    const contextPrefix = this.buildSessionDateIndex(topItems);

    return {
      items: topItems,
      latencyMs: performance.now() - startedAt,
      ...(contextPrefix ? { contextPrefix } : {}),
      raw: { entityIds },
    };
  }

  private itemHasTurnChunking(item: RetrievedMemory): boolean {
    if (item.sourceType !== 'memory') return false;
    const meta = item.metadata as Record<string, unknown> | undefined;
    return meta != null && 'turn_index' in meta;
  }

  private async reconstructSessionTextInPlace(
    items: RetrievedMemory[],
    ctx: RetrieveContext
  ): Promise<void> {
    const stepIds = [...new Set(items.filter((i) => this.itemHasTurnChunking(i)).map((i) => i.id))];
    if (stepIds.length === 0) return;

    const sql = getTestDb();
    const rows = await sql<
      { step_id: string; turn_index: number; title: string | null; payload_text: string | null }[]
    >`
      SELECT
        metadata->>'benchmark_step_id' AS step_id,
        COALESCE(NULLIF(metadata->>'turn_index', '')::int, 0) AS turn_index,
        title,
        payload_text
      FROM events
      WHERE metadata->>'benchmark_run_id' = ${ctx.runId}
        AND metadata->>'benchmark_scenario_id' = ${ctx.scenarioId}
        AND metadata->>'benchmark_step_id' = ANY(${stepIds})
      ORDER BY step_id ASC, turn_index ASC
    `;

    const sessionByStep = new Map<string, { header: string | null; turns: string[] }>();
    for (const row of rows) {
      let entry = sessionByStep.get(row.step_id);
      if (!entry) {
        entry = { header: null, turns: [] };
        sessionByStep.set(row.step_id, entry);
      }
      const text = (row.payload_text ?? '').trim();
      if (!text) continue;
      // Each turn's payload starts with the session date header. Capture once from the
      // first turn, then strip from subsequent turns to avoid duplicating it.
      const headerSplit = text.split(/\n\nTurn /);
      if (headerSplit.length === 2) {
        if (entry.header == null) entry.header = headerSplit[0] ?? '';
        entry.turns.push(`Turn ${headerSplit[1] ?? ''}`);
      } else {
        entry.turns.push(text);
      }
    }

    for (const item of items) {
      const session = sessionByStep.get(item.id);
      if (!session) continue;
      const parts: string[] = [];
      if (session.header) parts.push(session.header);
      parts.push(...session.turns);
      item.text = parts.join('\n\n');
    }
  }

  private buildSessionDateIndex(items: RetrievedMemory[]): string | undefined {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const meta = item.metadata as Record<string, unknown> | undefined;
      if (!meta) continue;
      const iso = typeof meta.session_date_iso === 'string' ? meta.session_date_iso : undefined;
      const human =
        typeof meta.session_date === 'string' ? (meta.session_date as string) : undefined;
      if (!iso && !human) continue;
      const day = iso ? this.describeIsoDay(iso) : undefined;
      const parts = [human ?? iso, day].filter(Boolean);
      lines.push(`- ${item.id}: ${parts.join(' — ')}`);
    }
    if (lines.length === 0) return undefined;
    return [
      'Session date index (resolve relative dates like "last Friday" against these):',
      ...lines,
    ].join('\n');
  }

  private describeIsoDay(iso: string): string | undefined {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return undefined;
    const dayName = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const ymd = d.toISOString().slice(0, 10);
    return `${dayName}, ${ymd}`;
  }

  private async embedScenarioEventsIfConfigured(eventIds: number[]): Promise<void> {
    if (!this.config.embedWrites || eventIds.length === 0) return;
    if (!process.env.EMBEDDINGS_SERVICE_URL) return;

    const sql = getTestDb();
    const rows = await sql`
      SELECT e.id, e.title, e.payload_text
      FROM events e
      WHERE e.id = ANY(${eventIds})
      ORDER BY e.id ASC
    `;

    const texts = rows.map((row) => [row.title, row.payload_text].filter(Boolean).join(' ').trim());
    const embeddings = await generateEmbeddings(texts, {
      ENVIRONMENT: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      JWT_SECRET: 'test-jwt-secret-for-testing-only',
      BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
      EMBEDDINGS_SERVICE_URL: process.env.EMBEDDINGS_SERVICE_URL,
      EMBEDDINGS_SERVICE_TOKEN: process.env.EMBEDDINGS_SERVICE_TOKEN,
      EMBEDDINGS_TIMEOUT_MS: process.env.EMBEDDINGS_TIMEOUT_MS,
    });

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as { id: number };
      const embedding = embeddings[index];
      if (!embedding) continue;
      const vectorStr = `[${embedding.join(',')}]`;
      await sql.unsafe(
        'INSERT INTO event_embeddings (event_id, embedding) VALUES ($1, $2::vector) ON CONFLICT (event_id) DO NOTHING',
        [row.id, vectorStr]
      );
    }
  }

  private async seedEntityTypes(suite: BenchmarkSuite): Promise<void> {
    const sql = getTestDb();
    const orgId = this.requireOrgId();
    for (const entityType of suite.entityTypes) {
      const existing = await sql`
        SELECT id FROM entity_types
        WHERE organization_id = ${orgId}
          AND slug = ${entityType.slug}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (existing.length > 0) continue;
      await sql`
        INSERT INTO entity_types (
          organization_id, slug, name, description, icon, color, metadata_schema, event_kinds, created_by, created_at, updated_at
        ) VALUES (
          ${orgId},
          ${entityType.slug},
          ${entityType.name},
          ${entityType.description ?? null},
          ${'🧪'},
          ${'#4f46e5'},
          ${sql.json((entityType.metadataSchema ?? { type: 'object', additionalProperties: true }) as any)},
          ${sql.json((entityType.eventKinds ?? {}) as any)},
          ${this.requireUserId()},
          NOW(),
          NOW()
        )
      `;
    }
  }

  private async seedRelationshipTypes(suite: BenchmarkSuite): Promise<void> {
    const sql = getTestDb();
    const orgId = this.requireOrgId();
    for (const relationshipType of suite.relationshipTypes ?? []) {
      const existing = await sql`
        SELECT id FROM entity_relationship_types
        WHERE organization_id = ${orgId}
          AND slug = ${relationshipType.slug}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      const relationshipTypeId =
        existing[0]?.id ??
        (
          await sql`
            INSERT INTO entity_relationship_types (
              organization_id, slug, name, description, is_symmetric, status, created_by, created_at, updated_at
            ) VALUES (
              ${orgId},
              ${relationshipType.slug},
              ${relationshipType.name},
              ${relationshipType.description ?? null},
              ${relationshipType.isSymmetric ?? false},
              ${'active'},
              ${this.requireUserId()},
              NOW(),
              NOW()
            )
            RETURNING id
          `
        )[0]?.id;

      for (const rule of relationshipType.rules ?? []) {
        const existingRule = await sql`
          SELECT id FROM entity_relationship_type_rules
          WHERE relationship_type_id = ${relationshipTypeId}
            AND source_entity_type_slug = ${rule.sourceEntityTypeSlug}
            AND target_entity_type_slug = ${rule.targetEntityTypeSlug}
            AND deleted_at IS NULL
          LIMIT 1
        `;
        if (existingRule.length > 0) continue;
        await sql`
          INSERT INTO entity_relationship_type_rules (
            relationship_type_id, source_entity_type_slug, target_entity_type_slug, created_at
          ) VALUES (
            ${relationshipTypeId}, ${rule.sourceEntityTypeSlug}, ${rule.targetEntityTypeSlug}, NOW()
          )
        `;
      }
    }
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const token = this.requireToken();
    const orgSlug = this.requireOrgSlug();
    const path = `/mcp/${orgSlug}`;
    const initResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__bench_init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'owletto-memory-benchmark', version: '1.0.0' },
        },
      },
      token,
    });
    const sessionId = initResponse.headers.get('mcp-session-id');
    if (!sessionId) {
      throw new Error(`Scoped MCP initialize did not return session id for ${path}`);
    }
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    this.sessionId = sessionId;
    return sessionId;
  }

  private async callTool<T = unknown>(
    name: string,
    arguments_: Record<string, unknown>
  ): Promise<T> {
    const token = this.requireToken();
    const orgSlug = this.requireOrgSlug();
    const sessionId = await this.ensureSession();
    const response = await post(`/mcp/${orgSlug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: arguments_ },
      },
      headers: { 'mcp-session-id': sessionId, 'X-MCP-Format': 'json' },
      token,
    });
    const json = await response.json();
    if (json.error) {
      throw new Error(`MCP Error [${json.error.code}]: ${json.error.message}`);
    }
    if (json.result?.isError) {
      throw new Error(json.result.content?.[0]?.text ?? 'Scoped MCP tool execution failed');
    }
    const text = json.result?.content?.[0]?.text;
    if (!text) return json.result as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private requireToken(): string {
    if (!this.token) throw new Error('Missing benchmark access token');
    return this.token;
  }

  private requireUserId(): string {
    if (!this.userId) throw new Error('Missing benchmark user id');
    return this.userId;
  }

  private requireOrgId(): string {
    if (!this.orgId) throw new Error('Missing benchmark org id');
    return this.orgId;
  }

  private requireOrgSlug(): string {
    if (!this.orgSlug) throw new Error('Missing benchmark org slug');
    return this.orgSlug;
  }

  private entityKey(runId: string, scenarioId: string, ref: string): string {
    return `${runId}::${scenarioId}::${ref}`;
  }

  private stepKey(runId: string, scenarioId: string, stepId: string): string {
    return `${runId}::${scenarioId}::${stepId}`;
  }

  private requireEntityId(runId: string, scenarioId: string, ref: string): number {
    const entityId = this.entityIds.get(this.entityKey(runId, scenarioId, ref));
    if (!entityId) throw new Error(`Missing entity '${ref}' in scenario '${scenarioId}'`);
    return entityId;
  }

  private requireStepEventId(runId: string, scenarioId: string, stepId: string): number {
    const eventId = this.eventIds.get(this.stepKey(runId, scenarioId, stepId));
    if (!eventId) throw new Error(`Missing event '${stepId}' in scenario '${scenarioId}'`);
    return eventId;
  }

  private readBenchmarkStepId(metadata: Record<string, unknown> | null | undefined): string | null {
    const stepId = metadata?.benchmark_step_id;
    return typeof stepId === 'string' && stepId.length > 0 ? stepId : null;
  }
}
