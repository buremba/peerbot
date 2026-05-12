import type { McpToolResponse, ResolvedPluginConfig } from './types.js';

type PluginLogger = {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
};

type McpToolCallOptions = { rawJson?: boolean; signal?: AbortSignal };

type McpToolCaller = (
  config: ResolvedPluginConfig,
  toolName: string,
  args: Record<string, unknown>,
  options?: McpToolCallOptions
) => Promise<McpToolResponse | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type FanoutOutcome<T> =
  | { ok: true; value: T; durationMs: number }
  | { ok: false; reason: 'timeout' | 'error'; error: string; durationMs: number };

/**
 * Race a fanout part against a wall-clock timeout. Returns a tagged result so
 * callers can return partial responses (with a `degraded`/`timeouts` marker)
 * instead of letting one slow upstream block the whole wiki tool response.
 *
 * If the underlying MCP caller supports AbortSignal, the timeout also aborts
 * the in-flight request so CLI harnesses and long-lived plugin hosts don't
 * accumulate orphaned HTTP calls after returning a degraded partial result.
 */
async function raceFanout<T>(
  label: string,
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<FanoutOutcome<T>> {
  // Defensive: callers occasionally pass an unresolved or non-finite timeout
  // (e.g. a third-party config that didn't go through `resolveMemoryWikiCompatConfig`).
  // Fall back to a safe default rather than letting `setTimeout(undefined)` fire immediately.
  const safeTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 1
      ? Math.floor(timeoutMs)
      : 30_000;
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<FanoutOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(`${label} timed out after ${safeTimeoutMs}ms`);
      resolve({
        ok: false,
        reason: 'timeout',
        error: `${label} timed out after ${safeTimeoutMs}ms`,
        durationMs: Date.now() - started,
      });
    }, safeTimeoutMs);
  });
  const settled = start(controller.signal).then<FanoutOutcome<T>, FanoutOutcome<T>>(
    (value) => ({ ok: true, value, durationMs: Date.now() - started }),
    (error) => ({
      ok: false,
      reason: controller.signal.aborted ? 'timeout' : 'error',
      error:
        error instanceof Error
          ? error.message
          : typeof controller.signal.reason === 'string'
            ? controller.signal.reason
            : String(error),
      durationMs: Date.now() - started,
    })
  );
  try {
    return await Promise.race([settled, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function extractTextFromContent(content: Array<{ type: string; text: string }>): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

function parseJsonText<T = unknown>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

async function callMcpToolJson<T = unknown>(
  callMcpTool: McpToolCaller,
  config: ResolvedPluginConfig,
  toolName: string,
  args: Record<string, unknown>,
  options?: Pick<McpToolCallOptions, 'signal'>
): Promise<T | null> {
  const result = await callMcpTool(config, toolName, args, { rawJson: true, signal: options?.signal });
  if (!result) return null;
  if (result.isError) {
    throw new Error(`MCP tool ${toolName} returned error: ${extractTextFromContent(result.content).slice(0, 240)}`);
  }
  return parseJsonText<T>(extractTextFromContent(result.content));
}

/**
 * Execute a TypeScript snippet via the MCP `query_sdk` (read-only) or `run_sdk` (writes)
 * tool. INTERNAL_REST_TOOLS like list_watchers / read_knowledge / manage_watchers are not
 * exposed on the MCP wire (their `internal: true` flag hides them from tools/list); the
 * agent-facing path for these capabilities is to script over the ClientSDK.
 */
function stripMarkdownJsonFence(text: string): string {
  const fenced = text.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1] : text;
}

async function runSdkScript<T = unknown>(
  callMcpTool: McpToolCaller,
  config: ResolvedPluginConfig,
  mode: 'read' | 'write',
  script: string,
  options?: Pick<McpToolCallOptions, 'signal'>
): Promise<T | null> {
  const toolName = mode === 'read' ? 'query_sdk' : 'run_sdk';
  const raw = await callMcpTool(config, toolName, { script }, { rawJson: true, signal: options?.signal });
  if (!raw) return null;
  if (raw.isError) {
    throw new Error(`MCP tool ${toolName} returned error: ${extractTextFromContent(raw.content).slice(0, 240)}`);
  }
  // The sandbox tool returns its envelope wrapped in a ```json fenced block.
  const text = stripMarkdownJsonFence(extractTextFromContent(raw.content));
  const envelope = parseJsonText<{
    success?: boolean;
    error?: { name?: string; message?: string };
    return_value?: T;
  }>(text);
  if (envelope == null) return null;
  if (envelope.success === false) {
    const name = envelope.error?.name ?? 'SdkScriptError';
    const message = envelope.error?.message ?? 'sandbox script failed';
    throw new Error(`${toolName} reported ${name}: ${message}`);
  }
  // Real query_sdk wraps the script return in `return_value` (which may
  // legitimately be `null` when the script returns null); tests pass the
  // value directly in the response and rely on the fallback when the key
  // isn't present at all.
  if (Object.prototype.hasOwnProperty.call(envelope, 'return_value')) {
    return (envelope.return_value ?? null) as T;
  }
  return envelope as unknown as T;
}

type WikiCorpus = 'memory' | 'wiki' | 'all';

type WikiSearchResult = {
  corpus: 'memory' | 'wiki';
  path: string;
  title: string;
  kind: 'memory' | 'source' | 'claim' | 'synthesis' | 'report' | 'watcher';
  score: number;
  snippet: string;
  id?: string | number;
  source_url?: string | null;
  details?: Record<string, unknown>;
};

const WikiCorpusSchema = {
  type: 'string',
  enum: ['memory', 'wiki', 'all'],
};

const WikiSearchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1 },
    maxResults: { type: 'number', minimum: 1 },
    corpus: WikiCorpusSchema,
    backend: { type: 'string', enum: ['shared', 'local'] },
    mode: {
      type: 'string',
      enum: ['auto', 'find-person', 'route-question', 'source-evidence', 'raw-claim'],
    },
  },
  required: ['query'],
};

const MemorySearchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1 },
    maxResults: { type: 'number', minimum: 1 },
  },
  required: ['query'],
};

const WikiGetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lookup: { type: 'string', minLength: 1 },
    fromLine: { type: 'number', minimum: 1 },
    lineCount: { type: 'number', minimum: 1 },
    corpus: WikiCorpusSchema,
    backend: { type: 'string', enum: ['shared', 'local'] },
  },
  required: ['lookup'],
};

const WikiApplySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    op: { type: 'string', enum: ['create_synthesis', 'update_metadata'] },
    title: { type: 'string' },
    body: { type: 'string' },
    lookup: { type: 'string' },
    sourceIds: { type: 'array', items: { type: 'string' } },
    claims: { type: 'array', items: { type: 'object', additionalProperties: true } },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    status: { type: 'string' },
    watcher_id: { type: ['string', 'number'] },
    window_id: { type: 'number' },
    corrections: { type: 'array', items: { type: 'object', additionalProperties: true } },
    metadata: { type: 'object', additionalProperties: true },
  },
  required: ['op'],
};

function normalizeCorpus(value: unknown): WikiCorpus {
  return value === 'memory' || value === 'wiki' || value === 'all' ? value : 'wiki';
}

function readPositiveNumber(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

function stringifyResult(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function pickSnippet(value: unknown, maxLength = 280): string {
  const text = typeof value === 'string' ? value : value == null ? '' : stringifyResult(value);
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function matchesQuery(row: Record<string, unknown>, query: string): boolean {
  const lower = query.toLowerCase();
  return ['name', 'watcher_name', 'slug', 'description', 'title', 'summary']
    .map((key) => row[key])
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(lower));
}

function memoryResultsFromSearch(raw: unknown, maxResults: number): WikiSearchResult[] {
  if (!isRecord(raw)) return [];
  const results: WikiSearchResult[] = [];
  for (const item of asObjectArray(raw.content).slice(0, maxResults)) {
    const id = item.id;
    const title =
      typeof item.title === 'string' && item.title.trim()
        ? item.title.trim()
        : `Memory item ${String(id ?? results.length + 1)}`;
    results.push({
      corpus: 'memory',
      path: id != null ? `sources/events/${String(id)}` : `sources/memory/${results.length + 1}`,
      title,
      kind: 'source',
      score: typeof item.similarity === 'number' ? item.similarity : 0.5,
      snippet: pickSnippet(item.text_content ?? item.payload_text ?? item.content ?? item.metadata),
      id: typeof id === 'number' || typeof id === 'string' ? id : undefined,
      source_url: typeof item.source_url === 'string' ? item.source_url : null,
      details: { source: 'search_memory.content' },
    });
  }
  for (const item of asObjectArray(raw.matches).slice(0, Math.max(0, maxResults - results.length))) {
    const id = item.id;
    const name = typeof item.name === 'string' ? item.name : `Entity ${String(id ?? '')}`.trim();
    results.push({
      corpus: 'memory',
      path: id != null ? `entities/${String(id)}` : `entities/${name}`,
      title: name,
      kind: 'memory',
      score: typeof item.match_score === 'number' ? item.match_score : 0.4,
      snippet: pickSnippet(item.metadata ?? item.content ?? item.match_reason),
      id: typeof id === 'number' || typeof id === 'string' ? id : undefined,
      details: { source: 'search_memory.matches', entity_type: item.type ?? item.entity_type },
    });
  }
  return results.slice(0, maxResults);
}

async function searchMemoryCorpus(
  callMcpTool: McpToolCaller,
  config: ResolvedPluginConfig,
  query: string,
  maxResults: number,
  options?: Pick<McpToolCallOptions, 'signal'>
): Promise<WikiSearchResult[]> {
  const raw = await callMcpToolJson(callMcpTool, config, 'search_memory', {
    query,
    include_content: true,
    content_limit: maxResults,
    include_connections: false,
    limit: maxResults,
  }, options);
  return memoryResultsFromSearch(raw, maxResults);
}

function watcherResultsFromList(raw: unknown, query: string, maxResults: number): WikiSearchResult[] {
  const watchers = isRecord(raw) ? asObjectArray(raw.watchers) : [];
  const scored = watchers
    .map((watcher) => {
      const watcherId = watcher.watcher_id ?? watcher.id;
      const title =
        typeof watcher.watcher_name === 'string'
          ? watcher.watcher_name
          : typeof watcher.name === 'string'
            ? watcher.name
            : `Watcher ${String(watcherId ?? '')}`.trim();
      const haystackMatch = matchesQuery({ ...watcher, title }, query);
      const pending = typeof watcher.pending_content_count === 'number' ? watcher.pending_content_count : 0;
      const historical =
        typeof watcher.historical_content_count === 'number' ? watcher.historical_content_count : 0;
      return {
        result: {
          corpus: 'wiki' as const,
          path: watcherId != null ? `reports/watchers/${String(watcherId)}` : `reports/watchers/${title}`,
          title,
          kind: 'report' as const,
          score: haystackMatch ? 0.8 : historical > 0 ? 0.35 : 0.2,
          snippet: pickSnippet(
            watcher.description ??
              watcher.slug ??
              `${historical} historical items, ${pending} pending analysis`
          ),
          id: typeof watcherId === 'number' || typeof watcherId === 'string' ? watcherId : undefined,
          source_url: typeof watcher.view_url === 'string' ? watcher.view_url : null,
          details: {
            source: 'client.watchers.list',
            pending_content_count: pending,
            historical_content_count: historical,
          },
        },
        include: haystackMatch || query.trim().length === 0,
      };
    })
    .filter((entry) => entry.include)
    .map((entry) => entry.result)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

function contentResultsFromReadKnowledge(
  raw: unknown,
  semanticType: 'claim' | 'synthesis',
  maxResults: number
): WikiSearchResult[] {
  if (!isRecord(raw)) return [];
  return asObjectArray(raw.content)
    .slice(0, maxResults)
    .map((item, index) => {
      const id = item.id;
      const title =
        typeof item.title === 'string' && item.title.trim()
          ? item.title.trim()
          : `${semanticType[0].toUpperCase()}${semanticType.slice(1)} ${String(id ?? index + 1)}`;
      return {
        corpus: 'wiki' as const,
        path:
          semanticType === 'claim'
            ? `claims/${String(id ?? index + 1)}`
            : `syntheses/${String(id ?? index + 1)}`,
        title,
        kind: semanticType,
        score: 0.7,
        snippet: pickSnippet(item.text_content ?? item.payload_text ?? item.content ?? item.metadata),
        id: typeof id === 'number' || typeof id === 'string' ? id : undefined,
        source_url: typeof item.source_url === 'string' ? item.source_url : null,
        details: { source: 'client.knowledge.read', semantic_type: semanticType },
      };
    });
}

async function searchWikiCorpus(
  callMcpTool: McpToolCaller,
  config: ResolvedPluginConfig,
  query: string,
  maxResults: number,
  options?: Pick<McpToolCallOptions, 'signal'>
): Promise<WikiSearchResult[]> {
  const includeContent = query.length >= 3;
  const script = `
export default async (_ctx, client) => {
  const query = ${JSON.stringify(query)};
  const limit = ${maxResults};
  const includeContent = ${includeContent};
  const [watchers, claims, syntheses] = await Promise.all([
    client.watchers.list({ include_details: false }).catch((e) => ({ error: String(e) })),
    includeContent
      ? client.knowledge.read({ query, semantic_type: 'claim', limit }).catch((e) => ({ error: String(e) }))
      : null,
    includeContent
      ? client.knowledge.read({ query, semantic_type: 'synthesis', limit }).catch((e) => ({ error: String(e) }))
      : null,
  ]);
  return { watchers, claims, syntheses };
};
`;
  const sdkResult = await runSdkScript<{
    watchers: unknown;
    claims: unknown;
    syntheses: unknown;
  }>(callMcpTool, config, 'read', script, options);
  if (!sdkResult) return [];
  return [
    ...contentResultsFromReadKnowledge(sdkResult.claims, 'claim', maxResults),
    ...contentResultsFromReadKnowledge(sdkResult.syntheses, 'synthesis', maxResults),
    ...watcherResultsFromList(sdkResult.watchers, query, maxResults),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function formatWikiSearchResults(
  query: string,
  corpus: WikiCorpus,
  results: WikiSearchResult[],
  meta: { degraded: boolean; timeouts: string[] } = { degraded: false, timeouts: [] }
): string {
  const degradedSuffix = meta.degraded
    ? `\nWarning: partial results — fanout ${meta.timeouts.length ? `timed out on [${meta.timeouts.join(', ')}]` : 'reported errors'}.`
    : '';
  if (results.length === 0) {
    return `No Lobu wiki compatibility results for ${JSON.stringify(query)} in corpus=${corpus}.${degradedSuffix}`;
  }
  return (
    [
      `Lobu memory-wiki compatibility search for ${JSON.stringify(query)} (corpus=${corpus}).`,
      ...results.map((result, index) => {
        const source = result.source_url ? ` — ${result.source_url}` : '';
        return `${index + 1}. ${result.title} (${result.corpus}/${result.kind}, path=${result.path}, score=${result.score.toFixed(2)})${source}\n   ${result.snippet}`;
      }),
    ].join('\n') + degradedSuffix
  );
}

async function runWikiSearch(
  callMcpTool: McpToolCaller,
  config: ResolvedPluginConfig,
  args: Record<string, unknown>
): Promise<{ text: string; details: Record<string, unknown> }> {
  const query = asString(args.query) ?? '';
  const corpus = normalizeCorpus(args.corpus);
  const maxResults = readPositiveNumber(args.maxResults, 8, 25);
  const timeoutMs = config.memoryWikiCompat.fanoutTimeoutMs;
  const wantMemory = corpus === 'memory' || corpus === 'all';
  const wantWiki = corpus === 'wiki' || corpus === 'all';
  const [memoryOutcome, wikiOutcome] = await Promise.all([
    wantMemory
      ? raceFanout(
          'wiki_search:memory',
          (signal) => searchMemoryCorpus(callMcpTool, config, query, maxResults, { signal }),
          timeoutMs
        )
      : Promise.resolve<FanoutOutcome<WikiSearchResult[]>>({ ok: true, value: [], durationMs: 0 }),
    wantWiki
      ? raceFanout(
          'wiki_search:wiki',
          (signal) => searchWikiCorpus(callMcpTool, config, query, maxResults, { signal }),
          timeoutMs
        )
      : Promise.resolve<FanoutOutcome<WikiSearchResult[]>>({ ok: true, value: [], durationMs: 0 }),
  ]);
  const memory = memoryOutcome.ok ? memoryOutcome.value : [];
  const wiki = wikiOutcome.ok ? wikiOutcome.value : [];
  const results = [...wiki, ...memory].sort((a, b) => b.score - a.score).slice(0, maxResults);
  const timeouts: string[] = [];
  const fanoutErrors: Array<{ part: string; reason: string; error: string }> = [];
  if (wantMemory && !memoryOutcome.ok) {
    if (memoryOutcome.reason === 'timeout') timeouts.push('memory');
    fanoutErrors.push({ part: 'memory', reason: memoryOutcome.reason, error: memoryOutcome.error });
  }
  if (wantWiki && !wikiOutcome.ok) {
    if (wikiOutcome.reason === 'timeout') timeouts.push('wiki');
    fanoutErrors.push({ part: 'wiki', reason: wikiOutcome.reason, error: wikiOutcome.error });
  }
  const degraded = fanoutErrors.length > 0;
  return {
    text: formatWikiSearchResults(query, corpus, results, { degraded, timeouts }),
    details: { query, corpus, results, degraded, timeouts, fanout_errors: fanoutErrors },
  };
}

function parseWikiLookup(lookup: string): { kind: string; id?: number; raw: string } {
  const trimmed = lookup.trim();
  const prefixed = trimmed.match(/^(event|content|source|watcher|window|claim|synthesis):(.+)$/i);
  if (prefixed) {
    const id = Number(prefixed[2]);
    return { kind: prefixed[1].toLowerCase(), id: Number.isFinite(id) ? id : undefined, raw: trimmed };
  }
  const pathMatch = trimmed.match(/(?:events|sources\/events|watchers|reports\/watchers|windows|claims|syntheses)\/(\d+)/i);
  if (pathMatch) {
    const lower = trimmed.toLowerCase();
    const kind = lower.includes('watcher') ? 'watcher' : lower.includes('window') ? 'window' : 'event';
    return { kind, id: Number(pathMatch[1]), raw: trimmed };
  }
  const numeric = Number(trimmed);
  return { kind: Number.isFinite(numeric) ? 'event' : 'query', id: Number.isFinite(numeric) ? numeric : undefined, raw: trimmed };
}

async function runWikiGet(
  callMcpTool: McpToolCaller,
  config: ResolvedPluginConfig,
  args: Record<string, unknown>
): Promise<{ text: string; details: Record<string, unknown> }> {
  const lookup = asString(args.lookup) ?? '';
  const lineCount = readPositiveNumber(args.lineCount, 80, 500);
  const parsed = parseWikiLookup(lookup);
  let script = '';
  let sourceTool = 'client.knowledge.read';

  if (parsed.kind === 'watcher' && parsed.id != null) {
    sourceTool = 'client.watchers.get';
    script = `export default async (_ctx, client) => client.watchers.get(${JSON.stringify(String(parsed.id))});`;
  } else if (parsed.kind === 'window' && parsed.id != null) {
    script = `export default async (_ctx, client) => client.knowledge.read({ window_id: ${parsed.id}, limit: ${lineCount} });`;
  } else if (parsed.id != null) {
    script = `export default async (_ctx, client) => client.knowledge.read({ content_ids: [${parsed.id}], limit: ${lineCount} });`;
  } else {
    script = `export default async (_ctx, client) => client.knowledge.read({ query: ${JSON.stringify(lookup)}, limit: 1 });`;
  }

  const outcome = await raceFanout(
    'wiki_get',
    (signal) => runSdkScript<unknown>(callMcpTool, config, 'read', script, { signal }),
    config.memoryWikiCompat.fanoutTimeoutMs
  );
  if (!outcome.ok) {
    const reason = outcome.reason === 'timeout' ? 'timeout' : 'error';
    return {
      text: `Lobu memory-wiki compatibility get (${sourceTool}, lookup=${lookup}) — ${reason}: ${outcome.error}`,
      details: {
        lookup,
        parsed,
        sourceTool,
        result: null,
        degraded: true,
        timeout: outcome.reason === 'timeout',
        error: outcome.error,
      },
    };
  }
  const raw = outcome.value;
  const text = stringifyResult(raw ?? { message: `No result for ${lookup}` });
  return {
    text: `Lobu memory-wiki compatibility get (${sourceTool}, lookup=${lookup})\n\n${text}`,
    details: { lookup, parsed, sourceTool, result: raw },
  };
}

async function runWikiApply(
  callMcpTool: McpToolCaller,
  config: ResolvedPluginConfig,
  args: Record<string, unknown>
): Promise<{ text: string; details: Record<string, unknown> }> {
  const op = asString(args.op);
  if (op === 'create_synthesis') {
    const title = asString(args.title) ?? 'Untitled synthesis';
    const body = asString(args.body) ?? '';
    const metadata = isRecord(args.metadata) ? args.metadata : {};
    const result = await callMcpToolJson(callMcpTool, config, 'save_memory', {
      title,
      content: body || title,
      semantic_type: 'synthesis',
      payload_type: body ? 'markdown' : 'text',
      metadata: {
        ...metadata,
        memory_wiki_compat: true,
        source_ids: Array.isArray(args.sourceIds) ? args.sourceIds : [],
        claims: Array.isArray(args.claims) ? args.claims : [],
        confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
        status: asString(args.status) ?? 'active',
      },
    });
    return {
      text: `Created Lobu-backed synthesis via save_memory.\n\n${stringifyResult(result)}`,
      details: { op, sourceTool: 'save_memory', result },
    };
  }

  if (op === 'update_metadata') {
    const watcherId = args.watcher_id ?? args.watcherId;
    const windowId = args.window_id ?? args.windowId;
    const corrections = Array.isArray(args.corrections) ? args.corrections : null;
    const looksLikeWatcherFeedback =
      (typeof watcherId === 'string' || typeof watcherId === 'number') &&
      typeof windowId === 'number' &&
      corrections !== null;
    if (looksLikeWatcherFeedback) {
      const invalid = corrections!.filter(
        (c): c is Record<string, unknown> =>
          !isRecord(c) || typeof c.field_path !== 'string' || c.field_path.trim().length === 0
      );
      if (corrections!.length === 0) {
        throw new Error('wiki_apply update_metadata: corrections must be a non-empty array');
      }
      if (invalid.length > 0) {
        throw new Error(
          `wiki_apply update_metadata: ${invalid.length} correction(s) missing required "field_path" string`
        );
      }
      const script = `export default async (_ctx, client) => client.watchers.submitFeedback(${JSON.stringify({
        watcher_id: String(watcherId),
        window_id: windowId,
        corrections,
      })});`;
      const result = await runSdkScript(callMcpTool, config, 'write', script);
      return {
        text: `Submitted watcher feedback via client.watchers.submitFeedback.\n\n${stringifyResult(result)}`,
        details: { op, sourceTool: 'client.watchers.submitFeedback', result },
      };
    }

    const result = await callMcpToolJson(callMcpTool, config, 'save_memory', {
      title: asString(args.title) ?? `Wiki metadata update: ${asString(args.lookup) ?? 'unknown'}`,
      content: asString(args.body) ?? stringifyResult(args),
      semantic_type: 'claim',
      metadata: {
        memory_wiki_compat: true,
        op,
        lookup: asString(args.lookup),
        status: asString(args.status) ?? 'review',
        confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
        source_ids: Array.isArray(args.sourceIds) ? args.sourceIds : [],
        claims: Array.isArray(args.claims) ? args.claims : [],
      },
    });
    return {
      text: `Stored metadata update as a Lobu-backed claim event.\n\n${stringifyResult(result)}`,
      details: { op, sourceTool: 'save_memory', result },
    };
  }

  throw new Error('wiki_apply supports op="create_synthesis" and op="update_metadata" in Lobu compat mode.');
}

type SessionCall = {
  tool: string;
  at: number;
  argsSummary: Record<string, unknown>;
  outcome: Record<string, unknown>;
};

const SESSION_BUFFER_CAP = 32;

// Agent tools registered by registerMemoryWikiCompatTools() when memoryWikiCompat
// is enabled. OpenClaw 2026.5.x requires these to appear in `contracts.tools` in
// openclaw.plugin.json — a unit test enforces the manifest stays in sync.
export const MEMORY_WIKI_COMPAT_TOOL_NAMES = [
  'wiki_status',
  'wiki_search',
  'wiki_get',
  'wiki_apply',
  'wiki_lint',
  'memory_search',
  'memory_get',
] as const;

export function registerMemoryWikiCompatTools(
  config: ResolvedPluginConfig,
  registerTool: (def: Record<string, unknown>) => void,
  log: PluginLogger,
  callMcpTool: McpToolCaller
): void {
  if (!config.memoryWikiCompat.enabled) return;
  if (!config.mcpUrl) {
    log.warn('lobu: memoryWikiCompat enabled but mcpUrl is missing; wiki_* tools not registered');
    return;
  }

  const sessionCalls: SessionCall[] = [];
  const recordCall = (
    tool: string,
    argsSummary: Record<string, unknown>,
    outcome: Record<string, unknown>
  ): void => {
    sessionCalls.push({ tool, at: Date.now(), argsSummary, outcome });
    if (sessionCalls.length > SESSION_BUFFER_CAP) {
      sessionCalls.splice(0, sessionCalls.length - SESSION_BUFFER_CAP);
    }
  };

  const registerTextTool = (
    name: string,
    label: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, unknown>) => Promise<{ text: string; details: Record<string, unknown> }>
  ) => {
    registerTool({
      name,
      label,
      description,
      parameters,
      execute: async (_id: string, args: Record<string, unknown>) => {
        const result = await execute(args ?? {});
        return { content: [{ type: 'text', text: result.text }], details: result.details };
      },
    });
  };

  registerTextTool(
    'wiki_status',
    'Wiki Status',
    'Inspect Lobu-backed OpenClaw memory-wiki compatibility status. This is a compatibility layer, not a separate wiki source of truth.',
    { type: 'object', additionalProperties: false, properties: {} },
    async () => {
      const watcherCountScript = `export default async (_ctx, client) => {
  const r = await client.watchers.list({ include_details: false }).catch((e) => ({ error: String(e) }));
  return r;
};`;
      const timeoutMs = config.memoryWikiCompat.fanoutTimeoutMs;
      const [watchersOutcome, memoryOutcome] = await Promise.all([
        raceFanout(
          'wiki_status:watchers',
          (signal) => runSdkScript<unknown>(callMcpTool, config, 'read', watcherCountScript, { signal }),
          timeoutMs
        ),
        raceFanout(
          'wiki_status:memory',
          (signal) => callMcpToolJson(callMcpTool, config, 'search_memory', {
            query: 'memory wiki compatibility status',
            include_content: false,
            include_connections: false,
            limit: 1,
          }, { signal }),
          timeoutMs
        ),
      ]);
      const watchers = watchersOutcome.ok ? watchersOutcome.value : null;
      const watcherCount =
        isRecord(watchers) && Array.isArray((watchers as { watchers?: unknown }).watchers)
          ? ((watchers as { watchers: unknown[] }).watchers.length)
          : null;
      const timeouts: string[] = [];
      const fanoutErrors: Array<{ part: string; reason: string; error: string }> = [];
      if (!watchersOutcome.ok) {
        if (watchersOutcome.reason === 'timeout') timeouts.push('watchers');
        fanoutErrors.push({ part: 'watchers', reason: watchersOutcome.reason, error: watchersOutcome.error });
      }
      if (!memoryOutcome.ok) {
        if (memoryOutcome.reason === 'timeout') timeouts.push('memory');
        fanoutErrors.push({ part: 'memory', reason: memoryOutcome.reason, error: memoryOutcome.error });
      }
      const status = {
        mode: 'lobu-memory-wiki-compat',
        source_of_truth: 'lobu-memory-mcp',
        corpus: ['memory', 'wiki', 'all'],
        tools: ['wiki_status', 'wiki_search', 'wiki_get', 'wiki_apply', 'wiki_lint', 'memory_search', 'memory_get'],
        watcher_count: watcherCount,
        memory_available: memoryOutcome.ok,
        degraded: !watchersOutcome.ok || !memoryOutcome.ok,
        timeouts,
        fanout_errors: fanoutErrors,
        fanout_timeout_ms: timeoutMs,
        notes: [
          'corpus is memory|wiki|all within the authenticated Lobu org; it is not an org selector.',
          'wiki corpus is a virtual projection over Lobu claims, syntheses, watchers, reports, and sources.',
          'no separate Markdown vault is written by this spike.',
        ],
      };
      recordCall(
        'wiki_status',
        {},
        { watcherCount, memoryAvailable: status.memory_available, degraded: status.degraded }
      );
      return { text: stringifyResult(status), details: status };
    }
  );

  registerTextTool(
    'wiki_search',
    'Wiki Search',
    'Search Lobu memory-wiki compatibility corpus. corpus=memory searches raw Lobu memory; corpus=wiki searches claims/syntheses/watchers; corpus=all merges both.',
    WikiSearchSchema,
    async (args) => {
      const result = await runWikiSearch(callMcpTool, config, args);
      const results = Array.isArray(result.details.results) ? result.details.results : [];
      recordCall(
        'wiki_search',
        { query: result.details.query, corpus: result.details.corpus },
        { resultCount: results.length, kinds: results.map((r) => (isRecord(r) ? r.kind : undefined)) }
      );
      return result;
    }
  );

  registerTextTool(
    'wiki_get',
    'Wiki Get',
    'Read a Lobu-backed wiki compatibility result by path or lookup, e.g. sources/events/123, reports/watchers/7, watcher:7, window:9, event:123.',
    WikiGetSchema,
    async (args) => {
      const result = await runWikiGet(callMcpTool, config, args);
      recordCall(
        'wiki_get',
        { lookup: result.details.lookup, sourceTool: result.details.sourceTool },
        { hadResult: result.details.result != null }
      );
      return result;
    }
  );

  registerTextTool(
    'wiki_apply',
    'Wiki Apply',
    'Apply a narrow memory-wiki compatible mutation backed by Lobu MCP. Supports create_synthesis via save_memory and update_metadata via watcher feedback or claim event.',
    WikiApplySchema,
    async (args) => {
      const result = await runWikiApply(callMcpTool, config, args);
      const hasEvidence =
        (Array.isArray(args.sourceIds) && args.sourceIds.length > 0) ||
        args.watcher_id != null ||
        args.watcherId != null ||
        args.window_id != null ||
        args.windowId != null ||
        (Array.isArray(args.claims) && args.claims.length > 0);
      recordCall(
        'wiki_apply',
        {
          op: asString(args.op),
          sourceTool: result.details.sourceTool,
          status: asString(args.status),
          confidence: typeof args.confidence === 'number' ? args.confidence : null,
        },
        { hasEvidence }
      );
      return result;
    }
  );

  registerTextTool(
    'wiki_lint',
    'Wiki Lint',
    'Lint the recent memory-wiki compatibility tool calls in this session for missing evidence, missing provenance, and low-confidence active claims.',
    { type: 'object', additionalProperties: false, properties: {} },
    async () => {
      const conventions = {
        required_provenance: ['event ids', 'watcher window ids', 'source URLs when available'],
        evidence_fields: ['sourceIds', 'watcher_id', 'window_id', 'claims'],
        confidence_floor_for_active: 0.5,
      };
      const warnings: Array<{ tool: string; at: number; reason: string; details: Record<string, unknown> }> = [];
      for (const call of sessionCalls) {
        if (call.tool === 'wiki_apply' && call.outcome.hasEvidence === false) {
          warnings.push({
            tool: call.tool,
            at: call.at,
            reason: 'wiki_apply written with no evidence (sourceIds/watcher_id/window_id/claims all empty)',
            details: call.argsSummary,
          });
        }
        if (
          call.tool === 'wiki_apply' &&
          call.argsSummary.status === 'active' &&
          typeof call.argsSummary.confidence === 'number' &&
          call.argsSummary.confidence < conventions.confidence_floor_for_active
        ) {
          warnings.push({
            tool: call.tool,
            at: call.at,
            reason: `wiki_apply status=active with confidence ${call.argsSummary.confidence} below floor ${conventions.confidence_floor_for_active}`,
            details: call.argsSummary,
          });
        }
        if (
          (call.tool === 'wiki_search' || call.tool === 'memory_search') &&
          call.outcome.resultCount === 0
        ) {
          warnings.push({
            tool: call.tool,
            at: call.at,
            reason: 'search returned zero results — agent may have queried with an off-vocabulary term',
            details: call.argsSummary,
          });
        }
      }
      const report = {
        ok: warnings.length === 0,
        observed_calls: sessionCalls.length,
        warnings,
        conventions,
      };
      return { text: stringifyResult(report), details: report };
    }
  );

  registerTextTool(
    'memory_search',
    'Memory Search',
    'OpenClaw compatibility alias for Lobu search_memory. Searches Lobu memory only — use wiki_search for corpus routing across wiki/all.',
    MemorySearchSchema,
    async (args) => {
      const query = asString(args.query) ?? '';
      const maxResults = readPositiveNumber(args.maxResults, 8, 25);
      const raw = await callMcpTool(config, 'search_memory', {
        query,
        include_content: true,
        content_limit: maxResults,
        include_connections: false,
        limit: maxResults,
      });
      const text = raw ? extractTextFromContent(raw.content) : '';
      // resultCount is the key wiki_lint reads to flag zero-result searches;
      // memory_search has no parsed structure to count, so approximate "0
      // results" as "empty text body" while keeping the same key shape as
      // wiki_search.
      recordCall('memory_search', { query, maxResults }, { resultCount: text.length > 0 ? 1 : 0 });
      return { text, details: { sourceTool: 'search_memory' } };
    }
  );

  registerTextTool(
    'memory_get',
    'Memory Get',
    'OpenClaw compatibility alias for Lobu read_knowledge.',
    WikiGetSchema,
    async (args) => {
      const result = await runWikiGet(callMcpTool, config, args);
      recordCall(
        'memory_get',
        { lookup: result.details.lookup, sourceTool: result.details.sourceTool },
        { hadResult: result.details.result != null }
      );
      return result;
    }
  );

  log.info('lobu: registered memory-wiki compatibility tools');
}
