import { describe, it, expect, beforeEach } from 'vitest';
import { registerMemoryWikiCompatTools } from '../../src/memory-wiki-compat.js';
import type { McpToolResponse, ResolvedPluginConfig } from '../../src/types.js';

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, args: Record<string, unknown>) => Promise<McpToolResponse & { details: Record<string, unknown> }>;
};

type FakeCall = { tool: string; args: Record<string, unknown>; options?: { signal?: AbortSignal } };

function makeConfig(overrides: Partial<ResolvedPluginConfig> = {}): ResolvedPluginConfig {
  const baseWikiCompat: ResolvedPluginConfig['memoryWikiCompat'] = {
    enabled: true,
    fanoutTimeoutMs: 30_000,
  };
  const overriddenWikiCompat = overrides.memoryWikiCompat
    ? { ...baseWikiCompat, ...overrides.memoryWikiCompat }
    : baseWikiCompat;
  return {
    mcpUrl: 'http://localhost:8787/mcp',
    webUrl: null,
    token: 'test-token',
    tokenCommand: null,
    gatewayAuthUrl: null,
    headers: {},
    autoRecall: false,
    autoCapture: false,
    recallLimit: 10,
    ...overrides,
    memoryWikiCompat: overriddenWikiCompat,
  };
}

function jsonContent(payload: unknown): McpToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: false,
  };
}

function noopLogger() {
  const logs: string[] = [];
  return {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
    error: (m: string) => logs.push(`error:${m}`),
    debug: (m: string) => logs.push(`debug:${m}`),
    logs,
  };
}

type Harness = {
  tools: Map<string, RegisteredTool>;
  calls: FakeCall[];
  responses: Map<string, McpToolResponse | null>;
  setResponse(tool: string, response: McpToolResponse | null): void;
  setDelay(tool: string, ms: number): void;
  invoke(name: string, args?: Record<string, unknown>): ReturnType<RegisteredTool['execute']>;
};

function makeHarness(overrideConfig: Partial<ResolvedPluginConfig> = {}): Harness {
  const tools = new Map<string, RegisteredTool>();
  const calls: FakeCall[] = [];
  const responses = new Map<string, McpToolResponse | null>();
  const delays = new Map<string, number>();
  const registerTool = (def: Record<string, unknown>): void => {
    tools.set(def.name as string, def as unknown as RegisteredTool);
  };
  const callMcpTool = async (
    _config: ResolvedPluginConfig,
    toolName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<McpToolResponse | null> => {
    calls.push({ tool: toolName, args, options });
    const delay = delays.get(toolName);
    if (delay && delay > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
    }
    return responses.has(toolName) ? (responses.get(toolName) ?? null) : null;
  };
  registerMemoryWikiCompatTools(makeConfig(overrideConfig), registerTool, noopLogger(), callMcpTool);
  return {
    tools,
    calls,
    responses,
    setResponse(tool, response) {
      responses.set(tool, response);
    },
    setDelay(tool, ms) {
      delays.set(tool, ms);
    },
    invoke(name, args = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.execute('call-1', args);
    },
  };
}

describe('memory-wiki-compat tool registration', () => {
  it('registers all wiki_* and memory_* tools when enabled', () => {
    const h = makeHarness();
    expect([...h.tools.keys()].sort()).toEqual(
      ['memory_get', 'memory_search', 'wiki_apply', 'wiki_get', 'wiki_lint', 'wiki_search', 'wiki_status'].sort()
    );
  });

  it('registers nothing when memoryWikiCompat.enabled=false', () => {
    const h = makeHarness({ memoryWikiCompat: { enabled: false } });
    expect(h.tools.size).toBe(0);
  });

  it('registers nothing when mcpUrl is missing', () => {
    const h = makeHarness({ mcpUrl: null });
    expect(h.tools.size).toBe(0);
  });
});

describe('wiki_status', () => {
  it('reports memory_available and watcher_count via query_sdk', async () => {
    const h = makeHarness();
    h.setResponse('query_sdk', jsonContent({ watchers: [{ watcher_id: 1 }, { watcher_id: 2 }] }));
    h.setResponse('search_memory', jsonContent({ content: [] }));
    const result = await h.invoke('wiki_status');
    const status = result.details as Record<string, unknown>;
    expect(status.watcher_count).toBe(2);
    expect(status.memory_available).toBe(true);
    expect(status.source_of_truth).toBe('lobu-memory-mcp');
    const sdkCall = h.calls.find((c) => c.tool === 'query_sdk');
    expect(sdkCall).toBeDefined();
    expect(String(sdkCall!.args.script)).toContain('client.watchers.list');
  });
});

describe('wiki_search corpus routing', () => {
  it('corpus=memory only calls search_memory', async () => {
    const h = makeHarness();
    h.setResponse('search_memory', jsonContent({ content: [{ id: 7, title: 'note', text_content: 'hello' }] }));
    const result = await h.invoke('wiki_search', { query: 'hello', corpus: 'memory' });
    const toolsHit = h.calls.map((c) => c.tool);
    expect(toolsHit).toContain('search_memory');
    expect(toolsHit).not.toContain('list_watchers');
    expect(toolsHit).not.toContain('read_knowledge');
    const results = (result.details as { results: unknown[] }).results;
    expect(results.length).toBeGreaterThan(0);
  });

  it('corpus=wiki fans out via query_sdk (one script with watchers.list + knowledge.read)', async () => {
    const h = makeHarness();
    h.setResponse(
      'query_sdk',
      jsonContent({
        watchers: { watchers: [{ watcher_id: 3, watcher_name: 'hello watcher', historical_content_count: 5 }] },
        claims: { content: [{ id: 11, title: 'a claim' }] },
        syntheses: { content: [] },
      })
    );
    const result = await h.invoke('wiki_search', { query: 'hello there', corpus: 'wiki' });
    const sdkCalls = h.calls.filter((c) => c.tool === 'query_sdk');
    expect(sdkCalls.length).toBe(1);
    const script = String(sdkCalls[0].args.script);
    expect(script).toContain('client.watchers.list');
    expect(script).toContain("semantic_type: 'claim'");
    expect(script).toContain("semantic_type: 'synthesis'");
    expect(h.calls.find((c) => c.tool === 'search_memory')).toBeUndefined();
    const results = (result.details as { results: Array<{ corpus: string }> }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.corpus === 'wiki')).toBe(true);
  });

  it('corpus=all merges search_memory + query_sdk; short queries embed includeContent=false', async () => {
    const h = makeHarness();
    h.setResponse('search_memory', jsonContent({ content: [{ id: 1, title: 'mem' }] }));
    h.setResponse('query_sdk', jsonContent({ watchers: { watchers: [] }, claims: null, syntheses: null }));
    await h.invoke('wiki_search', { query: 'hi', corpus: 'all' });
    const toolsHit = h.calls.map((c) => c.tool);
    expect(toolsHit).toContain('search_memory');
    expect(toolsHit).toContain('query_sdk');
    const script = String(h.calls.find((c) => c.tool === 'query_sdk')!.args.script);
    expect(script).toContain('includeContent = false');
  });
});

describe('upstream failures degrade gracefully', () => {
  it('wiki_search corpus=wiki returns degraded empty result when query_sdk returns isError', async () => {
    const h = makeHarness();
    h.setResponse('query_sdk', { content: [{ type: 'text', text: 'Tool not found: query_sdk' }], isError: true });
    const result = await h.invoke('wiki_search', { query: 'anything', corpus: 'wiki' });
    const details = result.details as {
      results: unknown[];
      degraded: boolean;
      fanout_errors: Array<{ part: string; reason: string; error: string }>;
    };
    expect(details.degraded).toBe(true);
    expect(details.results).toEqual([]);
    expect(details.fanout_errors[0]?.part).toBe('wiki');
    expect(details.fanout_errors[0]?.reason).toBe('error');
    expect(details.fanout_errors[0]?.error).toMatch(/query_sdk/);
  });

  it('wiki_get surfaces sandbox success=false envelope as a degraded error result (not a thrown exception)', async () => {
    const h = makeHarness();
    h.setResponse(
      'query_sdk',
      jsonContent({
        success: false,
        error: { name: 'RuntimeUnavailable', message: 'isolated-vm is not installed' },
      })
    );
    const result = await h.invoke('wiki_get', { lookup: 'watcher:42' });
    const details = result.details as Record<string, unknown>;
    expect(details.degraded).toBe(true);
    expect(details.timeout).toBe(false);
    expect(details.result).toBeNull();
    expect(String(details.error)).toMatch(/RuntimeUnavailable/);
  });

  it('wiki_get returns null cleanly when the SDK script return_value is explicitly null', async () => {
    const h = makeHarness();
    h.setResponse('query_sdk', jsonContent({ success: true, return_value: null }));
    const result = await h.invoke('wiki_get', { lookup: 'watcher:99' });
    // The result.details.result must be null, not the envelope object
    expect((result.details as { result: unknown }).result).toBeNull();
    expect(result.content[0].text).toContain('lookup=watcher:99');
  });
});

describe('wiki_get lookup parser (query_sdk)', () => {
  it('watcher:7 -> query_sdk with client.watchers.get("7")', async () => {
    const h = makeHarness();
    h.setResponse('query_sdk', jsonContent({ watcher_id: '7', name: 'demo' }));
    const result = await h.invoke('wiki_get', { lookup: 'watcher:7' });
    expect(h.calls[0].tool).toBe('query_sdk');
    expect(String(h.calls[0].args.script)).toContain('client.watchers.get("7")');
    expect((result.details as { sourceTool: string }).sourceTool).toBe('client.watchers.get');
  });

  it('window:9 -> query_sdk with client.knowledge.read({ window_id: 9 })', async () => {
    const h = makeHarness();
    h.setResponse('query_sdk', jsonContent({ content: [] }));
    await h.invoke('wiki_get', { lookup: 'window:9' });
    expect(h.calls[0].tool).toBe('query_sdk');
    expect(String(h.calls[0].args.script)).toMatch(/client\.knowledge\.read\(\{\s*window_id:\s*9/);
  });

  it('event:123 -> query_sdk with client.knowledge.read({ content_ids: [123] })', async () => {
    const h = makeHarness();
    h.setResponse('query_sdk', jsonContent({ content: [{ id: 123 }] }));
    await h.invoke('wiki_get', { lookup: 'event:123' });
    expect(h.calls[0].tool).toBe('query_sdk');
    expect(String(h.calls[0].args.script)).toContain('content_ids: [123]');
  });

  it('reports/watchers/4 path -> client.watchers.get', async () => {
    const h = makeHarness();
    h.setResponse('query_sdk', jsonContent({ watcher_id: '4' }));
    await h.invoke('wiki_get', { lookup: 'reports/watchers/4' });
    expect(String(h.calls[0].args.script)).toContain('client.watchers.get("4")');
  });

  it('plain natural-language lookup -> client.knowledge.read({ query }) fallback', async () => {
    const h = makeHarness();
    h.setResponse('query_sdk', jsonContent({ content: [] }));
    await h.invoke('wiki_get', { lookup: 'what did the watcher report on monday' });
    expect(h.calls[0].tool).toBe('query_sdk');
    expect(String(h.calls[0].args.script)).toContain('"what did the watcher report on monday"');
  });
});

describe('wiki_apply create_synthesis', () => {
  it('calls save_memory with semantic_type=synthesis and memory_wiki_compat metadata flag', async () => {
    const h = makeHarness();
    h.setResponse('save_memory', jsonContent({ id: 42 }));
    await h.invoke('wiki_apply', {
      op: 'create_synthesis',
      title: 'Weekly digest',
      body: 'Things happened',
      sourceIds: ['ev:1', 'ev:2'],
      confidence: 0.7,
    });
    expect(h.calls[0].tool).toBe('save_memory');
    const args = h.calls[0].args as { semantic_type: string; metadata: Record<string, unknown> };
    expect(args.semantic_type).toBe('synthesis');
    expect(args.metadata.memory_wiki_compat).toBe(true);
    expect(args.metadata.source_ids).toEqual(['ev:1', 'ev:2']);
    expect(args.metadata.confidence).toBe(0.7);
  });
});

describe('wiki_apply update_metadata', () => {
  it('routes well-formed corrections through run_sdk -> client.watchers.submitFeedback', async () => {
    const h = makeHarness();
    h.setResponse('run_sdk', jsonContent({ ok: true }));
    await h.invoke('wiki_apply', {
      op: 'update_metadata',
      watcher_id: 7,
      window_id: 12,
      corrections: [{ field_path: 'summary', value: 'better summary' }],
    });
    expect(h.calls[0].tool).toBe('run_sdk');
    const script = String(h.calls[0].args.script);
    expect(script).toContain('client.watchers.submitFeedback');
    expect(script).toContain('"watcher_id":"7"');
    expect(script).toContain('"window_id":12');
    expect(script).toContain('"field_path":"summary"');
  });

  it('throws when corrections array is empty', async () => {
    const h = makeHarness();
    await expect(
      h.invoke('wiki_apply', { op: 'update_metadata', watcher_id: 7, window_id: 12, corrections: [] })
    ).rejects.toThrow(/non-empty/);
    expect(h.calls.length).toBe(0);
  });

  it('throws when a correction is missing field_path', async () => {
    const h = makeHarness();
    await expect(
      h.invoke('wiki_apply', {
        op: 'update_metadata',
        watcher_id: 7,
        window_id: 12,
        corrections: [{ value: 'x' }],
      })
    ).rejects.toThrow(/field_path/);
    expect(h.calls.length).toBe(0);
  });

  it('falls back to save_memory claim when no watcher feedback fields are present', async () => {
    const h = makeHarness();
    h.setResponse('save_memory', jsonContent({ id: 99 }));
    await h.invoke('wiki_apply', {
      op: 'update_metadata',
      lookup: 'sources/events/5',
      body: 'this is now disputed',
      status: 'review',
    });
    expect(h.calls[0].tool).toBe('save_memory');
    const args = h.calls[0].args as { semantic_type: string; metadata: Record<string, unknown> };
    expect(args.semantic_type).toBe('claim');
    expect(args.metadata.status).toBe('review');
  });

  it('rejects unsupported ops with a clear error', async () => {
    const h = makeHarness();
    await expect(h.invoke('wiki_apply', { op: 'delete_everything' })).rejects.toThrow(/wiki_apply supports/);
  });
});

describe('memory_search alias', () => {
  it('calls search_memory and ignores corpus argument silently', async () => {
    const h = makeHarness();
    h.setResponse('search_memory', { content: [{ type: 'text', text: 'hello' }], isError: false });
    const result = await h.invoke('memory_search', { query: 'hello' });
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].tool).toBe('search_memory');
    expect(result.content[0].text).toBe('hello');
  });
});

describe('wiki_lint session-aware', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('reports ok=true with no calls', async () => {
    const result = await h.invoke('wiki_lint');
    const report = result.details as { ok: boolean; observed_calls: number };
    expect(report.ok).toBe(true);
    expect(report.observed_calls).toBe(0);
  });

  it('warns when wiki_apply was called without evidence', async () => {
    h.setResponse('save_memory', jsonContent({ id: 1 }));
    await h.invoke('wiki_apply', { op: 'create_synthesis', title: 't', body: 'b' });
    const result = await h.invoke('wiki_lint');
    const report = result.details as { ok: boolean; warnings: Array<{ reason: string }> };
    expect(report.ok).toBe(false);
    expect(report.warnings.some((w) => /no evidence/.test(w.reason))).toBe(true);
  });

  it('warns when wiki_apply status=active has low confidence', async () => {
    h.setResponse('save_memory', jsonContent({ id: 2 }));
    await h.invoke('wiki_apply', {
      op: 'create_synthesis',
      title: 't',
      body: 'b',
      sourceIds: ['ev:1'],
      status: 'active',
      confidence: 0.2,
    });
    const result = await h.invoke('wiki_lint');
    const report = result.details as { ok: boolean; warnings: Array<{ reason: string }> };
    expect(report.warnings.some((w) => /confidence/.test(w.reason))).toBe(true);
  });

  it('warns when wiki_search returns zero results', async () => {
    h.setResponse('search_memory', jsonContent({ content: [] }));
    h.setResponse('query_sdk', jsonContent({ watchers: { watchers: [] }, claims: null, syntheses: null }));
    await h.invoke('wiki_search', { query: 'nonexistent topic', corpus: 'all' });
    const result = await h.invoke('wiki_lint');
    const report = result.details as { warnings: Array<{ reason: string }> };
    expect(report.warnings.some((w) => /zero results/.test(w.reason))).toBe(true);
  });

  it('warns when memory_search returns zero results (matches wiki_search behaviour)', async () => {
    h.setResponse('search_memory', { content: [{ type: 'text', text: '' }], isError: false });
    await h.invoke('memory_search', { query: 'no hits' });
    const result = await h.invoke('wiki_lint');
    const report = result.details as { warnings: Array<{ tool: string; reason: string }> };
    expect(report.warnings.some((w) => w.tool === 'memory_search' && /zero results/.test(w.reason))).toBe(true);
  });

  it('does NOT flag wiki_apply update_metadata with camelCase watcherId/windowId as missing evidence', async () => {
    h.setResponse('run_sdk', jsonContent({ success: true, return_value: { ok: true } }));
    await h.invoke('wiki_apply', {
      op: 'update_metadata',
      watcherId: 7,
      windowId: 12,
      corrections: [{ field_path: 'summary', value: 'x' }],
    });
    const result = await h.invoke('wiki_lint');
    const report = result.details as { warnings: Array<{ reason: string }> };
    expect(report.warnings.every((w) => !/no evidence/.test(w.reason))).toBe(true);
  });
});

describe('fanout timeout (slow upstreams do not block whole tool call)', () => {
  it('wiki_status returns partial status when watchers fanout times out', async () => {
    const h = makeHarness({ memoryWikiCompat: { enabled: true, fanoutTimeoutMs: 50 } });
    h.setResponse('query_sdk', jsonContent({ watchers: [{ watcher_id: 1 }] }));
    h.setDelay('query_sdk', 200);
    h.setResponse('search_memory', jsonContent({ content: [] }));

    const started = Date.now();
    const result = await h.invoke('wiki_status');
    const elapsed = Date.now() - started;

    const status = result.details as Record<string, unknown>;
    expect(elapsed).toBeLessThan(180);
    expect(status.degraded).toBe(true);
    expect(status.timeouts).toEqual(['watchers']);
    expect(status.watcher_count).toBeNull();
    expect(status.memory_available).toBe(true);
    expect(Array.isArray(status.fanout_errors)).toBe(true);
    expect(h.calls.find((call) => call.tool === 'query_sdk')?.options?.signal?.aborted).toBe(true);
  });

  it('wiki_search corpus=all merges partial results when one side times out', async () => {
    const h = makeHarness({ memoryWikiCompat: { enabled: true, fanoutTimeoutMs: 50 } });
    h.setResponse('search_memory', jsonContent({ content: [{ id: 1, title: 'memory hit', text_content: 'hi' }] }));
    h.setResponse('query_sdk', jsonContent({ watchers: { watchers: [] }, claims: null, syntheses: null }));
    h.setDelay('query_sdk', 200);

    const started = Date.now();
    const result = await h.invoke('wiki_search', { query: 'hi', corpus: 'all' });
    const elapsed = Date.now() - started;

    const details = result.details as {
      results: Array<{ corpus: string }>;
      degraded: boolean;
      timeouts: string[];
    };
    expect(elapsed).toBeLessThan(180);
    expect(details.degraded).toBe(true);
    expect(details.timeouts).toEqual(['wiki']);
    expect(details.results.some((r) => r.corpus === 'memory')).toBe(true);
    expect(result.content[0]!.text).toMatch(/partial results/);
  });

  it('wiki_get reports a clean timeout error when the SDK script hangs', async () => {
    const h = makeHarness({ memoryWikiCompat: { enabled: true, fanoutTimeoutMs: 50 } });
    h.setResponse('query_sdk', jsonContent({ id: 7 }));
    h.setDelay('query_sdk', 200);

    const started = Date.now();
    const result = await h.invoke('wiki_get', { lookup: 'watcher:7' });
    const elapsed = Date.now() - started;

    const details = result.details as Record<string, unknown>;
    expect(elapsed).toBeLessThan(180);
    expect(details.degraded).toBe(true);
    expect(details.timeout).toBe(true);
    expect(details.result).toBeNull();
    expect(result.content[0]!.text).toMatch(/timeout/);
  });

  it('wiki_search corpus=all does not flag degraded when both sides return in time', async () => {
    const h = makeHarness({ memoryWikiCompat: { enabled: true, fanoutTimeoutMs: 200 } });
    h.setResponse('search_memory', jsonContent({ content: [{ id: 1, title: 'm', text_content: 'x' }] }));
    h.setResponse('query_sdk', jsonContent({ watchers: { watchers: [] }, claims: null, syntheses: null }));

    const result = await h.invoke('wiki_search', { query: 'hi', corpus: 'all' });
    const details = result.details as { degraded: boolean; timeouts: string[] };
    expect(details.degraded).toBe(false);
    expect(details.timeouts).toEqual([]);
  });
});
