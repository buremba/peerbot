/**
 * Watcher CRUD via the post-#348 SDK surface.
 *
 * Replaces the deleted manage_behaviors integration tests. Covers create,
 * read, update, delete on watchers attached to an entity, plus access-control
 * around the destructive actions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { BEHAVIOR_CATALOG_TEMPLATES } from '../../../catalog/behavior-templates';
import { executeReaction } from '../../../watchers/reaction-executor';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

describe('watcher CRUD', () => {
  let owner: TestApiClient;
  let intruder: TestApiClient;
  let entityId: number;
  let agentId: string;
  let ownerOrgId: string;
  let ownerUserId: string;
  let otherOrgId: string;
  let otherUserId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Watcher Test Org' });
    const user = await createTestUser({ email: 'watcher-owner@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ownerOrgId = org.id;
    ownerUserId = user.id;
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
    });
    agentId = agent.agentId;

    const otherOrg = await createTestOrganization({
      name: 'Watcher Other Org',
    });
    const otherUser = await createTestUser({ email: 'watcher-other@test.com' });
    await addUserToOrganization(otherUser.id, otherOrg.id, 'owner');
    otherOrgId = otherOrg.id;
    otherUserId = otherUser.id;
    intruder = await TestApiClient.for({
      organizationId: otherOrg.id,
      userId: otherUser.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    const entity = (await owner.entities.create({
      type: 'company',
      name: 'Watcher Target',
    })) as { entity: { id: number } };
    entityId = entity.entity.id;
  });

  it('creates → reads back → updates → deletes a watcher', async () => {
    const created = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'lifecycle-watcher',
      name: 'Lifecycle Watcher',
      prompt: 'Track product launches.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      agent_id: agentId,
    })) as { behavior_id: string };
    const watcherId = created.behavior_id;
    expect(watcherId).toBeDefined();

    const got = (await owner.behaviors.get({ behavior_id: watcherId })) as {
      behavior?: { behavior_name: string };
    };
    expect(got.behavior?.behavior_name).toBe('Lifecycle Watcher');

    await owner.behaviors.update({
      behavior_id: watcherId,
      triggers: [{ kind: 'schedule', cron: '0 10 * * *' }],
    });
    const after = (await owner.behaviors.get({ behavior_id: watcherId })) as {
      behavior?: { triggers: Array<{ kind: string; cron?: string }> };
    };
    expect(after.behavior).not.toHaveProperty('schedule');
    expect(after.behavior?.triggers).toMatchObject([
      { kind: 'schedule', cron: '0 10 * * *' },
    ]);

    const listed = (await owner.behaviors.list({ entity_id: entityId })) as {
      behaviors?: Array<Record<string, unknown>>;
    };
    const listedBehavior = listed.behaviors?.find((behavior) => behavior.behavior_id === watcherId);
    expect(listedBehavior).not.toHaveProperty('schedule');
    expect(listedBehavior?.triggers).toEqual(after.behavior?.triggers);

    await owner.behaviors.delete({ behavior_ids: [watcherId] });
    const list = (await owner.behaviors.list({ entity_id: entityId })) as {
      behaviors?: Array<{ behavior_id: string }>;
    };
    expect(list.behaviors?.some((w) => w.behavior_id === watcherId)).toBe(false);
  });

  it('creates a watcher and its reaction contract atomically', async () => {
    const sql = getTestDb();
    const reaction = `export const input = { type: "object", properties: { merge_proposals: { type: "array" } }, required: ["merge_proposals"] }; export default async function () {}`;
    const created = (await owner.behaviors.create({
      slug: 'atomic-reaction-watcher',
      name: 'Atomic Reaction Watcher',
      prompt: 'Return merge proposals.',
      agent_id: agentId,
      reaction_script: reaction,
    })) as { behavior_id: string };

    const [row] = await sql<
      {
        reaction_script: string | null;
        reaction_script_compiled: string | null;
        reaction_input_schema: Record<string, unknown> | null;
      }[]
    >`
      SELECT reaction_script, reaction_script_compiled, reaction_input_schema
      FROM watchers WHERE id = ${created.behavior_id}
    `;
    expect(row?.reaction_script).toBe(reaction);
    expect(row?.reaction_script_compiled).toContain('merge_proposals');
    expect(row?.reaction_input_schema).toMatchObject({
      required: ['merge_proposals'],
    });
  });

  it('executes an installed merge reaction and queues exactly one pending, unapplied approval with watcher/window attribution', async () => {
    const sql = getTestDb();

    // Three people form one exact-identity component (winner ↔ bridge by email,
    // bridge ↔ loser by phone), proving grouping does not depend on model output.
    const winner = await createTestEntity({
      name: 'Reaction Merge Winner',
      entity_type: 'person',
      organization_id: ownerOrgId,
      created_by: ownerUserId,
    });
    const bridge = await createTestEntity({
      name: 'Reaction Merge Bridge',
      entity_type: 'person',
      organization_id: ownerOrgId,
      created_by: ownerUserId,
    });
    const loser = await createTestEntity({
      name: 'Reaction Merge Loser',
      entity_type: 'person',
      organization_id: ownerOrgId,
      created_by: ownerUserId,
    });
    await sql`
      UPDATE entities
      SET metadata = CASE id
        WHEN ${winner.id} THEN ${sql.json({ email: 'shared@test.example', phone: '+44 7700 900001', handle: 'winner' })}
        WHEN ${bridge.id} THEN ${sql.json({ email: 'shared@test.example', phone: '+44 7700 900002' })}
        WHEN ${loser.id} THEN ${sql.json({ phone: '+44 7700 900002' })}
      END
      WHERE id IN (${winner.id}, ${bridge.id}, ${loser.id})
    `;
    await sql`
      UPDATE entity_types
      SET metadata_schema = ${sql.json({
        type: 'object',
        'x-lobu-resolution': {
          rules: [
            { fields: ['email'], normalizer: 'email', onMatch: 'review' },
            { fields: ['phone'], normalizer: 'phone', onMatch: 'review' },
          ],
        },
      })}
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
    `;

    const template = BEHAVIOR_CATALOG_TEMPLATES.find((t) => t.id === 'duplicate-merge');
    if (!template) throw new Error('duplicate-merge watcher template is missing');
    const reactionScript = String(template.detail.reaction_script);

    const created = (await owner.behaviors.create({
      slug: 'reaction-merge-exec-watcher',
      name: 'Reaction Merge Exec Watcher',
      prompt: 'Find and merge duplicate people.',
      agent_id: agentId,
      sources: template.detail.sources,
      reaction_script: reactionScript,
    })) as { behavior_id: string };
    const watcherId = Number(created.behavior_id);

    const [installed] = await sql<{ reaction_script_compiled: string | null }[]>`
      SELECT reaction_script_compiled FROM watchers WHERE id = ${watcherId}
    `;
    expect(installed?.reaction_script_compiled).toBeTruthy();

    const windowId = 987654;
    const res = await executeReaction({
      compiledScript: installed?.reaction_script_compiled as string,
      context: {
        extracted_data: {
          analysis_summary: 'The source contains one exact-identity component.',
          uncertain_groups: [],
        },
        entities: [],
        window: {
          id: windowId,
          behavior_id: watcherId,
          window_start: new Date('2026-01-01').toISOString(),
          window_end: new Date('2026-01-02').toISOString(),
          granularity: 'day',
          content_analyzed: 1,
        },
        behavior: {
          id: watcherId,
          slug: 'reaction-merge-exec-watcher',
          name: 'Reaction Merge Exec Watcher',
          version: 1,
        },
        organization_id: ownerOrgId,
      } as never,
      env: {
        ...process.env,
        JWT_SECRET: 'test-jwt-secret-for-testing-only',
      } as Record<string, string | undefined>,
    });
    expect(res.error ?? null).toBeNull();
    expect(res.success).toBe(true);

    const pending = await sql<
      {
        watcher_id: number | null;
        window_id: number | null;
        approval_status: string;
        status: string;
      }[]
    >`
      SELECT watcher_id, window_id, approval_status, status
      FROM runs
      WHERE organization_id = ${ownerOrgId}
        AND run_type = 'internal'
        AND action_input->>'operation' = 'merge'
        AND action_input->>'winner_entity_id' = ${String(winner.id)}
    `;
    expect(pending).toHaveLength(1);
    expect(Number(pending[0].watcher_id)).toBe(watcherId);
    expect(Number(pending[0].window_id)).toBe(windowId);
    expect(pending[0].approval_status).toBe('pending');
    expect(pending[0].status).toBe('pending');

    const [pendingInput] = await sql<{ entity_ids: number[] }[]>`
      SELECT action_input->'entity_ids' AS entity_ids
      FROM runs
      WHERE organization_id = ${ownerOrgId}
        AND run_type = 'internal'
        AND action_input->>'operation' = 'merge'
        AND action_input->>'winner_entity_id' = ${String(winner.id)}
    `;
    expect(pendingInput.entity_ids.map(Number)).toEqual([bridge.id]);

    const duplicateRows = await sql<
      { id: number; merged_into: number | null; deleted_at: string | null }[]
    >`
      SELECT id, merged_into, deleted_at
      FROM entities
      WHERE id IN (${bridge.id}, ${loser.id})
      ORDER BY id
    `;
    expect(duplicateRows.map((row) => Number(row.id))).toEqual(
      [bridge.id, loser.id].sort((a, b) => a - b)
    );
    expect(duplicateRows.every((row) => row.merged_into === null)).toBe(true);
    expect(duplicateRows.every((row) => row.deleted_at === null)).toBe(true);

    await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
  });

  it('does not create a watcher when its reaction fails compilation', async () => {
    await expect(
      owner.behaviors.create({
        slug: 'invalid-reaction-watcher',
        name: 'Invalid Reaction Watcher',
        prompt: 'Return merge proposals.',
        agent_id: agentId,
        reaction_script: 'export default async function reaction() {',
      })
    ).rejects.toThrow();

    const [row] = await getTestDb()<{ id: number }[]>`
      SELECT id FROM watchers WHERE slug = 'invalid-reaction-watcher'
    `;
    expect(row).toBeUndefined();
  });

  it('concurrent creates of the same slug: one wins, every loser gets the coded 409 (not raw 23505)', async () => {
    // The slug precheck SELECT is not a lock, so concurrent replicas can all
    // pass it and race idx_watchers_org_slug. Fire many at once: exactly one
    // wins, and every loser must surface the SAME coded 409 the sequential
    // precheck emits — not a raw Postgres "duplicate key value" 23505.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        owner.behaviors.create({
          slug: 'race-watcher',
          name: 'Race Watcher',
          prompt: 'Track races.',
          agent_id: agentId,
        })
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(5);
    for (const r of rejected) {
      const e = r.reason as Error & { httpStatus?: number };
      expect(e.message).toMatch(/Behavior with slug .*already exists/);
      expect(e.message).not.toMatch(/23505|duplicate key value/);
      expect(e.httpStatus).toBe(409);
    }
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ behavior_id: string }>).value;
    await owner.behaviors.delete({ behavior_ids: [winner.behavior_id] });
  });

  it('concurrent creates of DISTINCT slugs all succeed with unique ids (no PK collision)', async () => {
    // Directly covers the moved id allocation: getNextNumericId now runs inside
    // the transaction so its advisory xact lock serializes. Pre-fix, concurrent
    // creates computed the same MAX(id)+1 on the pooled autocommit connection
    // and collided on the watcher PK even with different slugs.
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        owner.behaviors.create({
          slug: `distinct-race-${i}`,
          name: `Distinct Race ${i}`,
          prompt: 'Track things.',
          agent_id: agentId,
        })
      )
    );
    const ids = results.map((r) => (r as { behavior_id: string }).behavior_id);
    expect(ids.length).toBe(N);
    expect(new Set(ids).size).toBe(N); // all unique — no PK collision
    await owner.behaviors.delete({ behavior_ids: ids });
  });

  it('concurrent group-locked writes on DISTINCT groups do not exhaust the pool (holder starvation)', async () => {
    // withWatcherGroupLock holders keep a main-pool connection for the whole
    // handler run. With N >= DB_POOL_MAX concurrent writes on DISTINCT groups
    // (nothing serializes them), the holders camp every slot and their own
    // handlers can't get a connection for reads/transactions — a permanent
    // pool-wide wedge. Regression guard for the dedicated lock pool: N
    // concurrent create_from_version calls, each from its OWN source watcher
    // (own group), must all complete.
    const sql = getTestDb();

    const N = 6; // > the CI pool of DB_POOL_MAX=5
    const versionIds: number[] = [];
    const baseIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const base = (await owner.behaviors.create({
        entity_id: entityId,
        slug: `cfv-group-race-base-${i}`,
        name: `CFV Group Race Base ${i}`,
        prompt: 'Track things.',
        agent_id: agentId,
        sources: [{ name: 'content', query: 'SELECT id FROM events' }],
      })) as { behavior_id: string };
      baseIds.push(base.behavior_id);
      const [row] = await sql<{ current_version_id: number }[]>`
        SELECT current_version_id FROM watchers WHERE id = ${base.behavior_id}
      `;
      versionIds.push(Number(row?.current_version_id));
    }

    const targets: number[] = [];
    for (let i = 0; i < N; i++) {
      const e = (await owner.entities.create({
        type: 'company',
        name: `CFV Group Race Target ${i}`,
      })) as { entity: { id: number } };
      targets.push(e.entity.id);
    }

    // N truly-parallel group-locked writes: distinct groups, so the group lock
    // serializes nothing and all N handlers run concurrently.
    const results = await Promise.all(
      versionIds.map((vid, i) =>
        owner.behaviors.createFromVersion({
          version_id: vid,
          entity_ids: [targets[i]],
        })
      )
    );
    const createdIds = results.flatMap((r) =>
      (r as { created: Array<{ behavior_id: string }> }).created.map((c) => c.behavior_id)
    );
    expect(createdIds.length).toBe(N);
    expect(new Set(createdIds).size).toBe(N); // all unique — the cross-group id race
    await owner.behaviors.delete({ behavior_ids: [...baseIds, ...createdIds] });
  });

  it('concurrent create_from_version fan-outs allocate unique ids (no PK collision)', async () => {
    // create_from_version allocated ids on the pooled autocommit connection —
    // the same anti-pattern the create handler had. Fire many concurrent
    // assignments to DISTINCT entities: each produces a distinct slug, so the
    // only way to fail is the watchers PK colliding on a shared MAX(id)+1.
    const sql = getTestDb();

    const base = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'cfv-race-base',
      name: 'CFV Race Base',
      prompt: 'Track things.',
      agent_id: agentId,
      sources: [{ name: 'content', query: 'SELECT id FROM events' }],
    })) as { behavior_id: string };
    const [row] = await sql<{ current_version_id: number }[]>`
      SELECT current_version_id FROM watchers WHERE id = ${base.behavior_id}
    `;
    const versionId = Number(row?.current_version_id);

    // Distinct target entities → distinct derived slugs, so no slug race.
    const N = 6;
    const targets: number[] = [];
    for (let i = 0; i < N; i++) {
      const e = (await owner.entities.create({
        type: 'company',
        name: `CFV Target ${i}`,
      })) as { entity: { id: number } };
      targets.push(e.entity.id);
    }

    const results = await Promise.all(
      targets.map((eid) =>
        owner.behaviors.createFromVersion({
          version_id: versionId,
          entity_ids: [eid],
        })
      )
    );
    const createdIds = results.flatMap((r) =>
      (r as { created: Array<{ behavior_id: string }> }).created.map((c) => c.behavior_id)
    );
    expect(createdIds.length).toBe(N);
    expect(new Set(createdIds).size).toBe(N); // all unique — no PK collision
    await owner.behaviors.delete({
      behavior_ids: [base.behavior_id, ...createdIds],
    });
  });

  it('concurrent create_from_version to the SAME entity: one wins, losers get a coded 409 (not raw 23505)', async () => {
    // A repeated assignment to the same entity produces the SAME derived slug.
    // The insert isn't pre-checked and isn't locked, so concurrent fan-outs race
    // idx_watchers_org_slug. The loser must surface a coded 409, not a raw 23505,
    // and no partial fan-out may leak (single-entity here, but the transaction is
    // what guarantees all-or-nothing for multi-entity calls).
    const sql = getTestDb();

    const base = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'cfv-slug-race-base',
      name: 'CFV Slug Race Base',
      prompt: 'Track things.',
      agent_id: agentId,
      sources: [{ name: 'content', query: 'SELECT id FROM events' }],
    })) as { behavior_id: string };
    const [row] = await sql<{ current_version_id: number }[]>`
      SELECT current_version_id FROM watchers WHERE id = ${base.behavior_id}
    `;
    const versionId = Number(row?.current_version_id);

    const target = (await owner.entities.create({
      type: 'company',
      name: 'CFV Slug Race Target',
    })) as { entity: { id: number } };

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        owner.behaviors.createFromVersion({
          version_id: versionId,
          entity_ids: [target.entity.id],
        })
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(5);
    for (const r of rejected) {
      const e = r.reason as Error & { httpStatus?: number };
      expect(e.message).not.toMatch(/23505|duplicate key value/);
      expect(e.httpStatus).toBe(409);
    }
    const winnerIds = (
      fulfilled[0] as PromiseFulfilledResult<{
        created: Array<{ behavior_id: string }>;
      }>
    ).value.created.map((c) => c.behavior_id);
    await owner.behaviors.delete({
      behavior_ids: [base.behavior_id, ...winnerIds],
    });
  });

  it('multi-entity create_from_version is all-or-nothing: a mid-fan-out collision rolls back the earlier target too', async () => {
    // The fan-out runs in one transaction. If a LATER target's derived slug
    // already exists, the whole call must roll back — the EARLIER target in the
    // same call must not leak a half-created watcher. This is the atomicity the
    // transaction wrapper exists for; without it the earlier insert would commit.
    const sql = getTestDb();

    const base = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'cfv-rollback-base',
      name: 'CFV Rollback Base',
      prompt: 'Track things.',
      agent_id: agentId,
      sources: [{ name: 'content', query: 'SELECT id FROM events' }],
    })) as { behavior_id: string };
    const [row] = await sql<{ current_version_id: number }[]>`
      SELECT current_version_id FROM watchers WHERE id = ${base.behavior_id}
    `;
    const versionId = Number(row?.current_version_id);

    const freshTarget = (await owner.entities.create({
      type: 'company',
      name: 'CFV Rollback Fresh',
    })) as { entity: { id: number } };
    const collidingTarget = (await owner.entities.create({
      type: 'company',
      name: 'CFV Rollback Colliding',
    })) as { entity: { id: number } };

    // Seed the colliding target so a SECOND assignment to it clashes on the
    // derived slug. This assignment succeeds on its own.
    const seed = (await owner.behaviors.createFromVersion({
      version_id: versionId,
      entity_ids: [collidingTarget.entity.id],
    })) as { created: Array<{ behavior_id: string }> };
    expect(seed.created.length).toBe(1);

    // Now fan out to [fresh, colliding]. The colliding insert hits the seeded
    // slug → 23505 → coded 409, and the whole tx rolls back.
    await expect(
      owner.behaviors.createFromVersion({
        version_id: versionId,
        entity_ids: [freshTarget.entity.id, collidingTarget.entity.id],
      })
    ).rejects.toMatchObject({ httpStatus: 409 });

    // The earlier (fresh) target must have NO watcher — the rollback took it.
    const leaked = await sql<{ id: number }[]>`
      SELECT id FROM watchers
      WHERE organization_id = ${ownerOrgId} AND ${freshTarget.entity.id} = ANY(entity_ids)
    `;
    expect(leaked.length).toBe(0);

    await owner.behaviors.delete({
      behavior_ids: [base.behavior_id, ...seed.created.map((c) => c.behavior_id)],
    });
  });

  it('creates an org-scoped watcher without an inline extraction schema', async () => {
    const created = (await owner.behaviors.create({
      slug: 'org-scoped-summary-watcher',
      name: 'Org Scoped Summary Watcher',
      prompt: 'Summarize recent workspace activity.',
      triggers: [{ kind: 'schedule', cron: '0 12 * * *' }],
      agent_id: agentId,
    })) as { behavior_id: string };

    const got = (await owner.behaviors.get({
      behavior_id: created.behavior_id,
    })) as {
      behavior?: { entity_id?: number | null };
    };
    expect(got.behavior?.entity_id ?? null).toBeNull();
  });

  it('derives sources[] from @-mention tokens in the prompt (no sources sent)', async () => {
    // The owletto composer serializes a picked reference into the prompt as an
    // inline `@[kind:id:label](path)` token and sends ONLY the raw prompt — the
    // backend derives sources[]. A `sql` token carries its query URL-encoded in
    // the path (`#sql=…`); we use it here because it resolves without any seeded
    // feed/connection (a raw-SQL source is a valid custom source).
    const query = 'SELECT id, payload_text FROM events ORDER BY occurred_at DESC';
    const sqlPath = `#sql=${encodeURIComponent(query).replace(
      /[()'!*~]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    )}`;
    const prompt = `Summarize @[sql:recent:Recent events](${sqlPath}) each morning.`;

    const created = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'prompt-derived-sources-watcher',
      name: 'Prompt Derived Sources Watcher',
      prompt,
      agent_id: agentId,
      // NOTE: no `sources` — the backend must derive them from the prompt token.
    })) as { behavior_id: string };

    const got = (await owner.behaviors.get({
      behavior_id: created.behavior_id,
    })) as {
      behavior?: { sources?: Array<{ name: string; query: string }> | null };
    };
    expect(got.behavior?.sources).toEqual([{ name: 'recent_events', query }]);

    await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
  });

  it('a version bump does not re-derive sources from the prompt — the caller sends them', async () => {
    // The prompt is compiled skill text since #2331, so its `@`-tokens are the
    // skill's prose, not an authoring surface. Changing a source is explicit.
    const enc = (q: string) =>
      `#sql=${encodeURIComponent(q).replace(
        /[()'!*~]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      )}`;
    const oldQuery = "SELECT id FROM events WHERE payload_type = 'a'";
    const newQuery = "SELECT id FROM events WHERE payload_type = 'b'";

    const created = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'sql-edit-rederive-watcher',
      name: 'SQL Edit Rederive Watcher',
      prompt: `Watch @[sql:recent:Recent](${enc(oldQuery)}).`,
      agent_id: agentId,
    })) as { behavior_id: string };

    const readSources = async () => {
      const got = (await owner.behaviors.get({
        behavior_id: created.behavior_id,
      })) as {
        behavior?: { sources?: Array<{ name: string; query: string }> | null };
      };
      return got.behavior?.sources ?? [];
    };

    // A new prompt naming a different query leaves the stored source alone.
    await owner.behaviors.createVersion({
      behavior_id: created.behavior_id,
      prompt: `Watch @[sql:recent:Recent](${enc(newQuery)}).`,
      change_notes: 'edit sql',
    });
    expect(await readSources()).toEqual([{ name: 'recent', query: oldQuery }]);

    // Sending `sources` replaces wholesale — no stranded old query, no
    // suffixed `recent_2`.
    await owner.behaviors.createVersion({
      behavior_id: created.behavior_id,
      sources: [{ name: 'recent', query: newQuery }],
      change_notes: 'repoint source',
    });
    expect(await readSources()).toEqual([{ name: 'recent', query: newQuery }]);

    await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
  });

  it('removing every @-mention chip does not clear sources — `sources: []` does', async () => {
    const enc = (q: string) =>
      `#sql=${encodeURIComponent(q).replace(
        /[()'!*~]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      )}`;
    const query = 'SELECT id FROM events';
    const created = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'clear-sources-on-edit-watcher',
      name: 'Clear Sources On Edit Watcher',
      prompt: `Watch @[sql:recent:Recent](${enc(query)}).`,
      agent_id: agentId,
    })) as { behavior_id: string };

    const readSources = async () => {
      const got = (await owner.behaviors.get({
        behavior_id: created.behavior_id,
      })) as {
        behavior?: { sources?: Array<{ name: string; query: string }> | null };
      };
      return got.behavior?.sources ?? [];
    };

    await owner.behaviors.createVersion({
      behavior_id: created.behavior_id,
      prompt: 'Just watch everything, no specific source.',
      change_notes: 'remove chip',
    });
    expect(await readSources()).toEqual([{ name: 'recent', query }]);

    await owner.behaviors.createVersion({
      behavior_id: created.behavior_id,
      sources: [],
      change_notes: 'clear sources',
    });
    expect(await readSources()).toEqual([]);

    await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
  });

  it('round-trips execution_config through create → list → update', async () => {
    const created = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'exec-config-watcher',
      name: 'Exec Config Watcher',
      prompt: 'Track things.',
      agent_id: agentId,
      execution_config: {
        timeout_seconds: 1800,
        max_budget_usd: 2.5,
        model: 'opus',
        permission_mode: 'acceptEdits',
        effort: 'high',
      },
    })) as { behavior_id: string };
    const watcherId = created.behavior_id;

    const findRow = (
      res: {
        behaviors?: Array<{
          behavior_id: string;
          execution_config?: Record<string, unknown> | null;
        }>;
      },
      id: string
    ) => res.behaviors?.find((w) => String(w.behavior_id) === String(id));

    const list = (await owner.behaviors.list({ entity_id: entityId })) as {
      behaviors?: Array<{
        behavior_id: string;
        execution_config?: Record<string, unknown>;
      }>;
    };
    expect(findRow(list, watcherId)?.execution_config).toEqual({
      timeout_seconds: 1800,
      max_budget_usd: 2.5,
      model: 'opus',
      permission_mode: 'acceptEdits',
      effort: 'high',
    });

    // Update replaces the whole jsonb; a partial object is stored verbatim.
    await owner.behaviors.update({
      behavior_id: watcherId,
      execution_config: { timeout_seconds: 300 },
    });
    const after = (await owner.behaviors.list({ entity_id: entityId })) as {
      behaviors?: Array<{
        behavior_id: string;
        execution_config?: Record<string, unknown>;
      }>;
    };
    expect(findRow(after, watcherId)?.execution_config).toEqual({
      timeout_seconds: 300,
    });

    // Passing null clears the saved config back to NULL/defaults.
    await owner.behaviors.update({
      behavior_id: watcherId,
      execution_config: null,
    });
    const cleared = (await owner.behaviors.list({ entity_id: entityId })) as {
      behaviors?: Array<{
        behavior_id: string;
        execution_config?: Record<string, unknown> | null;
      }>;
    };
    expect(findRow(cleared, watcherId)?.execution_config ?? null).toBeNull();

    await owner.behaviors.delete({ behavior_ids: [watcherId] });
  });

  it('leaves execution_config null when unset', async () => {
    const created = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'no-exec-config-watcher',
      name: 'No Exec Config',
      prompt: 'Track things.',
      agent_id: agentId,
    })) as { behavior_id: string };

    const list = (await owner.behaviors.list({ entity_id: entityId })) as {
      behaviors?: Array<{
        behavior_id: string;
        execution_config?: Record<string, unknown> | null;
      }>;
    };
    const row = list.behaviors?.find((w) => String(w.behavior_id) === String(created.behavior_id));
    expect(row).toBeDefined();
    expect(row?.execution_config ?? null).toBeNull();

    await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
  });

  it('rejects an invalid execution_config (type/range/unknown-key)', async () => {
    const base = {
      entity_id: entityId,
      name: 'Bad Exec',
      prompt: 'x',
      agent_id: agentId,
    };
    // timeout_seconds below minimum
    await expect(
      owner.behaviors.create({
        ...base,
        slug: 'bad-1',
        execution_config: { timeout_seconds: 0 },
      })
    ).rejects.toThrow(/execution_config/i);
    // uncoercible type (non-numeric string where integer expected) — would
    // otherwise brick the Swift payload decode at run time. A numeric string
    // like '600' is coerced to 600 by boundary validation instead.
    await expect(
      owner.behaviors.create({
        ...base,
        slug: 'bad-2',
        execution_config: { timeout_seconds: 'abc' },
      } as never)
    ).rejects.toThrow(/execution_config/i);
    // unknown key (additionalProperties: false)
    await expect(
      owner.behaviors.create({
        ...base,
        slug: 'bad-3',
        execution_config: { bogus: true },
      } as never)
    ).rejects.toThrow(/execution_config/i);
    // above maximum
    await expect(
      owner.behaviors.create({
        ...base,
        slug: 'bad-4',
        execution_config: { timeout_seconds: 999_999 },
      })
    ).rejects.toThrow(/execution_config/i);
  });

  it('creates an org-scoped watcher with no entity_id', async () => {
    const created = (await owner.behaviors.create({
      slug: 'org-scoped-watcher',
      name: 'Org Scoped',
      prompt: 'Track org-wide signals.',
      agent_id: agentId,
    })) as { behavior_id: string };
    expect(created.behavior_id).toBeDefined();

    const got = (await owner.behaviors.get({
      behavior_id: created.behavior_id,
    })) as {
      behavior?: { entity_ids?: number[] };
    };
    expect(got.behavior?.entity_ids ?? []).toEqual([]);

    await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
  });

  it('rejects an org-scoped watcher when there is no organization context', async () => {
    const noOrg = owner.withAuth({ organizationId: null });
    await expect(
      noOrg.behaviors.create({
        slug: 'no-org-watcher',
        name: 'No Org',
        prompt: 'should fail',
        agent_id: agentId,
      })
    ).rejects.toThrow(/organization|entity_id/i);
  });

  it('blocks cross-org reads and writes for org-scoped watchers', async () => {
    const created = (await owner.behaviors.create({
      slug: 'cross-org-org-scoped-watcher',
      name: 'Cross Org Protected',
      prompt: 'Track org-wide signals.',
      agent_id: agentId,
    })) as { behavior_id: string };

    await expect(intruder.behaviors.get({ behavior_id: created.behavior_id })).rejects.toThrow(
      /access|organization/i
    );
    await expect(
      intruder.behaviors.update({
        behavior_id: created.behavior_id,
        triggers: [{ kind: 'schedule', cron: '0 11 * * *' }],
      })
    ).rejects.toThrow(/access|organization/i);
    await expect(intruder.behaviors.delete({ behavior_ids: [created.behavior_id] })).rejects.toThrow(
      /access|organization/i
    );

    const got = (await owner.behaviors.get({
      behavior_id: created.behavior_id,
    })) as {
      behavior?: { triggers: unknown[] };
    };
    expect(got.behavior?.triggers).toEqual([]);

    await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
  });

  it('blocks a member from deleting watchers (admin-only)', async () => {
    const created = (await owner.behaviors.create({
      entity_id: entityId,
      slug: 'protected-watcher',
      name: 'Protected',
      prompt: 'guarded.',
      agent_id: agentId,
    })) as { behavior_id: string };

    const member = owner.withAuth({ memberRole: 'member' });
    await expect(member.behaviors.delete({ behavior_ids: [created.behavior_id] })).rejects.toThrow(
      /admin|owner|access/i
    );
  });

  // Issue #1060: a device pin (watchers.device_worker_id) runs the watcher's
  // agent CLI on the device owner's machine, so create/update must verify the
  // caller may target that device. The exhaustive role × ownership matrix is in
  // src/__tests__/unit/behavior-device-access.test.ts; this proves the gate is
  // wired into the handlers end-to-end (device_worker_id only reaches the
  // handler via the raw `manage()` escape hatch — the typed input omits it).
  describe('device_worker_id ownership gate', () => {
    async function seedDevice(opts: {
      userId: string;
      organizationId: string | null;
      worker: string;
    }): Promise<string> {
      const sql = getTestDb();
      const rows = (await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
        VALUES (${opts.userId}, ${opts.worker}, 'macos', ${sql.json([])}, 'Seed Device', ${opts.organizationId})
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      return String(rows[0].id);
    }

    it('lets an org owner pin a foreign device attached to their org', async () => {
      // A different user's device, but it lives in the owner's org → allowed
      // for an owner/admin role.
      const deviceId = await seedDevice({
        userId: otherUserId,
        organizationId: ownerOrgId,
        worker: 'dev-in-org',
      });
      const created = (await owner.behaviors.manage({
        action: 'create',
        entity_id: entityId,
        slug: 'device-pin-allowed',
        name: 'Device Pin Allowed',
        prompt: 'x',
        agent_id: agentId,
        device_worker_id: deviceId,
      })) as { behavior_id: string };
      expect(created.behavior_id).toBeDefined();

      const got = (await owner.behaviors.get({
        behavior_id: created.behavior_id,
      })) as {
        behavior?: { device_worker_id?: string | null };
      };
      expect(got.behavior?.device_worker_id).toBe(deviceId);
      await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
    });

    it('rejects pinning to a device in another org (create)', async () => {
      // Device owned by another user AND attached to another org — even an owner
      // cannot pin it; this is the privilege-escalation case.
      const foreignDeviceId = await seedDevice({
        userId: otherUserId,
        organizationId: otherOrgId,
        worker: 'dev-foreign-org',
      });
      await expect(
        owner.behaviors.manage({
          action: 'create',
          entity_id: entityId,
          slug: 'device-pin-foreign',
          name: 'Device Pin Foreign',
          prompt: 'x',
          agent_id: agentId,
          device_worker_id: foreignDeviceId,
        })
      ).rejects.toThrow(/device you own|not found or not accessible/i);
    });

    it('rejects pinning to a nonexistent device (create)', async () => {
      await expect(
        owner.behaviors.manage({
          action: 'create',
          entity_id: entityId,
          slug: 'device-pin-missing',
          name: 'Device Pin Missing',
          prompt: 'x',
          agent_id: agentId,
          device_worker_id: '00000000-0000-0000-0000-000000000000',
        })
      ).rejects.toThrow(/not found or not accessible/i);
    });

    it('rejects re-pinning an existing watcher to a foreign-org device (update)', async () => {
      const created = (await owner.behaviors.create({
        entity_id: entityId,
        slug: 'device-pin-update',
        name: 'Device Pin Update',
        prompt: 'x',
        agent_id: agentId,
      })) as { behavior_id: string };

      const foreignDeviceId = await seedDevice({
        userId: otherUserId,
        organizationId: otherOrgId,
        worker: 'dev-foreign-update',
      });
      await expect(
        owner.behaviors.manage({
          action: 'update',
          behavior_id: created.behavior_id,
          device_worker_id: foreignDeviceId,
        })
      ).rejects.toThrow(/device you own|not found or not accessible/i);

      await owner.behaviors.delete({ behavior_ids: [created.behavior_id] });
    });
  });
});
