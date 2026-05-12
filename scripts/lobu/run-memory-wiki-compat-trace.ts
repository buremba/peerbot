/**
 * Trace script for the OpenClaw memory-wiki compatibility spike (PR #569, issue #568).
 *
 * Runs a fixed set of probes against a live local Lobu MCP twice:
 *   - baseline: call search_memory / read_knowledge / list_watchers directly (raw Lobu MCP)
 *   - compat:   call wiki_search / wiki_get / wiki_status / wiki_lint via the
 *               @lobu/openclaw-plugin memoryWikiCompat layer
 *
 * Emits a markdown table to stdout (and to .lobu/benchmarks/memory/wiki-compat-trace.md).
 *
 * Usage:
 *   LOBU_MCP_URL=http://localhost:8787/mcp/<org-slug> \
 *   LOBU_MCP_TOKEN=$BENCH_TOKEN \
 *     bun run scripts/lobu/run-memory-wiki-compat-trace.ts
 *
 * This is intentionally NOT wired into the retrieval-only benchmark in
 * packages/server/src/benchmarks/memory/: that suite measures retrieval recall
 * over a no-watcher dataset, where compat-on vs compat-off produce the same
 * candidate set. The value of memoryWikiCompat is in the agent-facing tool
 * surface (wiki_*) — this script captures that surface explicitly.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { registerMemoryWikiCompatTools } from '../../packages/openclaw-plugin/src/memory-wiki-compat';
import type { McpToolResponse, ResolvedPluginConfig } from '../../packages/openclaw-plugin/src/types';

type Probe = {
  id: string;
  description: string;
  baselineCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  compatTool: string;
  compatArgs: Record<string, unknown>;
};

const PROBES: Probe[] = [
  {
    id: 'status',
    description: 'Status probe — does the surface answer "are you alive?"',
    baselineCalls: [
      { tool: 'list_watchers', args: { include_details: false } },
      {
        tool: 'search_memory',
        args: { query: 'status check', include_content: false, include_connections: false, limit: 1 },
      },
    ],
    compatTool: 'wiki_status',
    compatArgs: {},
  },
  {
    id: 'search_recent',
    description: 'Search for recent activity',
    baselineCalls: [
      { tool: 'search_memory', args: { query: 'recent activity', include_content: true, content_limit: 8, limit: 8 } },
    ],
    compatTool: 'wiki_search',
    compatArgs: { query: 'recent activity', corpus: 'all', maxResults: 8 },
  },
  {
    id: 'search_wiki_only',
    description: 'Wiki-corpus search (watchers + claims + syntheses)',
    baselineCalls: [
      { tool: 'list_watchers', args: { include_details: false } },
      { tool: 'read_knowledge', args: { query: 'product feedback', semantic_type: 'claim', limit: 8 } },
      { tool: 'read_knowledge', args: { query: 'product feedback', semantic_type: 'synthesis', limit: 8 } },
    ],
    compatTool: 'wiki_search',
    compatArgs: { query: 'product feedback', corpus: 'wiki', maxResults: 8 },
  },
  {
    id: 'lint_empty',
    description: 'Empty-session lint (sanity)',
    baselineCalls: [],
    compatTool: 'wiki_lint',
    compatArgs: {},
  },
];

type Trace = {
  probeId: string;
  via: 'baseline' | 'compat';
  durationMs: number;
  toolCalls: number;
  resultPreview: string;
  error?: string;
};

type RegisteredTool = {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<McpToolResponse & { details: Record<string, unknown> }>;
};

class McpJsonClient {
  private sessionId: string | null = null;
  constructor(
    private readonly url: string,
    private readonly token?: string
  ) {}

  private async fetchJson(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText}`);
    return res;
  }

  private async init(): Promise<void> {
    if (this.sessionId) return;
    const res = await this.fetchJson({
      jsonrpc: '2.0',
      id: '__init__',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wiki-compat-trace', version: '0.0.1' } },
    });
    const sid = res.headers.get('mcp-session-id');
    if (!sid) throw new Error('MCP initialize did not return mcp-session-id');
    this.sessionId = sid;
    await this.fetchJson({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<McpToolResponse> {
    await this.init();
    const res = await this.fetchJson({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, options?.signal);
    const json = (await res.json()) as { error?: { message: string }; result?: McpToolResponse };
    if (json.error) throw new Error(json.error.message);
    return json.result ?? { content: [], isError: false };
  }
}

function preview(payload: unknown, max = 240): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

async function runBaseline(client: McpJsonClient, probe: Probe): Promise<Trace> {
  const startedAt = performance.now();
  let resultPreview = '';
  try {
    for (const call of probe.baselineCalls) {
      const res = await client.callTool(call.tool, call.args);
      resultPreview = preview(res.content?.[0]?.text ?? '');
    }
    return {
      probeId: probe.id,
      via: 'baseline',
      durationMs: performance.now() - startedAt,
      toolCalls: probe.baselineCalls.length,
      resultPreview,
    };
  } catch (error) {
    return {
      probeId: probe.id,
      via: 'baseline',
      durationMs: performance.now() - startedAt,
      toolCalls: probe.baselineCalls.length,
      resultPreview: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runCompat(client: McpJsonClient, tools: Map<string, RegisteredTool>, probe: Probe): Promise<Trace> {
  const tool = tools.get(probe.compatTool);
  if (!tool) {
    return {
      probeId: probe.id,
      via: 'compat',
      durationMs: 0,
      toolCalls: 0,
      resultPreview: '',
      error: `compat tool ${probe.compatTool} not registered`,
    };
  }
  const startedAt = performance.now();
  let upstreamCalls = 0;
  // Patch the client.callTool to count upstream MCP calls for the duration of this probe.
  const original = client.callTool.bind(client);
  client.callTool = async (name, args, options) => {
    upstreamCalls += 1;
    return original(name, args, options);
  };
  try {
    const res = await tool.execute('trace', probe.compatArgs);
    return {
      probeId: probe.id,
      via: 'compat',
      durationMs: performance.now() - startedAt,
      toolCalls: upstreamCalls,
      resultPreview: preview(res.content?.[0]?.text ?? res.details ?? ''),
    };
  } catch (error) {
    return {
      probeId: probe.id,
      via: 'compat',
      durationMs: performance.now() - startedAt,
      toolCalls: upstreamCalls,
      resultPreview: '',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.callTool = original;
  }
}

function formatMarkdown(probes: Probe[], traces: Trace[]): string {
  const lines: string[] = [];
  lines.push('# Memory-wiki compatibility trace');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('| Probe | Tool (compat) | Baseline calls | Compat upstream calls | Baseline ms | Compat ms | Compat error |');
  lines.push('|---|---|---:|---:|---:|---:|---|');
  for (const probe of probes) {
    const baseline = traces.find((t) => t.probeId === probe.id && t.via === 'baseline');
    const compat = traces.find((t) => t.probeId === probe.id && t.via === 'compat');
    lines.push(
      `| \`${probe.id}\` | \`${probe.compatTool}\` | ${baseline?.toolCalls ?? '-'} | ${compat?.toolCalls ?? '-'} | ${baseline ? baseline.durationMs.toFixed(0) : '-'} | ${compat ? compat.durationMs.toFixed(0) : '-'} | ${compat?.error ?? ''} |`
    );
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- This is a tool-surface trace, not a retrieval-quality benchmark.');
  lines.push('- Compat upstream calls counts how many raw MCP tools the compat layer fans out to per logical wiki_* call.');
  lines.push('- For corpus=wiki searches, fan-out to list_watchers + read_knowledge(claim) + read_knowledge(synthesis) is expected when the query is >=3 chars.');
  lines.push('- Result previews are truncated to 240 chars; see the JSON sidecar for full content if needed.');
  lines.push('');
  lines.push('## Result previews');
  lines.push('');
  for (const t of traces) {
    if (!t.resultPreview && !t.error) continue;
    lines.push(`### \`${t.probeId}\` (${t.via})`);
    if (t.error) {
      lines.push(`Error: ${t.error}`);
    } else {
      lines.push('');
      lines.push(`> ${t.resultPreview}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function makeResolvedConfig(mcpUrl: string, token: string | null): ResolvedPluginConfig {
  return {
    mcpUrl,
    webUrl: null,
    token,
    tokenCommand: null,
    gatewayAuthUrl: null,
    headers: {},
    autoRecall: false,
    autoCapture: false,
    recallLimit: 10,
    memoryWikiCompat: { enabled: true, fanoutTimeoutMs: 30_000 },
  };
}

async function main(): Promise<void> {
  const mcpUrl = process.env.LOBU_MCP_URL;
  const token = process.env.LOBU_MCP_TOKEN ?? null;
  if (!mcpUrl) {
    console.error('LOBU_MCP_URL is required. Set it to your local Lobu MCP, e.g. http://localhost:8787/mcp/<org-slug>');
    process.exit(2);
  }

  const client = new McpJsonClient(mcpUrl, token ?? undefined);

  const tools = new Map<string, RegisteredTool>();
  const registerTool = (def: Record<string, unknown>): void => {
    tools.set(def.name as string, def as unknown as RegisteredTool);
  };
  const callMcpTool = async (
    _config: ResolvedPluginConfig,
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<McpToolResponse | null> => {
    try {
      return await client.callTool(name, args, options);
    } catch (error) {
      return { content: [{ type: 'text', text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  };
  registerMemoryWikiCompatTools(
    makeResolvedConfig(mcpUrl, token),
    registerTool,
    { info: () => {}, warn: () => {}, error: () => {} },
    callMcpTool
  );

  const traces: Trace[] = [];
  for (const probe of PROBES) {
    traces.push(await runBaseline(client, probe));
    traces.push(await runCompat(client, tools, probe));
  }

  const markdown = formatMarkdown(PROBES, traces);
  console.log(markdown);

  const outPath = resolve(process.cwd(), '.lobu/benchmarks/memory/wiki-compat-trace.md');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown);
  writeFileSync(outPath.replace(/\.md$/, '.json'), JSON.stringify({ generatedAt: new Date().toISOString(), traces }, null, 2));
  console.error(`\nSaved markdown trace to ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
