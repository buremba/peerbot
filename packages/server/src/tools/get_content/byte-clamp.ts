/**
 * Byte-cap clamping for payloads entering the model turn.
 *
 * Event rows can carry arbitrarily large `payload_text` (scraped pages,
 * transcripts, big documents) and `payload_data` (jsonb). Agent-facing read
 * paths bound row COUNT but never row BYTES, so a single oversized event can
 * flood the turn while the rest of the window stays small. These helpers clamp
 * payloads at the serialization chokepoints — after row trimming, before the
 * response is assembled — and mark the truncation so a caller can decide
 * whether to do a deliberate follow-up read.
 *
 * Two tiers: bulk reads (automation window sources, non-automation list and
 * search) get a small per-row head; deliberate single-event lookups
 * (`content_ids`, automation trigger-inputs) earn a large head that scales
 * down as the id count grows so 25 exact inputs cannot multiply into
 * megabytes.
 */

const TRUNCATION_SUFFIX = '\u2026 [truncated]';

export interface ClampBudget {
  /**
   * Max bytes of `payload_text` (and serialized `payload_data`) kept per row.
   */
  bytes: number;
}

/** Head kept per row on bulk reads. */
export const BULK_PAYLOAD_TEXT_BYTES = 4_096;
/** Head kept per single deliberate event read. */
export const EXACT_PAYLOAD_TEXT_BYTES = 200_000;
/** Total budget a multi-id exact read may consume across its rows. */
export const EXACT_PAYLOAD_TOTAL_BUDGET = 300_000;
/** Floor per row so even a near-cap id list keeps each row readable. */
const EXACT_PAYLOAD_PER_ROW_FLOOR = 16_384;

export function exactSinglePayloadBudget(count: number): ClampBudget {
  const scaled = Math.max(
    EXACT_PAYLOAD_PER_ROW_FLOOR,
    Math.floor(EXACT_PAYLOAD_TOTAL_BUDGET / Math.max(count, 1))
  );
  return { bytes: Math.min(EXACT_PAYLOAD_TEXT_BYTES, scaled) };
}

export const BULK_BUDGET: ClampBudget = { bytes: BULK_PAYLOAD_TEXT_BYTES };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Postgres-style character count (code points, not UTF-16 units). */
function charLength(text: string): number {
  return [...text].length;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Largest prefix of `text` whose UTF-8 byte length is <= maxBytes. */
function sliceByBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (byteLength(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/**
 * Clamp the payload fields of a single row in place. Handles both mapped
 * ContentItem-shaped objects and raw source rows: reads `payload_text` with
 * `text_content` as the custom-SQL fallback, clamps whichever keys are
 * present, and replaces an oversized serialized `payload_data` with a marker
 * object. Adds `payload_truncated: true` and `content_length` (full original
 * character count) only when something was clamped. Rows are left untouched
 * when they fit the budget.
 */
export function clampRowPayloads(
  row: Record<string, unknown>,
  budget: ClampBudget
): void {
  const text = row.payload_text ?? row.text_content;
  if (typeof text === 'string' && byteLength(text) > budget.bytes) {
    const head = sliceByBytes(text, budget.bytes) + TRUNCATION_SUFFIX;
    if (typeof row.payload_text === 'string') row.payload_text = head;
    if (typeof row.text_content === 'string') row.text_content = head;
    row.content_length = charLength(text);
    row.payload_truncated = true;
  }
  const data = row.payload_data;
  if (data != null) {
    const dataBytes = byteLength(JSON.stringify(data) ?? '');
    if (dataBytes > budget.bytes) {
      row.payload_data = { _truncated: true, bytes: dataBytes };
      row.payload_truncated = true;
    }
  }
}

/**
 * Clamp every row in a source in place. Only object rows are touched; row
 * arrays and primitives (e.g. scalar projections) pass through unchanged.
 */
export function clampRows(rows: unknown[], budget: ClampBudget): void {
  if (rows.length === 0) return;
  for (const row of rows) {
    if (isObject(row)) clampRowPayloads(row, budget);
  }
}