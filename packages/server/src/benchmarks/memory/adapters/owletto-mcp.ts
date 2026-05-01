import { performance } from 'node:perf_hooks';
import { McpJsonClient } from '../mcp-client';
import type {
  BenchmarkAdapter,
  BenchmarkRelationshipType,
  BenchmarkSuite,
  OwlettoMcpSystemConfig,
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

export class OwlettoMcpBenchmarkAdapter implements BenchmarkAdapter {
  readonly id: string;
  readonly label: string;

  private readonly client: McpJsonClient;
  private readonly entityIds = new Map<string, number>();
  private readonly eventIds = new Map<string, number>();

  constructor(private readonly config: OwlettoMcpSystemConfig) {
    this.id = config.id;
    this.label = config.label;
    const token = config.tokenEnv ? process.env[config.tokenEnv] : undefined;
    this.client = new McpJsonClient(config.mcpUrl, token);
  }

  async reset(_ctx: TrialContext): Promise<void> {
    this.entityIds.clear();
    this.eventIds.clear();
  }

  async setup(ctx: TrialContext): Promise<void> {
    await this.ensureEntityTypes(ctx.suite);
    await this.ensureRelationshipTypes(ctx.suite);
  }

  async ingestScenario(ctx: ScenarioContext): Promise<void> {
    for (const entity of ctx.scenario.entities) {
      const result = await this.client.callTool<ManageEntityCreateResult>('manage_entity', {
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
        const saveResult = await this.client.callTool<SaveKnowledgeResult>('save_knowledge', {
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
        continue;
      }

      await this.client.callTool('manage_entity', {
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
  }

  async retrieve(ctx: RetrieveContext): Promise<RetrievalResult> {
    const startedAt = performance.now();
    const entityIds = new Set<number>();

    const readLimit = this.config.readLimit ?? this.config.topK ?? 8;
    const linkLimit = this.config.linkLimit ?? this.config.topK ?? 8;
    const retrieved = new Map<string, RetrievedMemory>();
    const chronologicalSortOrder = isHistoricalLookup(ctx.prompt) ? 'asc' : 'desc';
    const includeSuperseded = isHistoricalLookup(ctx.prompt);

    const search = await this.client.callTool<SearchKnowledgeResult>('search_knowledge', {
      query: ctx.prompt,
      include_content: false,
      fuzzy: true,
      limit: this.config.searchLimit ?? 5,
      metadata_filter: {
        benchmark_run_id: ctx.runId,
        benchmark_scenario_id: ctx.scenarioId,
      },
    });
    if (typeof search.entity?.id === 'number') entityIds.add(search.entity.id);
    for (const match of search.matches ?? []) {
      if (typeof match.id === 'number') entityIds.add(match.id);
    }

    const globalContent = await this.client.callTool<ReadKnowledgeResult>('read_knowledge', {
      query: ctx.prompt,
      limit: readLimit,
    });
    for (const item of globalContent.content ?? []) {
      const benchmarkStepId = this.readBenchmarkStepId(item.metadata);
      if (!benchmarkStepId || retrieved.has(benchmarkStepId)) continue;
      if (
        item.metadata?.benchmark_run_id !== ctx.runId ||
        item.metadata?.benchmark_scenario_id !== ctx.scenarioId
      ) {
        continue;
      }
      retrieved.set(benchmarkStepId, {
        id: benchmarkStepId,
        text: item.text_content,
        score: item.combined_score ?? item.similarity ?? 0.5,
        sourceType: 'memory',
        metadata: item.metadata,
      });
    }

    for (const entityId of entityIds) {
      if (retrieved.size < ctx.topK) {
        const scopedContent = await this.client.callTool<ReadKnowledgeResult>('read_knowledge', {
          entity_id: entityId,
          query: ctx.prompt,
          limit: Math.max(1, Math.min(readLimit, ctx.topK)),
        });

        for (const item of scopedContent.content ?? []) {
          const benchmarkStepId = this.readBenchmarkStepId(item.metadata);
          if (!benchmarkStepId || retrieved.has(benchmarkStepId)) continue;
          if (
            item.metadata?.benchmark_run_id !== ctx.runId ||
            item.metadata?.benchmark_scenario_id !== ctx.scenarioId
          ) {
            continue;
          }
          retrieved.set(benchmarkStepId, {
            id: benchmarkStepId,
            text: item.text_content,
            score: item.combined_score ?? item.similarity ?? 0.5,
            sourceType: 'memory',
            metadata: item.metadata,
          });
        }
      }

      if (includeSuperseded || retrieved.size < ctx.topK) {
        const content = await this.client.callTool<ReadKnowledgeResult>('read_knowledge', {
          entity_id: entityId,
          limit: Math.max(1, Math.min(readLimit, ctx.topK)),
          sort_by: 'date',
          sort_order: chronologicalSortOrder,
          include_superseded: includeSuperseded,
        } as Record<string, unknown>);

        for (const item of content.content ?? []) {
          const benchmarkStepId = this.readBenchmarkStepId(item.metadata);
          if (!benchmarkStepId || retrieved.has(benchmarkStepId)) continue;
          if (
            item.metadata?.benchmark_run_id !== ctx.runId ||
            item.metadata?.benchmark_scenario_id !== ctx.scenarioId
          ) {
            continue;
          }
          retrieved.set(benchmarkStepId, {
            id: benchmarkStepId,
            text: item.text_content,
            score: item.combined_score ?? item.similarity ?? 0.5,
            sourceType: 'memory',
            metadata: item.metadata,
          });
        }
      }

      if (retrieved.size >= ctx.topK) continue;

      const links = await this.client.callTool<ListLinksResult>('manage_entity', {
        action: 'list_links',
        entity_id: entityId,
        direction: 'both',
        limit: linkLimit,
      });

      for (const relationship of links.relationships ?? []) {
        const benchmarkStepId = this.readBenchmarkStepId(relationship.metadata);
        if (!benchmarkStepId || retrieved.has(benchmarkStepId)) continue;
        if (
          relationship.metadata?.benchmark_run_id !== ctx.runId ||
          relationship.metadata?.benchmark_scenario_id !== ctx.scenarioId
        ) {
          continue;
        }
        retrieved.set(benchmarkStepId, {
          id: benchmarkStepId,
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

    const items = [...retrieved.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, ctx.topK);

    return {
      items,
      latencyMs: performance.now() - startedAt,
      raw: { entityIds },
    };
  }

  private async ensureEntityTypes(suite: BenchmarkSuite): Promise<void> {
    for (const entityType of suite.entityTypes) {
      const existing = await this.client.callTool<{
        schema_type: 'entity_type';
        entity_type: unknown | null;
      }>('manage_entity_schema', {
        schema_type: 'entity_type',
        action: 'get',
        slug: entityType.slug,
      });
      if (existing.entity_type) continue;

      await this.client.callTool('manage_entity_schema', {
        schema_type: 'entity_type',
        action: 'create',
        slug: entityType.slug,
        name: entityType.name,
        description: entityType.description,
        metadata_schema: entityType.metadataSchema,
        event_kinds: entityType.eventKinds,
      });
    }
  }

  private async ensureRelationshipTypes(suite: BenchmarkSuite): Promise<void> {
    for (const relationshipType of suite.relationshipTypes ?? []) {
      await this.ensureRelationshipType(relationshipType);
    }
  }

  private async ensureRelationshipType(relationshipType: BenchmarkRelationshipType): Promise<void> {
    const existing = await this.client.callTool<{
      schema_type: 'relationship_type';
      relationship_type: unknown | null;
    }>('manage_entity_schema', {
      schema_type: 'relationship_type',
      action: 'get',
      slug: relationshipType.slug,
    });

    if (!existing.relationship_type) {
      await this.client.callTool('manage_entity_schema', {
        schema_type: 'relationship_type',
        action: 'create',
        slug: relationshipType.slug,
        name: relationshipType.name,
        description: relationshipType.description,
        is_symmetric: relationshipType.isSymmetric ?? false,
        inverse_type_slug: relationshipType.inverseTypeSlug,
      });
    }

    const rulesResponse = await this.client.callTool<{
      schema_type: 'relationship_type';
      rules: Array<{ source_entity_type_slug: string; target_entity_type_slug: string }>;
    }>('manage_entity_schema', {
      schema_type: 'relationship_type',
      action: 'list_rules',
      slug: relationshipType.slug,
    });

    const existingRules = new Set(
      (rulesResponse.rules ?? []).map(
        (rule) => `${rule.source_entity_type_slug}::${rule.target_entity_type_slug}`
      )
    );

    for (const rule of relationshipType.rules ?? []) {
      const key = `${rule.sourceEntityTypeSlug}::${rule.targetEntityTypeSlug}`;
      if (existingRules.has(key)) continue;
      await this.client.callTool('manage_entity_schema', {
        schema_type: 'relationship_type',
        action: 'add_rule',
        slug: relationshipType.slug,
        source_entity_type_slug: rule.sourceEntityTypeSlug,
        target_entity_type_slug: rule.targetEntityTypeSlug,
      });
    }
  }

  private entityKey(runId: string, scenarioId: string, ref: string): string {
    return `${runId}::${scenarioId}::${ref}`;
  }

  private stepKey(runId: string, scenarioId: string, stepId: string): string {
    return `${runId}::${scenarioId}::${stepId}`;
  }

  private requireEntityId(runId: string, scenarioId: string, ref: string): number {
    const entityId = this.entityIds.get(this.entityKey(runId, scenarioId, ref));
    if (!entityId)
      throw new Error(`Missing benchmark entity '${ref}' for scenario '${scenarioId}'`);
    return entityId;
  }

  private requireStepEventId(runId: string, scenarioId: string, stepId: string): number {
    const eventId = this.eventIds.get(this.stepKey(runId, scenarioId, stepId));
    if (!eventId)
      throw new Error(`Missing benchmark event '${stepId}' for scenario '${scenarioId}'`);
    return eventId;
  }

  private readBenchmarkStepId(metadata: Record<string, unknown> | null | undefined): string | null {
    const value = metadata?.benchmark_step_id;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}
