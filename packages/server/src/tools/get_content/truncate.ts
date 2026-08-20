/**
 * Char-based truncation of text values entering the model turn.
 *
 * Query/listing reads (query_sql, automation window sources, list/search) can
 * return rows whose `payload_text` (scraped pages, transcripts, big documents)
 * or any OTHER string column is arbitrarily large. These helpers truncate every
 * string cell longer than a cap to a head plus a `… [truncated]` marker, and
 * record the full original length, so a caller knows it was cut and how big it
 * really was. The full body stays available by fetching the event by id or by
 * `substr(...)`.
 *
 * Deliberately char-based, not byte-based: `String.prototype.slice(0, n)`
 * operates on UTF-16 code units, so it can never split a surrogate pair — the
 * retained head is always valid, well-formed text with no re-encoding pass
 * needed. The cap is a rough character budget, matching how large text is
 * "a head of the document" rather than an exact wire byte-count.
 */

/** Default head kept for a text value in a bulk/query read. */
export const QUERY_TEXT_HEAD_CHARS = 4_000;
/** Suffix appended to a truncated head. */
const TRUNCATION_SUFFIX = '\u2026 [truncated]';

/**
 * Truncate every string cell in a row longer than `headChars`. Mutates the row
 * in place: replaces the value with `head + suffix`, and if the field is
 * `payload_text` or `text_content` also sets `content_length` (full original
 * character count) and `payload_truncated: true` so the standard content-item
 * shape reports the truncation the same way across every path. Non-string
 * values and strings under the cap are left untouched.
 */
export function truncateRowText(row: Record<string, unknown>, headChars: number): void {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    if (value.length <= headChars) continue;
    const head = `${value.slice(0, headChars)}${TRUNCATION_SUFFIX}`;
    row[key] = head;
    if (key === 'payload_text' || key === 'text_content') {
      row.content_length = value.length;
      row.payload_truncated = true;
    }
  }
}

/**
 * Truncate every string cell in every row of a list. Only object rows are
 * touched; rows that are scalars or arrays pass through unchanged (a scalar
 * projection is a single small value, and an array cell is bounded by the query
 * already). No-op for an empty list.
 */
export function truncateRowsText(rows: Record<string, unknown>[], headChars: number): void {
  if (rows.length === 0) return;
  for (const row of rows) {
    truncateRowText(row, headChars);
  }
}
