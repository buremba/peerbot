/**
 * Strip the configured member email field from any `$member` rows inside a
 * `Record<string, unknown[]>` bag of data-source results. Applied to
 * template_data and tab template_data so non-admin callers never see member
 * emails surfaced by admin-authored data sources (e.g. a dashboard that
 * lists all workspace members).
 *
 * Rows without `entity_type === '$member'` pass through untouched — template
 * data for non-member entities is never redacted here. Row-level email
 * fields at the top level (e.g. `SELECT metadata->>'email' AS email ...`)
 * are also stripped when the row is clearly a member, but aggressive deep
 * rewriting is intentionally avoided to keep the helper predictable.
 */
export function stripMemberEmailsFromRows(
  data: Record<string, unknown[]> | null,
  emailField: string
): Record<string, unknown[]> | null {
  if (!data || !emailField) return data;
  const out: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(data)) {
    out[name] = rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const record = row as Record<string, unknown>;
      if (record.entity_type !== '$member') return record;
      const result: Record<string, unknown> = { ...record };
      if (emailField in result) delete result[emailField];
      const metadata = result.metadata;
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        const md = metadata as Record<string, unknown>;
        if (emailField in md) {
          const { [emailField]: _drop, ...rest } = md;
          result.metadata = rest;
        }
      }
      return result;
    });
  }
  return out;
}
