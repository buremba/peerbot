/**
 * Server-side query rewriter for retrieval recall.
 *
 * Conversational / underspecified questions retrieve poorly:
 *   - Filler ("I think we discussed X earlier, can you remind me…") embeds and
 *     keyword-matches noisily, so the gold session ranks below the cutoff.
 *   - Synonym gaps ("how many doctors") miss sessions that say
 *     "physician" / "ENT" / "dermatologist".
 *
 * This helper asks a small LLM to rewrite the question into a few focused
 * keyword search queries (filler stripped, synonym variants added). The caller
 * (read_knowledge / get_content) invokes it ONLY as an on-miss rescue: when the
 * primary single-query search returns nothing, it searches each variant with an
 * over-fetched internal limit and FUSES the candidates by best relevance score
 * per event, recovering a session the raw phrasing could not reach. There is no
 * caller-facing flag — the rescue self-heals on a total miss, so a query that
 * already found something never pays for it.
 *
 * Statelessness: this is a pure per-request retrieval helper. It holds no
 * shared/in-memory state, so it is trivially correct under N>1 app replicas —
 * each request rewrites independently, nothing to fan out across pods.
 *
 * Opt-in: rewriting only runs when QUERY_REWRITER_API_KEY is configured. With
 * no key (or on any failure) it returns [] and the caller falls back to the raw
 * query alone — so default behavior is byte-for-byte unchanged.
 */

import type { Env } from '../index';
import logger from './logger';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_INPUT_CHARS = 12_000;
const TIMEOUT_MS = 30_000;
const MAX_VARIANTS = 4;

const SYSTEM_PROMPT =
  'Rewrite the user\'s question into 3 short keyword search queries that retrieve the relevant past conversation sessions from a memory store. Strip conversational filler. Include synonym variants (doctor/physician/specialist; job/role/position). Return STRICT JSON {"queries":["...","...","..."]} only.';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
}

/**
 * Rewrite a conversational/underspecified query into up to 4 focused keyword
 * search-query variants (NOT including the original). Returns [] on any failure
 * or when unconfigured — the caller falls back to the raw query only.
 */
export async function rewriteQueries(query: string, env: Env): Promise<string[]> {
  const apiKey = env.QUERY_REWRITER_API_KEY;
  // Opt-in via the API key. No key → no rewrite (graceful, default-off).
  if (!apiKey) return [];

  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const baseUrl = (env.QUERY_REWRITER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.QUERY_REWRITER_MODEL || DEFAULT_MODEL;
  const input = trimmed.slice(0, MAX_INPUT_CHARS);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        '[query-rewriter] chat completion request failed; falling back to raw query'
      );
      return [];
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];

    return parseQueries(content);
  } catch (error) {
    // Fail open: any error (timeout/abort, network, parse) means the caller
    // proceeds with the raw query alone.
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      '[query-rewriter] rewrite failed; falling back to raw query'
    );
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse the model's `{"queries":[...]}` JSON (tolerating markdown code fences),
 * drop empties, and cap at MAX_VARIANTS.
 */
function parseQueries(raw: string): string[] {
  const cleaned = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const queries = (parsed as { queries?: unknown }).queries;
  if (!Array.isArray(queries)) return [];

  const out: string[] = [];
  for (const q of queries) {
    if (typeof q !== 'string') continue;
    const v = q.trim();
    if (v.length === 0) continue;
    out.push(v);
    if (out.length >= MAX_VARIANTS) break;
  }
  return out;
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ? fenced[1].trim() : text;
}
