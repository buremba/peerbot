/**
 * Tool: manage_watchers
 *
 * Manage self-contained watcher definitions with client-driven execution.
 *
 * Actions:
 * - create: Create watcher with prompt/schema/sources directly
 * - update: Modify config (model, schedule, sources)
 * - create_version: Create a new version for a watcher (prompt/schema/sources)
 * - create_from_version: Create a new watcher from an existing version
 * - complete_window: Complete a window using window_token from read_knowledge
 * - trigger: Manually trigger a watcher run
 * - delete: Remove watcher
 * - set_reaction_script: Attach automated TypeScript reaction
 * - get_versions: View version history for a watcher
 * - get_version_details: Get full config for a specific version
 * - get_component_reference: Get available components and data types documentation
 * - submit_feedback: Submit feedback on a watcher window
 * - get_feedback: Retrieve feedback for a watcher
 *
 * This file is the entry point only — action handlers live in ./manage_watchers/.
 */

import {
  ListWatchersResultSchema,
  ListWatchersSchema,
  ManageWatchersResultSchema,
  ManageWatchersSchema,
  type ListWatchersArgs,
  type ListWatchersResult,
  type ManageWatchersArgs,
  type ManageWatchersResult,
} from '@lobu/core/contracts/tools/manage-watchers';
import type { ReservedSql } from 'postgres';
import {
  resolveActingPrincipal,
  resolveWritePolicyDecision,
} from '../../authz/entity-policy';
import { createDbClientFromEnv, getDb } from '../../db/client';
import type { Env } from '../../index';
import { ToolUserError } from '../../utils/errors';
import {
  requireOrgReadAccess,
  requireOrgWriteAccess,
  requireReadAccess,
  requireWriteAccess,
} from '../../utils/organization-access';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { defineFlatActionTool, flatAction } from './action-tool';
import { requireWatcherAccess } from './manage_watchers/shared';
import { handleCreate, handleUpdate, handleDelete, handleCreateFromVersion } from './manage_watchers/crud';
import { handleCreateVersion, handleGetVersions, handleGetVersionDetails } from './manage_watchers/version-actions';
import { handleCompleteWindow } from './manage_watchers/complete-window';
import { handleTrigger, handleSetReactionScript } from './manage_watchers/trigger';
import {
  handleSubmitFeedback,
  handleGetFeedback,
  handleListPromoted,
} from './manage_watchers/feedback';
import { handleGetComponentReference } from './manage_watchers/reference';
import { handleList } from './manage_watchers/list';

export {
  ListWatchersResultSchema,
  ListWatchersSchema,
  ManageWatchersResultSchema,
  ManageWatchersSchema,
};
export type { ManageWatchersArgs, ManageWatchersResult };

// ============================================
// Main Function
// ============================================

export const manageWatchers = withValidatedArgs(
  'manage_watchers',
  ManageWatchersSchema,
  manageWatchersImpl
);

async function manageWatchersImpl(
  args: ManageWatchersArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageWatchersResult> {
  const pgSql = createDbClientFromEnv(env);

  // Validate organization access based on action type
  if (args.action === 'create') {
    if (args.entity_id) {
      await requireWriteAccess(pgSql, args.entity_id, ctx);
    } else {
      await requireOrgWriteAccess(pgSql, ctx);
    }
  } else if (args.action === 'update' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'trigger' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'delete' && args.watcher_ids && args.watcher_ids.length > 0) {
    await requireWatcherAccess(pgSql, args.watcher_ids, ctx, 'write');
  } else if (args.action === 'complete_window' && args.entity_id) {
    await requireWriteAccess(pgSql, args.entity_id, ctx);
  } else if (args.action === 'create_version' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'set_reaction_script' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'submit_feedback' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'write');
  } else if (args.action === 'get_feedback' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'read');
  } else if (args.action === 'list_promoted' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'read');
  } else if (args.action === 'get_versions' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'read');
  } else if (args.action === 'get_version_details' && args.watcher_id) {
    await requireWatcherAccess(pgSql, [args.watcher_id], ctx, 'read');
  } else if (args.action === 'create_from_version' && args.entity_ids) {
    for (const eid of args.entity_ids) {
      await requireWriteAccess(pgSql, eid, ctx);
    }
  }

  // A watcher IS agent config — it's an autonomous-execution definition (prompt,
  // SQL source, reaction). Gate its create/update/delete under the `agent_config`
  // write class, exactly like editing an agent. A human member applies immediately
  // (resolveWritePolicyDecision returns 'allow' for users); a non-human principal
  // follows the org policy (default: create/update need approval, delete denied).
  // This closes the two-step self-escalation: an agent whose own agent_config
  // writes require approval can no longer freely mint a watcher to escape its
  // envelope.
  //
  // TOCTOU: gateWatcherWrite's escalation guard reads the affected watcher owners
  // (resolveEffectiveWatcherOwners) and the mutation writes them, but on SEPARATE
  // pooled connections. A concurrent reassign of the target watcher's agent_id
  // could slip between the check and the write, so the guard would pass on owner A
  // while the behavior lands on a now-B-owned watcher. We serialize both the guard
  // AND the mutation under ONE session-level advisory lock keyed by the target's
  // watcher_group_id. EVERY mutating action that has a resolvable target group
  // takes the lock — human or non-human — because the racing reassign is itself an
  // `update` that flows through this same path, so the lock makes them mutually
  // exclusive. Actions with no existing target group (`create`) skip the lock.
  return withWatcherGroupLock(args, ctx, async () => {
    await gateWatcherWrite(args, ctx);
    return runManageWatchers(args, env, ctx);
  });
}

/**
 * Namespace half of the (int, int) advisory-lock key. Pairs with the
 * watcher_group_id so unrelated lock users never collide with a bare group id.
 * Distinct from the `watcher_create_version` key version-actions.ts takes inside
 * its own handler — that's a different, tx-scoped lock; nesting two distinct
 * advisory keys is safe. This one is SESSION scope so it can span the guard read
 * and the mutation write, which run on different pooled connections.
 */
const WATCHER_GROUP_LOCK_NS = 'watcher_group_ownership';

/**
 * Resolve the watcher_group_id whose ownership this action touches — the row the
 * escalation guard reads and the mutation writes must not have its owner changed
 * underneath us. Returns null when there is no pre-existing group to race on:
 *   - `create` mints a brand-new row (no target yet).
 *   - `update` targets args.watcher_id → its group.
 *   - `create_version` / `set_reaction_script` write GROUP-WIDE off args.watcher_id.
 *   - `create_from_version` reads a SOURCE version → lock the source watcher's group
 *     so a concurrent reassign of the source can't change the owner we clone.
 * All lookups are org-scoped.
 */
async function resolveTargetWatcherGroupId(
  args: ManageWatchersArgs,
  ctx: ToolContext,
): Promise<number | null> {
  const sql = getDb();
  if (args.action === 'update' || args.action === 'create_version' || args.action === 'set_reaction_script') {
    if (args.watcher_id == null) return null;
    const rows = await sql<{ watcher_group_id: number | null }>`
      SELECT watcher_group_id FROM watchers
      WHERE id = ${Number(args.watcher_id)} AND organization_id = ${ctx.organizationId}
      LIMIT 1
    `;
    const gid = rows.length > 0 ? rows[0].watcher_group_id : null;
    return gid == null ? null : Number(gid);
  }
  if (args.action === 'create_from_version') {
    if (args.version_id == null) return null;
    const rows = await sql<{ watcher_group_id: number | null }>`
      SELECT w.watcher_group_id
      FROM watcher_versions wv JOIN watchers w ON w.id = wv.watcher_id
      WHERE wv.id = ${Number(args.version_id)} AND w.organization_id = ${ctx.organizationId}
      LIMIT 1
    `;
    const gid = rows.length > 0 ? rows[0].watcher_group_id : null;
    return gid == null ? null : Number(gid);
  }
  return null;
}

/**
 * Run `fn` (guard + mutation) while holding a SESSION-level Postgres advisory
 * lock on the action's target watcher_group_id. A session lock (vs. the
 * tx-scoped `pg_advisory_xact_lock`) is required because the guard read and the
 * mutation write happen on different pooled connections and across separate
 * transactions — a tx-scoped lock would release at the guard's implicit commit,
 * before the mutation runs. We acquire + release on ONE reserved connection so
 * the session identity is stable (any pool connection could otherwise serve the
 * unlock and PG would error `you don't own a lock of type ExclusiveLock`).
 *
 * Only the mutating write-gate actions with a resolvable target group are locked;
 * read-only actions and `create` (no pre-existing group) run `fn` directly.
 */
async function withWatcherGroupLock<T>(
  args: ManageWatchersArgs,
  ctx: ToolContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (watcherWriteAction(args.action) === null) return fn();
  const groupId = await resolveTargetWatcherGroupId(args, ctx);
  if (groupId == null) return fn();

  const sql = getDb();
  const reserved = (await (
    sql as unknown as { reserve: () => Promise<ReservedSql> }
  ).reserve()) as ReservedSql;
  try {
    await reserved`SELECT pg_advisory_lock(hashtext(${WATCHER_GROUP_LOCK_NS}), ${groupId})`;
    try {
      return await fn();
    } finally {
      await reserved`SELECT pg_advisory_unlock(hashtext(${WATCHER_GROUP_LOCK_NS}), ${groupId})`;
    }
  } finally {
    reserved.release();
  }
}

/** Maps a manage_watchers action to its agent_config write verb, or null for a
 * read-only / non-definition action that the write-gate doesn't govern. */
function watcherWriteAction(
  action: ManageWatchersArgs['action'],
): 'create' | 'update' | 'delete' | null {
  switch (action) {
    case 'create':
    case 'create_from_version':
      return 'create';
    case 'update':
    case 'create_version':
    case 'set_reaction_script':
      return 'update';
    case 'delete':
      return 'delete';
    default:
      // list/get/trigger/complete_window/feedback etc. aren't definition writes.
      return null;
  }
}

/**
 * EVERY agent that ends up OWNING behavior this write installs — resolved by what
 * each handler ACTUALLY persists, NOT the supplied `args.agent_id` (several handlers
 * ignore it). The guard requires all of them to be the actor itself. Returns `[]`
 * when there's nothing to check.
 *
 *  - `create`: the supplied `args.agent_id` (handleCreate requires it).
 *  - `create_from_version`: IGNORES args.agent_id — the clone inherits the SOURCE
 *    version's watcher.agent_id.
 *  - `update`: DOES apply args.agent_id → the target's new owner is
 *    `args.agent_id ?? current owner`.
 *  - `create_version` / `set_reaction_script`: IGNORE args.agent_id and write
 *    GROUP-WIDE (WHERE watcher_group_id = …) → EVERY owner in the target's group is
 *    affected; a mixed-owner group means A editing its assignment also rewrites B's
 *    prompt/reaction code. Validate ALL of them.
 *
 * All lookups are org-scoped so a caller can't probe another org.
 */
async function resolveEffectiveWatcherOwners(
  args: ManageWatchersArgs,
  ctx: ToolContext,
): Promise<Array<string | null>> {
  const sql = getDb();
  switch (args.action) {
    case 'create':
      return args.agent_id != null ? [args.agent_id] : [];
    case 'create_from_version': {
      if (!args.version_id) return [];
      const rows = await sql<{ agent_id: string | null }>`
        SELECT w.agent_id
        FROM watcher_versions wv JOIN watchers w ON w.id = wv.watcher_id
        WHERE wv.id = ${Number(args.version_id)} AND w.organization_id = ${ctx.organizationId}
        LIMIT 1
      `;
      return rows.length > 0 ? [rows[0].agent_id ?? null] : [];
    }
    case 'update': {
      if (args.agent_id != null) return [args.agent_id];
      if (args.watcher_id == null) return [];
      const rows = await sql<{ agent_id: string | null }>`
        SELECT agent_id FROM watchers
        WHERE id = ${Number(args.watcher_id)} AND organization_id = ${ctx.organizationId}
        LIMIT 1
      `;
      return rows.length > 0 ? [rows[0].agent_id ?? null] : [];
    }
    case 'create_version':
    case 'set_reaction_script': {
      if (args.watcher_id == null) return [];
      // Group-wide: EVERY owner in the target watcher's group is affected.
      const rows = await sql<{ agent_id: string | null }>`
        SELECT DISTINCT agent_id FROM watchers
        WHERE organization_id = ${ctx.organizationId}
          AND watcher_group_id = (
            SELECT watcher_group_id FROM watchers
            WHERE id = ${Number(args.watcher_id)} AND organization_id = ${ctx.organizationId}
            LIMIT 1
          )
      `;
      return rows.map((r) => r.agent_id ?? null);
    }
    default:
      return [];
  }
}

/**
 * Enforce the `agent_config` write-gate for a watcher definition write. No-op for
 * read-only actions and for human members (whose decision is always 'allow').
 * A non-human principal is refused on `deny` AND on `require_approval` — there is
 * no watcher-definition approval queue, so fail closed rather than silently apply.
 */
async function gateWatcherWrite(
  args: ManageWatchersArgs,
  ctx: ToolContext,
): Promise<void> {
  const action = watcherWriteAction(args.action);
  if (!action) return;
  // Resolve the actor through the shared seam. A reaction script editing watchers
  // acts as its own watcher (ctx.actingWatcherId) — the seam folds that watcher's
  // owning agent so the agent's agent_config envelope binds and the reaction can't
  // self-escalate. manage_watchers has no watcher_source arg, so only the session
  // watcher applies.
  const actor = await resolveActingPrincipal(getDb(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionWatcherId: ctx.actingWatcherId ?? null,
    sourceForMode: ctx.sourceContext?.source,
  });
  // Escalation guard: a non-human caller must not end up installing behavior OWNED by
  // another agent. A watcher's `agent_id` IS its policy principal, so if restricted
  // agent A could create/clone/edit a watcher (or a group-shared prompt/reaction)
  // that stays owned by looser agent B, every later run would fold B's (looser)
  // envelope instead of A's, side-stepping A's deny rules. We validate what each
  // handler ACTUALLY persists (see resolveEffectiveWatcherOwners) — NOT the supplied
  // `agent_id` (create_from_version/create_version/set_reaction_script ignore it) —
  // and ALL owners a group-wide write touches. EVERY affected owner must be the actor
  // itself. Humans are ungoverned here and may own/assign freely.
  if (actor.kind !== 'user') {
    const ownAgentId = actor.ownerAgentId ?? actor.id;
    const owners = await resolveEffectiveWatcherOwners(args, ctx);
    const foreign = owners.find((o) => o !== ownAgentId);
    if (foreign !== undefined) {
      throw new ToolUserError(
        `A ${actor.kind} cannot install watcher behavior owned by another agent — every affected owner must be itself (${ownAgentId ?? 'none'}); found ${foreign ?? 'none'}.`,
        403,
      );
    }
  }

  const decision = await resolveWritePolicyDecision({
    organizationId: ctx.organizationId,
    resourceClass: 'agent_config',
    principalKind: actor.kind,
    principalId: actor.id,
    ownerAgentId: actor.ownerAgentId,
    ownerResolved: actor.ownerResolved,
    mode: actor.mode,
    action,
  });
  if (decision === 'allow') return;
  throw new ToolUserError(
    decision === 'require_approval'
      ? `Editing watchers (agent config) requires approval for this principal; a watcher cannot be ${action}d autonomously.`
      : `Policy denies ${action} of watchers (agent config) for this principal.`,
    403,
  );
}

const runManageWatchers = defineFlatActionTool<ManageWatchersArgs, ManageWatchersResult>(
  'manage_watchers',
  {
    create: flatAction((args, ctx, env) => handleCreate(args, env, ctx)),
    update: flatAction((args, ctx, env) => handleUpdate(args, env, ctx)),
    create_version: flatAction((args, ctx, env) => handleCreateVersion(args, env, ctx)),
    complete_window: flatAction((args, ctx, env) => handleCompleteWindow(args, env, ctx)),
    trigger: flatAction((args, _ctx, env) => handleTrigger(args, env)),
    delete: flatAction((args, ctx) => handleDelete(args, ctx)),
    set_reaction_script: flatAction((args, ctx, env) => handleSetReactionScript(args, env, ctx)),
    get_versions: flatAction(handleGetVersions),
    get_version_details: flatAction(handleGetVersionDetails),
    get_component_reference: flatAction(() => Promise.resolve(handleGetComponentReference())),
    submit_feedback: flatAction(handleSubmitFeedback),
    get_feedback: flatAction(handleGetFeedback),
    list_promoted: flatAction(handleListPromoted),
    create_from_version: flatAction((args, ctx, env) => handleCreateFromVersion(args, env, ctx)),
  }
);

export const listWatchers = withValidatedArgs(
  'list_watchers',
  ListWatchersSchema,
  listWatchersImpl
);

async function listWatchersImpl(
  args: ListWatchersArgs,
  env: Env,
  ctx: ToolContext
): Promise<ListWatchersResult> {
  const pgSql = createDbClientFromEnv(env);
  if (args.entity_id) {
    await requireReadAccess(pgSql, args.entity_id, ctx);
  } else {
    await requireOrgReadAccess(pgSql, ctx);
  }
  return handleList(args, env, ctx);
}

