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
  await gateWatcherWrite(args, ctx);

  return runManageWatchers(args, env, ctx);
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
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionWatcherId: ctx.actingWatcherId ?? null,
    sourceForMode: ctx.sourceContext?.source,
  });
  // Escalation guard: a non-human caller must not set the watcher's OWNING AGENT
  // (`agent_id`) to anyone but itself. Otherwise a reaction owned by restricted
  // agent A could create/reassign a watcher to looser agent B — and every later
  // write through that watcher would fold B's (looser) envelope instead of A's,
  // side-stepping A's deny rules. Humans are ungoverned here and may assign freely.
  if (
    actor.kind !== 'user' &&
    (action === 'create' || action === 'update') &&
    args.agent_id != null
  ) {
    const ownAgentId = actor.ownerAgentId ?? actor.id;
    if (args.agent_id !== ownAgentId) {
      throw new ToolUserError(
        `A ${actor.kind} cannot assign a watcher to another agent — agent_id must be its own (${ownAgentId ?? 'none'}).`,
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

