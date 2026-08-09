/**
 * query_sql's Behavior surface: the exposed relation must be NAMED for agents,
 * COMPLETE for its own org, and CLOSED across orgs.
 *
 * Three defects reproduced live against prod, all rooted in
 * `QUERYABLE_SCHEMA` / the CTE builder:
 *
 *   1. `behavior_versions` (formerly exposed as `watcher_versions`) listed a
 *      `sources` column the table has never had. The CTE emits an explicit
 *      column list, so `wv."sources"` was injected into EVERY query — even
 *      `SELECT 1 AS one FROM …`, which references no column at all. The whole
 *      relation was 100% unqueryable with an error naming a column the caller
 *      never wrote.
 *   2. The `watchers` CTE scoped through `EXISTS (SELECT 1 FROM entities WHERE
 *      ent.id = ANY(i.entity_ids) …)`. `entity_ids` is nullable and org-scoped
 *      Behaviors carry NULL, so they were structurally invisible — a confident
 *      wrong count with no coverage hint. `watchers.organization_id` is NOT
 *      NULL, so direct org scoping is both complete and strictly fail-closed.
 *   3. `watcher` is internal engine/DB vocabulary; the agent-facing product
 *      name is Behavior. The allowlist error enumerated `watchers` /
 *      `watcher_versions` to the agent and asserted `behaviors` did not exist,
 *      routing it to the wrong (and broken) table.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildScopedQuery,
  executeDataSources,
  validateAndScopeQuery,
} from '../../utils/execute-data-sources';
import {
  QUERYABLE_TABLE_NAMES,
  SAFE_COLUMN_DEFS,
  formatUnknownTablesError,
  validateTableQuery,
} from '../../utils/table-schema';

const scope = (sql: string, orgId = 'org_1') =>
  validateAndScopeQuery(sql, orgId, { safeColumns: SAFE_COLUMN_DEFS });

describe('Defect 1 — behavior_versions is queryable at all', () => {
  it('does not project a column the physical table has never had', () => {
    // `sources` exists on `watchers`, never on `watcher_versions` (the version
    // row carries `version_sources`). Projecting it poisons every query.
    const defs = SAFE_COLUMN_DEFS.get('behavior_versions');
    expect(defs).toBeDefined();
    expect(defs?.map((c) => c.name)).not.toContain('sources');
  });

  it('emits no reference to a dropped column for a query that names no column', () => {
    // The caller references NOTHING. Any column name in the generated SQL is
    // server-injected — this is the exact prod repro.
    const { sql } = scope('SELECT 1 AS one FROM behavior_versions');
    expect(sql).not.toMatch(/\bwv\."sources"/);
    expect(sql).toContain('version_sources');
  });
});

describe('Defect 2 — org-scoped Behaviors are visible to their own org', () => {
  it('scopes behaviors by organization_id, not by an entity join', () => {
    const { sql, params } = scope('SELECT count(*) AS n FROM behaviors');
    // The entity-existence join is what hid entity-less Behaviors.
    expect(sql).not.toMatch(/ent\.id = ANY\(\w+\.entity_ids\)/);
    expect(sql).toMatch(/public\.watchers \w+ WHERE \w+\.organization_id = \$1/);
    expect(params[0]).toBe('org_1');
  });

  it('scopes behavior_versions through the parent behavior organization_id', () => {
    const { sql } = scope('SELECT id FROM behavior_versions');
    expect(sql).not.toMatch(/ent\.id = ANY\(w\.entity_ids\)/);
    expect(sql).toMatch(/public\.watchers w ON w\.id = wv\.watcher_id/);
    expect(sql).toMatch(/w\.organization_id = \$1/);
  });

  it('stays fail-closed across orgs — the org predicate is never dropped', () => {
    // Widening visibility must not become a tenancy leak: every Behavior CTE
    // must still carry the bound org param, and nothing else.
    for (const q of ['SELECT id FROM behaviors', 'SELECT id FROM behavior_versions']) {
      const { sql, params } = scope(q, 'org_tenant_a');
      expect(params).toEqual(['org_tenant_a']);
      expect(sql).toMatch(/organization_id = \$1/);
    }
  });

  it('does not widen the behaviors CTE to an unfiltered table scan', () => {
    const { sql } = buildScopedQuery('SELECT id FROM behaviors', ['behaviors'], {
      organizationId: 'org_1',
    });
    // A `WHERE TRUE` / missing predicate would read every tenant's rows.
    expect(sql).toMatch(/FROM public\.watchers \w+ WHERE/);
  });
});

describe('Defect 3 — the agent-facing surface speaks Behavior', () => {
  it('exposes behaviors / behavior_versions, not the internal watcher names', () => {
    expect(QUERYABLE_TABLE_NAMES.has('behaviors')).toBe(true);
    expect(QUERYABLE_TABLE_NAMES.has('behavior_versions')).toBe(true);
    expect(QUERYABLE_TABLE_NAMES.has('watchers')).toBe(false);
    expect(QUERYABLE_TABLE_NAMES.has('watcher_versions')).toBe(false);
  });

  it('never leaks internal watcher vocabulary in the allowlist error', () => {
    const message = formatUnknownTablesError(['conversations']);
    expect(message).not.toMatch(/watcher/i);
    expect(message).toContain('behaviors');
  });

  it('rejects the internal table name and points the agent at behaviors', () => {
    const result = validateTableQuery('SELECT id FROM watchers');
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toContain('behaviors');
  });

  it('keeps internal watcher_id FK columns on joinable tables', () => {
    // Column identifiers are internal vocabulary and stay as-is — only the
    // exposed RELATION name is renamed. event_classifications.watcher_id is
    // the join key to behaviors.id and must keep working.
    const { sql } = scope(
      'SELECT ec.id FROM event_classifications ec JOIN behaviors b ON b.id = ec.watcher_id'
    );
    expect(sql).toContain('watcher_id');
  });

  it('exposes Behavior lineage aliases and hides the physical watcher names', () => {
    const names = SAFE_COLUMN_DEFS.get('behaviors')?.map((column) => column.name) ?? [];
    expect(names).toContain('source_behavior_id');
    expect(names).toContain('behavior_group_id');
    expect(names).not.toContain('source_watcher_id');
    expect(names).not.toContain('watcher_group_id');

    const { sql } = scope('SELECT source_behavior_id, behavior_group_id FROM behaviors');
    expect(sql).toContain('"source_watcher_id" as "source_behavior_id"');
    expect(sql).toContain('"watcher_group_id" as "behavior_group_id"');
  });

  it('rejects the physical Behavior lineage column names', () => {
    for (const column of ['source_watcher_id', 'watcher_group_id']) {
      const result = validateTableQuery(`SELECT ${column} FROM behaviors`);
      expect(result.valid).toBe(false);
    }
  });
});

describe('Defect 4 — a source saved before the rename fails loudly, not silently', () => {
  // The rename retires `watchers` as an exposed relation. `executeDataSources`
  // compiles an UNKNOWN table ref as an entity-type CTE instead of erroring, and
  // its slug validation only runs at SAVE time (`validateEntitySlugs`), which is
  // exactly when these rows did NOT go through it — they were saved before the
  // rename existed. Without an explicit retired-name check a stored
  // `FROM watchers` resolves to a nonexistent entity type and returns ZERO ROWS:
  // a view template that silently empties instead of failing.
  const ctx = { organizationId: 'org_1' };
  // The rejection happens before any SQL is issued, so the client is never used.
  const unusedDb = (() => {
    throw new Error('database must not be reached — the retired name must be rejected first');
  }) as unknown as Parameters<typeof executeDataSources>[2];

  it('rejects a retired relation name and names its replacement', async () => {
    await expect(
      executeDataSources({ dead: { query: 'SELECT id FROM watchers' } }, ctx, unusedDb, {
        throwOnError: true,
      })
    ).rejects.toThrow(/watchers → behaviors/);
  });

  it('rejects the retired version relation too', async () => {
    await expect(
      executeDataSources({ dead: { query: 'SELECT id FROM watcher_versions' } }, ctx, unusedDb, {
        throwOnError: true,
      })
    ).rejects.toThrow(/watcher_versions → behavior_versions/);
  });

  it('still accepts the current name', () => {
    // Control: the replacement resolves through the normal allowlist path.
    expect(QUERYABLE_TABLE_NAMES.has('behaviors')).toBe(true);
    expect(() => scope('SELECT id FROM behaviors')).not.toThrow();
  });
});

describe('smaller fixes in the same class', () => {
  it('projects connections.unhealthy_alerted_at so org health is auditable', () => {
    const names = SAFE_COLUMN_DEFS.get('connections')?.map((c) => c.name) ?? [];
    expect(names).toContain('unhealthy_alerted_at');
    const { sql } = scope('SELECT unhealthy_alerted_at FROM connections');
    expect(sql).toContain('unhealthy_alerted_at');
  });

  it('shows feeds the SDK shows — gate on the feed row org + connection row visibility', () => {
    // The feeds CTE used the FK (events) form, which drops soft-deleted and
    // legacy-unowned connections. manage_feeds gates on the ROW form, so the
    // SDK returned feeds SQL could not see. Same structural class as Defect 2.
    const { sql } = scope('SELECT id FROM feeds');
    expect(sql).toMatch(/public\.feeds fd WHERE fd\.organization_id = \$1/);
    // FK form's tell: an IN-subquery over connections keyed on connection_id.
    expect(sql).not.toMatch(/fd\.connection_id IS NULL OR fd\.connection_id IN/);
    // Row form's tell: correlated EXISTS on the owning connection.
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM public\.connections/);
    expect(sql).toMatch(/visibility = 'org'/);
  });
});
