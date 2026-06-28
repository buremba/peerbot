/**
 * Shared ACL-enforcement-state helpers — used by BOTH read gates (the Slack
 * channel gate `./channel-visibility` and the generic resource gate
 * `./resource-visibility`) so the "is this connection enforcing right now?"
 * rule lives in one place and cannot drift between them.
 */

/**
 * How long a `fresh` ACL graph stays trusted without a re-sync. The background
 * sync re-stamps `last_synced_at`; if it stops, a connection's graph ages past
 * this window and the gate stops trusting it — failing closed rather than
 * serving stale membership. Generous vs. the ~15-min sync cadence so a transient
 * hiccup never blinks recall off.
 */
export const ACL_STALE_AFTER_MINUTES = 60;

/**
 * SQL subquery (no leading/trailing space) selecting the `connection_id`s that
 * are ACL-enforced right now: `acl_support='full'` AND `freshness_state='fresh'`
 * AND synced within {@link ACL_STALE_AFTER_MINUTES}. `orgParam` is an already-bound
 * `$N::text` placeholder. Returns the bare `SELECT …` (caller wraps in IN/NOT IN).
 */
export function enforcedConnectionsSelectSql(orgParam: string): string {
  return `SELECT connection_id FROM public.authz_source_acl_state
    WHERE organization_id = ${orgParam}
      AND acl_support = 'full'
      AND freshness_state = 'fresh'
      AND last_synced_at IS NOT NULL
      AND last_synced_at >= current_timestamp - make_interval(mins => ${ACL_STALE_AFTER_MINUTES})`;
}
