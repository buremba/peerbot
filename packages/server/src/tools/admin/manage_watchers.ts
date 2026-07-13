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
  type ManageWatchersProposal,
  type ManageWatchersResult,
} from '@lobu/core/contracts/tools/manage-watchers';
import type { ReservedSql } from 'postgres';
import {
  resolveActingPrincipal,
  resolveWritePolicyDecision,
} from '../../authz/entity-policy';
import { createDbClientFromEnv, getDb } from '../../db/client';
import type { Env } from '../../index';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';
import { insertEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { buildResourcePermalink } from '../../utils/url-builder';
import { ToolUserError } from '../../utils/errors';
import {
  requireOrgReadAccess,
  requireOrgWriteAccess,
  requireReadAccess,
  requireWriteAccess,
} from '../../utils/organization-access';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { getOrgUrlContext } from '../view-urls';
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
export type { ManageWatchersArgs, ManageWatchersProposal, ManageWatchersResult };

/**
 * Synthetic `runs.action_key` tagging a manage_watchers write held for approval.
 * `manage_operations`' approve/reject handlers branch on this value to apply
 * (or cancel) the held mutation, reusing the same durable runs/events approval
 * primitive that manage_agents uses. These rows have run_type='internal'
 * (no connector / connection), so the operation lookup in the connector path is
 * skipped.
 */
export const MANAGE_WATCHERS_ACTION_KEY = 'manage_watchers';

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
  //
  // `require_approval` queues a pending run + card (does NOT apply); `allow`
  // proceeds to the handler; `deny` / foreign-owner still throw.
  return withWatcherGroupLock(args, ctx, async () => {
    const gated = await gateWatcherWrite(args, ctx);
    if (gated) return gated;
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

/** Human label for each gated action, used in card titles + notifications. */
function watcherActionLabel(args: ManageWatchersArgs): string {
  switch (args.action) {
    case 'create':
      return `Create watcher "${args.slug ?? args.name ?? 'new'}"`;
    case 'create_from_version':
      return `Create watchers from version ${args.version_id ?? '?'}`;
    case 'update':
      return `Update watcher ${args.watcher_id ?? '?'}`;
    case 'create_version':
      return `Create version for watcher ${args.watcher_id ?? '?'}`;
    case 'set_reaction_script':
      return `Set reaction script on watcher ${args.watcher_id ?? '?'}`;
    case 'delete':
      return `Delete watcher(s) ${(args.watcher_ids ?? []).join(', ') || '?'}`;
    default:
      return `Watcher ${args.action}`;
  }
}

/**
 * Fetch a compact current watcher row for the approval card diff. Returns null
 * when there is no single target (create / bulk delete / missing id).
 */
async function fetchCurrentWatcher(
  organizationId: string,
  args: ManageWatchersArgs,
): Promise<Record<string, unknown> | null> {
  if (args.watcher_id == null) return null;
  const sql = getDb();
  const rows = await sql`
    SELECT id, slug, name, description, agent_id, schedule, timezone, status
    FROM watchers
    WHERE organization_id = ${organizationId} AND id = ${Number(args.watcher_id)}
    LIMIT 1
  `;
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Build the proposed-change payload held on the run. Validates required fields
 * for the gated write so a malformed proposal is rejected at request time, not
 * at approve time.
 *
 * Watcher definition writes have no per-field pre-image; the proposal is the
 * full original args for a straight re-run on approve (a stale approval may
 * clobber a newer edit — acceptable for launch).
 */
function buildWatcherProposal(args: ManageWatchersArgs): ManageWatchersProposal {
  const writeAction = watcherWriteAction(args.action);
  if (!writeAction) {
    throw new ToolUserError(`action "${args.action}" is not a gated watcher write`);
  }
  if (args.action === 'create') {
    if (!args.slug) throw new ToolUserError('slug is required for create action');
    if (!args.prompt) throw new ToolUserError('prompt is required for create action');
    if (!args.agent_id) {
      throw new ToolUserError(
        'agent_id is required to create a watcher (the agent that executes it).',
      );
    }
  }
  if (args.action === 'update' && args.watcher_id == null) {
    throw new ToolUserError('watcher_id is required for update action');
  }
  if (args.action === 'delete' && (!args.watcher_ids || args.watcher_ids.length === 0)) {
    throw new ToolUserError('watcher_ids is required for delete action');
  }
  if (
    (args.action === 'create_version' || args.action === 'set_reaction_script') &&
    args.watcher_id == null
  ) {
    throw new ToolUserError(`watcher_id is required for ${args.action} action`);
  }
  if (args.action === 'create_from_version') {
    if (args.version_id == null) {
      throw new ToolUserError('version_id is required for create_from_version action');
    }
    if (!args.entity_ids || args.entity_ids.length === 0) {
      throw new ToolUserError('entity_ids is required for create_from_version action');
    }
  }
  return { args };
}

/** Flat watcher fields shown on the events-tab ActionApprovalCard fallback. */
const WATCHER_APPROVAL_DISPLAY_KEYS = [
  'action',
  'slug',
  'name',
  'prompt',
  'schedule',
  'timezone',
  'agent_id',
  'watcher_id',
  'watcher_ids',
] as const;

function pickWatcherApprovalDisplayFields(
  args: ManageWatchersArgs,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WATCHER_APPROVAL_DISPLAY_KEYS) {
    const value = args[key as keyof ManageWatchersArgs];
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function buildWatcherApprovalInputSchema(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const titles: Record<string, string> = {
    action: 'Action',
    slug: 'Slug',
    name: 'Name',
    prompt: 'Prompt',
    schedule: 'Schedule',
    timezone: 'Timezone',
    agent_id: 'Agent',
    watcher_id: 'Watcher ID',
    watcher_ids: 'Watcher IDs',
  };
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (titles[key]) {
      properties[key] = { type: 'string', title: titles[key] };
    }
  }
  return { type: 'object', properties };
}

/**
 * Queue a manage_watchers write for approval instead of running it. Writes a
 * pending `runs` row (run_type='internal', action_key='manage_watchers') plus an
 * `interaction_type='approval'` event holding the proposed args. The mutation is
 * applied later by manage_operations' approve handler via
 * {@link applyManageWatchersProposal}.
 */
async function queueWatcherWriteForApproval(
  args: ManageWatchersArgs,
  ctx: ToolContext,
): Promise<ManageWatchersResult> {
  const proposal = buildWatcherProposal(args);
  const writeAction = watcherWriteAction(args.action)!;

  // create attributes ownership via created_by — fail at request time rather
  // than after the human approves an unattributable create.
  if (writeAction === 'create' && !ctx.userId) {
    throw new ToolUserError(
      'create requires an authenticated caller to own the new watcher',
    );
  }

  const current = await fetchCurrentWatcher(ctx.organizationId, args);
  if (args.action === 'update' && !current) {
    throw new ToolUserError(`Watcher "${args.watcher_id}" not found`, 404);
  }

  const sql = getDb();
  const inserted = await sql`
    INSERT INTO runs (
      organization_id, run_type, action_key, action_input,
      created_by_user_id, approval_status, status, created_at
    ) VALUES (
      ${ctx.organizationId}, 'internal', ${MANAGE_WATCHERS_ACTION_KEY},
      ${sql.json(proposal as unknown as Record<string, unknown>)},
      ${ctx.userId ?? null}, 'pending', 'pending', current_timestamp
    )
    RETURNING id
  `;
  const runId = Number((inserted[0] as { id: unknown }).id);

  const label = watcherActionLabel(args);
  // Flat display fields for the events-tab fallback card (ActionApprovalCard
  // only renders input when interactionInputSchema is present). Keep the
  // nested proposal in metadata for the apply path / history replay.
  const displayInput = pickWatcherApprovalDisplayFields(args);
  const inputSchema = buildWatcherApprovalInputSchema(displayInput);
  const event = await insertEvent({
    entityIds: args.entity_id != null ? [args.entity_id] : [],
    organizationId: ctx.organizationId,
    originId: `run_${runId}_pending`,
    title: `${label} — pending approval`,
    content: `Builder requested: ${label}`,
    semanticType: 'operation',
    runId,
    interactionType: 'approval',
    interactionStatus: 'pending',
    interactionInputSchema: inputSchema,
    interactionInput: displayInput,
    metadata: {
      tool: 'manage_watchers',
      action_key: MANAGE_WATCHERS_ACTION_KEY,
      action: args.action,
      resourceKind: 'watcher',
      watcher_id: args.watcher_id ?? null,
      proposal,
      current: current ?? null,
      status: 'pending_approval',
      run_id: runId,
      input_schema: inputSchema,
      action_input: displayInput,
    },
    authorName: ctx.clientId ?? 'agent',
  });
  const eventId = Number(event.id);

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  // Run-scoped: the pending event is superseded on approve→complete; a run link
  // stays valid across the chain.
  const approvalUrl = buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);

  notifyActionApprovalNeeded({
    orgId: ctx.organizationId,
    runId,
    actionKey: MANAGE_WATCHERS_ACTION_KEY,
    connectionName: label,
    eventId,
    approvalUrl,
  }).catch((error) =>
    logger.error(error, 'Failed to send manage_watchers approval notification')
  );

  return {
    action: args.action as
      | 'create'
      | 'update'
      | 'create_version'
      | 'create_from_version'
      | 'set_reaction_script'
      | 'delete',
    run_id: runId,
    event_id: eventId,
    status: 'pending_approval',
    // An interactive approval card (change details + Approve/Reject buttons) is
    // rendered into the chat from this result — so instruct the model to stay
    // terse and NOT restate the change or paste a link.
    message: `${label} is queued for approval. A confirmation card with the change details and Approve/Reject buttons is now shown to the user in the chat — reply with at most one short sentence and do NOT restate the change or include an approval link.`,
    proposal,
    current,
  };
}

/**
 * Apply a previously-queued manage_watchers proposal. Called by
 * manage_operations' approve handler once a human confirms. Re-runs the original
 * write handler with the held args. `ownerUserId` is the original requester
 * (persisted on the run), so an approving admin doesn't become the created
 * watcher's `created_by`.
 *
 * Watcher definition writes have no per-field pre-image; this is a straight
 * re-run — a stale approval may clobber a newer edit (acceptable for launch).
 */
export async function applyManageWatchersProposal(
  proposal: ManageWatchersProposal,
  ctx: ToolContext,
  env: Env,
  ownerUserId: string | null,
): Promise<ManageWatchersResult> {
  const args = proposal.args;
  const writeAction = watcherWriteAction(args.action);
  // create attributes ownership to the ORIGINAL requester, not the approver.
  const applyCtx: ToolContext =
    writeAction === 'create' ? { ...ctx, userId: ownerUserId } : ctx;
  return runManageWatchers(args, env, applyCtx);
}

/**
 * Enforce the `agent_config` write-gate for a watcher definition write. No-op for
 * read-only actions and for human members (whose decision is always 'allow').
 * Returns a pending_approval result when the policy requires approval (queued
 * via the same runs/events primitive manage_agents uses); throws on deny or
 * foreign-owner escalation; returns null when the write may apply now.
 */
async function gateWatcherWrite(
  args: ManageWatchersArgs,
  ctx: ToolContext,
): Promise<ManageWatchersResult | null> {
  const action = watcherWriteAction(args.action);
  if (!action) return null;
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
  // MUST run BEFORE queueing so a foreign-owner proposal never becomes a pending card.
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
  if (decision === 'allow') return null;
  if (decision === 'require_approval') {
    return queueWatcherWriteForApproval(args, ctx);
  }
  throw new ToolUserError(
    `Policy denies ${action} of watchers (agent config) for this principal.`,
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

