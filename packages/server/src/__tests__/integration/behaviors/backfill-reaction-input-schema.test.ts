/**
 * Integration: the reaction_input_schema backfill fills the contract for reactions
 * that predate the feature (reaction_script present, reaction_input_schema NULL),
 * reusing the SAME extractor set_reaction_script uses — so the result equals a
 * re-apply. Proves: dry-run writes nothing, --execute fills the whole group, a
 * second run is idempotent (0 filled), and a no-`input` reaction stays NULL.
 *
 * Runs under vitest (node), which loads the isolated-vm native addon the extractor
 * needs — the standalone `scripts/` CLI wraps this exact function.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageBehaviors } from '../../../tools/admin/manage_behaviors';
import type { ToolContext } from '../../../tools/registry';
import { backfillReactionInputSchema } from '../../../behaviors/backfill-reaction-input-schema';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const REACTION_WITH_INPUT =
  'export const input = { type: "object", properties: { outcome: { type: "string" }, count: { type: "number" } }, required: ["outcome"] };\n' +
  'export default async function reaction() { return; }';

const REACTION_NO_INPUT = 'export default async function reaction() { return; }';

function ownerCtx(workspace: TestWorkspace): ToolContext {
  return {
    organizationId: workspace.org.id,
    userId: workspace.users.owner.id,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

async function seedReactionBehavior(workspace: TestWorkspace, suffix: string, script: string) {
  const entity = await createTestEntity({
    name: `Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const behavior = (await workspace.owner.behaviors.create({
    entity_id: entity.id,
    slug: `react-${suffix}`,
    name: `React ${suffix}`,
    prompt: 'Summarize {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    agent_id: agent.agentId,
  })) as { behavior_id: string };
  const behaviorId = Number(behavior.behavior_id);
  await manageBehaviors(
    {
      action: 'set_reaction_script',
      behavior_id: String(behaviorId),
      reaction_script: script,
    } as never,
    {} as Env,
    ownerCtx(workspace)
  );
  return behaviorId;
}

describe('backfillReactionInputSchema', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('fills a NULL reaction_input_schema from the stored script (dry-run writes nothing)', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Backfill Org' });
    const behaviorId = await seedReactionBehavior(workspace, 'fill', REACTION_WITH_INPUT);

    // set_reaction_script already populated it; NULL it to simulate a pre-feature row.
    await sql`UPDATE behaviors SET reaction_input_schema = NULL WHERE id = ${behaviorId}`;

    // Dry-run: reports it WOULD fill, but writes nothing.
    const dry = await backfillReactionInputSchema({
      db: sql as never,
      org: workspace.org.id,
      execute: false,
    });
    expect(dry.groups).toBe(1);
    expect(dry.filled).toBe(1);
    const [afterDry] =
      await sql`SELECT reaction_input_schema FROM behaviors WHERE id = ${behaviorId}`;
    expect(afterDry.reaction_input_schema).toBeNull();

    // Execute: fills the column with the extracted contract.
    const run = await backfillReactionInputSchema({
      db: sql as never,
      org: workspace.org.id,
      execute: true,
    });
    expect(run.filled).toBe(1);
    const [afterRun] =
      await sql`SELECT reaction_input_schema FROM behaviors WHERE id = ${behaviorId}`;
    const schema = afterRun.reaction_input_schema as {
      properties?: Record<string, unknown>;
    } | null;
    expect(schema).not.toBeNull();
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['count', 'outcome']);

    // Idempotent: a second execute finds nothing to fill.
    const again = await backfillReactionInputSchema({
      db: sql as never,
      org: workspace.org.id,
      execute: true,
    });
    expect(again.groups).toBe(0);
    expect(again.filled).toBe(0);
  });

  it('leaves a reaction with no `input` export as NULL (counted, never written)', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({
      name: 'Backfill NoInput Org',
    });
    const behaviorId = await seedReactionBehavior(workspace, 'noinput', REACTION_NO_INPUT);
    await sql`UPDATE behaviors SET reaction_input_schema = NULL WHERE id = ${behaviorId}`;

    const run = await backfillReactionInputSchema({
      db: sql as never,
      org: workspace.org.id,
      execute: true,
    });
    expect(run.groups).toBe(1);
    expect(run.filled).toBe(0);
    expect(run.noInput).toBe(1);
    const [after] = await sql`SELECT reaction_input_schema FROM behaviors WHERE id = ${behaviorId}`;
    expect(after.reaction_input_schema).toBeNull();
  });
});
