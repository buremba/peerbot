/**
 * Integration test: an agent-authored INTERACTIVE event survives the full
 * save → store → read-back chain with its render DSL intact.
 *
 * The existing neighbor (save-content-json-template.test.ts) pins the save-side
 * *schema* checks (missing payload_template throws; a rootless template stores
 * verbatim). What it does NOT cover is the thing that actually breaks in prod:
 * a rich template authored by an agent — nested components, data bindings with
 * `format` directives, `if`/`each` control flow — round-tripping through JSONB
 * and back out of the read path with every node still byte-identical.
 *
 * WHY THIS MATTERS: payload_template is opaque JSONB. Any silent coercion
 * (key reordering is fine; dropped keys, stringified numbers, or a collapsed
 * `children` array are not) shows up only at render time in the browser, where
 * the renderer degrades gracefully to *blank* — the failure is invisible
 * server-side. Asserting deep-equality on read-back is what makes that class
 * of regression fail here instead of silently rendering nothing.
 *
 * Vitest CI gap note (mirrors neighbors): runs locally / in the CI integration
 * job against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

/**
 * A template shaped like something an agent would actually emit: a card with a
 * header, a bound metric with a `format` directive, a conditional branch, and a
 * loop over a list. Exercises every node kind the DSL defines (text, data, if,
 * each, component) in one structure.
 */
const AGENT_TEMPLATE = {
  root: {
    type: 'card',
    children: [
      {
        type: 'card-header',
        children: [
          { type: 'card-title', children: [{ type: 'text', content: 'Deal Review' }] },
          {
            type: 'card-description',
            children: [{ type: 'data', path: 'company', fallback: 'Unknown' }],
          },
        ],
      },
      {
        type: 'card-content',
        children: [
          // A bound scalar carrying an explicit display-format directive.
          { type: 'data', path: 'valuation', format: 'currency' },
          { type: 'data', path: 'closed_at', format: 'date' },
          // Control flow: only render the badge when the deal is hot.
          {
            type: 'if',
            condition: 'is_hot',
            then: { type: 'badge', props: { variant: 'default' }, children: [{ type: 'text', content: 'Hot' }] },
            else: { type: 'badge', props: { variant: 'secondary' }, children: [{ type: 'text', content: 'Cold' }] },
          },
          // Loop with the string-shorthand render form.
          { type: 'each', items: 'signals', as: 'signal', render: '- {{signal}}' },
          // Loop with a full node render form.
          {
            type: 'each',
            items: 'owners',
            as: 'owner',
            render: { type: 'li', children: [{ type: 'data', path: 'owner.name' }] },
          },
        ],
      },
    ],
  },
} as const;

const AGENT_DATA = {
  company: 'Acme Corp',
  valuation: 12_500_000,
  closed_at: '2026-03-14',
  is_hot: true,
  signals: ['strong retention', 'net-new logos'],
  owners: [{ name: 'Ada' }, { name: 'Grace' }],
};

describe('agent-authored interactive event > json_template round-trip', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Interactive Events Org' });
    user = await createTestUser({ email: 'interactive-events@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
    };
  });

  it('stores a rich agent template + data with every node preserved exactly', async () => {
    const result = await saveContent(
      {
        payload_type: 'json_template',
        payload_template: AGENT_TEMPLATE,
        payload_data: AGENT_DATA,
        semantic_type: 'content',
        title: 'Deal Review card',
        metadata: {},
      } as never,
      {} as never,
      ctx
    );

    expect(result.id).toBeGreaterThan(0);

    const sql = getTestDb();
    const rows = await sql`
      SELECT payload_type, payload_template, payload_data FROM events WHERE id = ${result.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_type).toBe('json_template');

    // The whole DSL tree survives JSONB verbatim — not merely "has a root".
    // A dropped `children` array or a collapsed conditional would render blank
    // in the browser with no server-side signal, so assert deep equality.
    expect(rows[0].payload_template).toEqual(AGENT_TEMPLATE);

    // Data must keep its TYPES: numbers must not come back stringified, or the
    // `currency` format directive and any numeric comparison silently break.
    const data = rows[0].payload_data as typeof AGENT_DATA;
    expect(data).toEqual(AGENT_DATA);
    expect(typeof data.valuation).toBe('number');
    expect(data.is_hot).toBe(true);
    expect(data.signals).toHaveLength(2);
    expect(data.owners[0]?.name).toBe('Ada');
  });

  it('preserves an interactive button node with its action props', async () => {
    // Buttons are the "interaction" half of the DSL: the props carry the action
    // wiring, so a props object silently dropped or flattened would leave a
    // dead button that still LOOKS rendered.
    const template = {
      root: {
        type: 'card',
        children: [
          {
            type: 'button',
            props: { action: 'approve_deal', variant: 'default', dealId: '{{deal_id}}' },
            children: [{ type: 'text', content: 'Approve' }],
          },
        ],
      },
    };

    const result = await saveContent(
      {
        payload_type: 'json_template',
        payload_template: template,
        payload_data: { deal_id: 'deal-42' },
        semantic_type: 'content',
        title: 'Approval card',
        metadata: {},
      } as never,
      {} as never,
      ctx
    );

    const sql = getTestDb();
    const rows = await sql`
      SELECT payload_template FROM events WHERE id = ${result.id}
    `;
    expect(rows[0].payload_template).toEqual(template);

    // Drill into the exact props the click handler depends on.
    const root = (rows[0].payload_template as { root: Record<string, any> }).root;
    const button = root.children[0];
    expect(button.type).toBe('button');
    expect(button.props).toEqual({
      action: 'approve_deal',
      variant: 'default',
      dealId: '{{deal_id}}',
    });
  });
});
