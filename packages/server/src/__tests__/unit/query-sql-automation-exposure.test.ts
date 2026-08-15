/**
 * query_sql's Automation surface: the exposed relation must be NAMED for agents,
 * COMPLETE for its own org, and CLOSED across orgs.
 *
 * Three defects reproduced live against prod, all rooted in
 * `QUERYABLE_SCHEMA` / the CTE builder:
 *
 *   1. `automation_versions` listed a
 *      `sources` column the table has never had. The CTE emits an explicit
 *      column list, so `wv."sources"` was injected into EVERY query — even
 *      `SELECT 1 AS one FROM …`, which references no column at all. The whole
 *      relation was 100% unqueryable with an error naming a column the caller
 *      never wrote.
 *   2. The `automations` CTE scoped through `EXISTS (SELECT 1 FROM entities WHERE
 *      ent.id = ANY(i.entity_ids) …)`. `entity_ids` is nullable and org-scoped
 *      Automations carry NULL, so they were structurally invisible — a confident
 *      wrong count with no coverage hint. `automations.organization_id` is NOT
 *      NULL, so direct org scoping is both complete and strictly fail-closed.
 *   3. The queryable relations and physical schema now use the same canonical
 *      Automation vocabulary.
 */

import { describe, expect, it } from 'bun:test';
import {
	buildScopedQuery,
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

describe('Defect 1 — automation_versions is queryable at all', () => {
  it('does not project a column the physical table has never had', () => {
    // `sources` exists on `automations`, never on `automation_versions` (the version
    // row carries `version_sources`). Projecting it poisons every query.
    const defs = SAFE_COLUMN_DEFS.get('automation_versions');
    expect(defs).toBeDefined();
    expect(defs?.map((c) => c.name)).not.toContain('sources');
  });

  it('emits no reference to a dropped column for a query that names no column', () => {
    // The caller references NOTHING. Any column name in the generated SQL is
    // server-injected — this is the exact prod repro.
    const { sql } = scope('SELECT 1 AS one FROM automation_versions');
    expect(sql).not.toMatch(/\bwv\."sources"/);
    expect(sql).toContain('version_sources');
  });
});

describe('Defect 2 — org-scoped Automations are visible to their own org', () => {
  it('scopes automations by organization_id, not by an entity join', () => {
    const { sql, params } = scope('SELECT count(*) AS n FROM automations');
    // The entity-existence join is what hid entity-less Automations.
    expect(sql).not.toMatch(/ent\.id = ANY\(\w+\.entity_ids\)/);
    expect(sql).toMatch(/public\.automations \w+ WHERE \w+\.organization_id = \$1/);
    expect(params[0]).toBe('org_1');
  });

  it('scopes automation_versions through the parent automation organization_id', () => {
    const { sql } = scope('SELECT id FROM automation_versions');
    expect(sql).not.toMatch(/ent\.id = ANY\(w\.entity_ids\)/);
    expect(sql).toMatch(/public\.automations w ON w\.id = wv\.automation_id/);
    expect(sql).toMatch(/w\.organization_id = \$1/);
  });

  it('stays fail-closed across orgs — the org predicate is never dropped', () => {
    // Widening visibility must not become a tenancy leak: every Automation CTE
    // must still carry the bound org param, and nothing else.
    for (const q of ['SELECT id FROM automations', 'SELECT id FROM automation_versions']) {
      const { sql, params } = scope(q, 'org_tenant_a');
      expect(params).toEqual(['org_tenant_a']);
      expect(sql).toMatch(/organization_id = \$1/);
    }
  });

  it('does not widen the automations CTE to an unfiltered table scan', () => {
    const { sql } = buildScopedQuery('SELECT id FROM automations', ['automations'], {
      organizationId: 'org_1',
    });
    // A `WHERE TRUE` / missing predicate would read every tenant's rows.
    expect(sql).toMatch(/FROM public\.automations \w+ WHERE/);
  });
});

describe('Defect 3 — the agent-facing surface speaks Automation', () => {
	it('exposes the canonical Automation relations', () => {
		expect(QUERYABLE_TABLE_NAMES.has('automations')).toBe(true);
		expect(QUERYABLE_TABLE_NAMES.has('automation_versions')).toBe(true);
	});

	it('lists canonical Automation relations in the allowlist error', () => {
		const message = formatUnknownTablesError(['conversations']);
		expect(message).toContain('automations');
	});

	it('keeps canonical automation_id FK columns joinable', () => {
		const { sql } = scope(
			'SELECT ec.id FROM event_classifications ec JOIN automations b ON b.id = ec.automation_id'
		);
		expect(sql).toContain('automation_id');
	});

	it('exposes canonical Automation lineage columns', () => {
		const names = SAFE_COLUMN_DEFS.get('automations')?.map((column) => column.name) ?? [];
		expect(names).toContain('source_automation_id');
		expect(names).toContain('automation_group_id');

		const { sql } = scope('SELECT source_automation_id, automation_group_id FROM automations');
		expect(sql).toContain('source_automation_id');
		expect(sql).toContain('automation_group_id');
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
