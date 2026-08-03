/**
 * Tool: manage_behaviors
 *
 * Manage Behavior definitions backed by the existing watcher execution engine.
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
 * - submit_feedback: Submit feedback on a Behavior window
 * - get_feedback: Retrieve feedback for a Behavior
 *
 * This file is the entry point only — action handlers live in ./manage_behaviors/.
 */

import { InteractionResourceKind } from '@lobu/core/contracts/interaction-envelope';
import {
  ListBehaviorsResultSchema,
  ListBehaviorsSchema,
  ManageBehaviorsResultSchema,
  ManageBehaviorsSchema,
  type ManageBehaviorsArgs,
  type ManageBehaviorsProposal,
  type ManageBehaviorsResult,
} from '@lobu/core/contracts/tools/manage-behaviors';
import { resolveActingPrincipal, resolveWritePolicyDecision } from '../../authz/entity-policy';
import { createDbClientFromEnv, getDb, getLockDb } from '../../db/client';
import type { Env } from '../../index';
import {
  currentMcpActivityAttribution,
  currentMcpActivityEventMetadata,
} from '../../lobu/stores/mcp-client-conversations';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';
import { insertEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { buildResourcePermalink, buildBehaviorSettingsUrl } from '../../utils/url-builder';
import { ToolUserError } from '../../utils/errors';
import {
  requireOrgReadAccess,
  requireOrgWriteAccess,
  requireReadAccess,
  requireWriteAccess,
} from '../../utils/organization-access';
import { assertBehaviorInstructions } from '../../behaviors/triggers';
import { resolveRunInitiator } from '../initiator';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { getOrgUrlContext } from '../view-urls';
import { defineFlatActionTool, flatAction } from './action-tool';
import { requireWatcherAccess } from './manage_behaviors/shared';
import {
  handleCreate,
  handleUpdate,
  handleDelete,
  handleCreateFromVersion,
} from './manage_behaviors/crud';
import {
  handleCreateVersion,
  handleGetVersions,
  handleGetVersionDetails,
} from './manage_behaviors/version-actions';
import { handleCompleteWindow } from './manage_behaviors/complete-window';
import { handleTrigger, handleSetReactionScript } from './manage_behaviors/trigger';
import {
  handleSubmitFeedback,
  handleGetFeedback,
  handleListPromoted,
} from './manage_behaviors/feedback';
import { handleGetComponentReference } from './manage_behaviors/reference';
import { handleList } from './manage_behaviors/list';

export {
  ListBehaviorsResultSchema,
  ListBehaviorsSchema,
  ManageBehaviorsResultSchema,
  ManageBehaviorsSchema,
};
export type { ManageBehaviorsArgs, ManageBehaviorsProposal, ManageBehaviorsResult };

/**
 * Synthetic `runs.action_key` tagging a manage_behaviors write held for approval.
 * `manage_operations`' approve/reject handlers branch on this value to apply
 * (or cancel) the held mutation, reusing the same durable runs/events approval
 * primitive that manage_agents uses. These rows have run_type='internal'
 * (no connector / connection), so the operation lookup in the connector path is
 * skipped.
 */
export const MANAGE_BEHAVIORS_ACTION_KEY = 'manage_behaviors';

// ============================================
// Main Function
// ============================================

export const manageBehaviors = withValidatedArgs(
  'manage_behaviors',
  ManageBehaviorsSchema,
  manageBehaviorsImpl
);

async function manageBehaviorsImpl(
  args: ManageBehaviorsArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageBehaviorsResult> {
  const pgSql = createDbClientFromEnv(env);

  // Field-level `update` validation runs before any access check or write-gate
  // so the human-immediate and agent-approval paths reject identically (a
  // version-owned / no-op update can never queue or apply). See
  // {@link assertWatcherUpdateArgs} for the version-owned / entity_ids / status
  // rationale.
  if (args.action === 'update') {
    assertWatcherUpdateArgs(args);
  }

  // Validate organization access based on action type
  if (args.action === 'create') {
    if (args.entity_id) {
      await requireWriteAccess(pgSql, args.entity_id, ctx);
    } else {
      await requireOrgWriteAccess(pgSql, ctx);
    }
  } else if (args.action === 'list') {
    if (args.entity_id) {
      await requireReadAccess(pgSql, args.entity_id, ctx);
    } else {
      await requireOrgReadAccess(pgSql, ctx);
    }
  } else if (args.action === 'update' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'write');
  } else if (args.action === 'trigger' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'write');
  } else if (args.action === 'delete' && args.behavior_ids && args.behavior_ids.length > 0) {
    // delete alone allows missing ids to fall through to its per-id aggregate
    // ("not found or already archived"); every other action stays a hard 403.
    await requireWatcherAccess(pgSql, args.behavior_ids, ctx, 'write', {
      allowMissing: true,
    });
  } else if (args.action === 'complete_window' && args.entity_id) {
    await requireWriteAccess(pgSql, args.entity_id, ctx);
  } else if (args.action === 'create_version' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'write');
  } else if (args.action === 'set_reaction_script' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'write');
  } else if (args.action === 'submit_feedback' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'write');
  } else if (args.action === 'get_feedback' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'read');
  } else if (args.action === 'list_promoted' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'read');
  } else if (args.action === 'get_versions' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'read');
  } else if (args.action === 'get_version_details' && args.behavior_id) {
    await requireWatcherAccess(pgSql, [args.behavior_id], ctx, 'read');
  } else if (args.action === 'create_from_version' && args.entity_ids) {
    for (const eid of args.entity_ids) {
      await requireWriteAccess(pgSql, eid, ctx);
    }
  }

  // Instruction-presence for create_version is enforced in handleCreateVersion
  // against the *final* resolved (triggers, prompt) pair — not here against
  // stored triggers + only an explicit prompt write. That incomplete pre-check
  // let event-turn → schedule transitions keep an empty prompt.

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
    return runManageBehaviors(args, env, ctx);
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
 *   - `update` targets args.behavior_id → its group.
 *   - `create_version` / `set_reaction_script` write GROUP-WIDE off args.behavior_id.
 *   - `create_from_version` reads a SOURCE version → lock the source watcher's group
 *     so a concurrent reassign of the source can't change the owner we clone.
 * All lookups are org-scoped.
 */
async function resolveTargetWatcherGroupId(
  args: ManageBehaviorsArgs,
  ctx: ToolContext
): Promise<number | null> {
  const sql = getDb();
  if (
    args.action === 'update' ||
    args.action === 'create_version' ||
    args.action === 'set_reaction_script'
  ) {
    if (args.behavior_id == null) return null;
    const rows = await sql<{ watcher_group_id: number | null }>`
      SELECT watcher_group_id FROM watchers
      WHERE id = ${Number(args.behavior_id)} AND organization_id = ${ctx.organizationId}
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
 * The reserved connection comes from the DEDICATED lock pool (getLockDb), not
 * the main pool. Lock holders camp on a connection for the whole critical
 * section while `fn` runs its reads/transactions on the MAIN pool; if holders
 * camped on the main pool, N >= DB_POOL_MAX concurrent group-locked writes
 * (same group or distinct groups alike) would consume every slot and starve
 * their own handlers — a permanent pool-wide deadlock. With a separate pool
 * the dependency is one-directional and deadlock-free; excess lock requests
 * queue FIFO and progress as holders finish. The lock pool's `lock_timeout`
 * bounds the advisory-lock wait itself (55P03 → coded 409 below).
 *
 * Only the mutating write-gate actions with a resolvable target group are locked;
 * read-only actions and `create` (no pre-existing group) run `fn` directly.
 */
async function withWatcherGroupLock<T>(
  args: ManageBehaviorsArgs,
  ctx: ToolContext,
  fn: () => Promise<T>
): Promise<T> {
  if (watcherWriteAction(args.action) === null) return fn();
  const groupId = await resolveTargetWatcherGroupId(args, ctx);
  if (groupId == null) return fn();

  const reserved = await getLockDb().reserve();
  try {
    // Session GUC (not a startup parameter — poolers reject lock_timeout on
    // connect). Bounds advisory-lock wait: 55P03 → coded 409 below.
    await reserved`SELECT set_config('lock_timeout', '30s', false)`;
    try {
      await reserved`SELECT pg_advisory_lock(hashtext(${WATCHER_GROUP_LOCK_NS}), ${groupId})`;
    } catch (err) {
      // lock_timeout expiry (55P03): another holder kept the group busy past
      // the bound. We do NOT hold the lock here — surface a clean retryable
      // conflict instead of an unbounded stall.
      if ((err as { code?: string }).code === '55P03') {
        throw new ToolUserError(
          'Another change to this Behavior group is in progress; retry shortly.',
          409
        );
      }
      throw err;
    }
    try {
      return await fn();
    } finally {
      await reserved`SELECT pg_advisory_unlock(hashtext(${WATCHER_GROUP_LOCK_NS}), ${groupId})`;
    }
  } finally {
    reserved.release();
  }
}

/** Maps a manage_behaviors action to its agent_config write verb, or null for a
 * read-only / non-definition action that the write-gate doesn't govern. */
function watcherWriteAction(
  action: ManageBehaviorsArgs['action']
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
  args: ManageBehaviorsArgs,
  ctx: ToolContext
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
      if (args.behavior_id == null) return [];
      const rows = await sql<{ agent_id: string | null }>`
        SELECT agent_id FROM watchers
        WHERE id = ${Number(args.behavior_id)} AND organization_id = ${ctx.organizationId}
        LIMIT 1
      `;
      return rows.length > 0 ? [rows[0].agent_id ?? null] : [];
    }
    case 'create_version':
    case 'set_reaction_script': {
      if (args.behavior_id == null) return [];
      // Group-wide: EVERY owner in the target watcher's group is affected.
      const rows = await sql<{ agent_id: string | null }>`
        SELECT DISTINCT agent_id FROM watchers
        WHERE organization_id = ${ctx.organizationId}
          AND watcher_group_id = (
            SELECT watcher_group_id FROM watchers
            WHERE id = ${Number(args.behavior_id)} AND organization_id = ${ctx.organizationId}
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
function watcherActionLabel(args: ManageBehaviorsArgs): string {
  switch (args.action) {
    case 'create':
      return `Create Behavior "${args.slug ?? args.name ?? 'new'}"`;
    case 'create_from_version':
      return `Create Behaviors from version ${args.version_id ?? '?'}`;
    case 'update':
      return `Update Behavior ${args.behavior_id ?? '?'}`;
    case 'create_version':
      return `Create version for Behavior ${args.behavior_id ?? '?'}`;
    case 'set_reaction_script':
      return `Set reaction script on Behavior ${args.behavior_id ?? '?'}`;
    case 'delete':
      return `Delete Behavior(s) ${(args.behavior_ids ?? []).join(', ') || '?'}`;
    default:
      return `Behavior ${args.action}`;
  }
}

/**
 * Fetch a compact current watcher row for the approval card diff. Returns null
 * when there is no single target (create / bulk delete / missing id).
 */
async function fetchCurrentWatcher(
  organizationId: string,
  args: ManageBehaviorsArgs
): Promise<Record<string, unknown> | null> {
  if (args.behavior_id == null) return null;
  const sql = getDb();
  const rows = await sql`
    SELECT id, slug, name, description, agent_id, schedule, timezone, triggers, status
    FROM watchers
    WHERE organization_id = ${organizationId} AND id = ${Number(args.behavior_id)}
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
 * clobber a newer edit — acceptable for launch). Acting principal is persisted
 * so apply can re-run the foreign-owner guard against the original actor.
 */
function buildWatcherProposal(
  args: ManageBehaviorsArgs,
  acting: { actingAgentId: string | null; actingWatcherId: string | null }
): ManageBehaviorsProposal {
  const writeAction = watcherWriteAction(args.action);
  if (!writeAction) {
    throw new ToolUserError(`action "${args.action}" is not a gated Behavior write`);
  }
  if (args.action === 'create') {
    if (!args.slug) throw new ToolUserError('slug is required for create action');
    // An event-turn Behavior may omit both instruction sources (built-in
    // default); every other shape needs a prompt, pinned skills, or both.
    assertBehaviorInstructions(args.triggers ?? [], args.prompt, args.skills);
    if (!args.agent_id) {
      throw new ToolUserError(
        'agent_id is required to create a Behavior (the agent that executes it).'
      );
    }
  }
  if (args.action === 'delete' && (!args.behavior_ids || args.behavior_ids.length === 0)) {
    throw new ToolUserError('behavior_ids is required for delete action');
  }
  if (
    (args.action === 'create_version' || args.action === 'set_reaction_script') &&
    args.behavior_id == null
  ) {
    throw new ToolUserError(`behavior_id is required for ${args.action} action`);
  }
  if (args.action === 'set_reaction_script' && args.reaction_script === undefined) {
    // An omitted script silently REMOVES the existing reaction (handleSetReactionScript
    // treats missing as falsy). Require the field explicitly; an empty string is the
    // documented way to clear it.
    throw new ToolUserError(
      'reaction_script is required for set_reaction_script (pass an empty string to clear the existing script).'
    );
  }
  if (args.action === 'create_from_version') {
    if (args.version_id == null) {
      throw new ToolUserError('version_id is required for create_from_version action');
    }
    if (!args.entity_ids || args.entity_ids.length === 0) {
      throw new ToolUserError('entity_ids is required for create_from_version action');
    }
  }
  return {
    args,
    actingAgentId: acting.actingAgentId,
    actingWatcherId: acting.actingWatcherId,
  };
}

/**
 * Routing-only key rendered in the card title, not the field list. Everything
 * else present on the proposed args is a mutation input humans must be able to
 * review (reaction script, execution_config, explicit null clears, …).
 */
const WATCHER_APPROVAL_ROUTING_KEYS = new Set(['action']);

/** Display sentinel for an explicit null clear (field present, value null). */
const WATCHER_APPROVAL_CLEARED = '(cleared)';

/**
 * Fields `handleUpdate` actually patches — mirrors its `updatedFields.push`
 * list and the UPDATE SET clause in crud.ts exactly. Version-owned fields
 * (name/description/prompt/sources), `entity_ids` (create_from_version-only)
 * are intentionally ABSENT: `handleUpdate` writes
 * none of them, so an `update` carrying any used to pass validation and return
 * success with `updated_fields: []` — a silent no-op the caller believed
 * applied. {@link assertWatcherUpdateArgs} rejects them up front (before the
 * write-gate), so neither the human-immediate nor the agent-approval path can
 * queue or apply a version-owned change via `update`.
 */
const VERSION_OWNED_WATCHER_FIELDS = ['name', 'description', 'prompt', 'sources'] as const;

const WATCHER_PATCHABLE_FIELDS = [
  'model_config',
  'execution_config',
  // schedule/timezone are projections of triggers (resolveBehaviorTriggerWrite);
  // patch them only via triggers, not as direct writable fields.
  'triggers',
  'agent_id',
  'scheduler_client_id',
  'tags',
  'device_worker_id',
  'agent_kind',
  'notification_channel',
  'notification_priority',
  'min_cooldown_seconds',
] as const;

/**
 * Validate `update` args before any access check or write-gate. Both the
 * human-immediate and the agent-approval paths flow through `manageBehaviorsImpl`,
 * so calling this there makes a version-owned / no-op `update` reject
 * identically and never reach `handleUpdate` (which would otherwise return a
 * silent `updated_fields: []`).
 */
function assertWatcherUpdateArgs(args: ManageBehaviorsArgs): void {
  if (args.behavior_id == null) {
    throw new ToolUserError('behavior_id is required for update action');
  }
  const present = (keys: readonly string[]): string[] =>
    keys.filter((k) => args[k as keyof ManageBehaviorsArgs] !== undefined);
  const versionOwned = present(VERSION_OWNED_WATCHER_FIELDS);
  if (versionOwned.length > 0) {
    throw new ToolUserError(
      `update cannot change version-owned field(s) ${versionOwned.map((f) => `'${f}'`).join(', ')} — use action: 'create_version' to publish a new Behavior version (name/description/prompt/sources inherit from the current version when omitted, and the persisted name cascades on set_as_current).`
    );
  }
  if (args.entity_ids !== undefined) {
    throw new ToolUserError(
      "update cannot change entity_ids — entity targeting is set at create / create_from_version. To re-target per entity, clone a version with action: 'create_from_version'."
    );
  }
  if (present(WATCHER_PATCHABLE_FIELDS).length === 0) {
    throw new ToolUserError(
      "update changes runtime config only (e.g. triggers, agent_id, tags, model_config) and needs at least one such field. It cannot change status — a Behavior is retired via action: 'delete' (→ archived); name/description/prompt/sources are version-owned (action: 'create_version')."
    );
  }
}

/**
 * Flat watcher mutation fields for the events-tab ActionApprovalCard fallback.
 * Includes every proposed arg that is present (including explicit `null`
 * clears); only `action` is omitted (shown in the title). Absent fields
 * (`undefined`) are excluded so the card does not invent values.
 */
function pickWatcherApprovalDisplayFields(args: ManageBehaviorsArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (WATCHER_APPROVAL_ROUTING_KEYS.has(key)) continue;
    if (value === undefined) continue;
    // Explicit null = clear (e.g. schedule: null). Render as a visible sentinel
    // so the card can show the clear rather than dropping the field.
    if (value === null) {
      out[key] = WATCHER_APPROVAL_CLEARED;
      continue;
    }
    if (Array.isArray(value)) {
      // Primitive arrays (behavior_ids, entity_ids, tags) collapse to a readable
      // list; object arrays (sources) serialize to JSON so the schema's string
      // field renders the actual structure, not "[object Object]".
      out[key] = value.every(
        (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
      )
        ? value.join(', ')
        : JSON.stringify(value);
      continue;
    }
    // Structured objects (execution_config, model_config) serialize to JSON for
    // the same reason — the approval card field is a readOnly string.
    if (typeof value === 'object') {
      out[key] = JSON.stringify(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Human-readable titles for common Behavior approval fields. */
const WATCHER_APPROVAL_FIELD_TITLES: Record<string, string> = {
  slug: 'Slug',
  name: 'Name',
  description: 'Description',
  prompt: 'Prompt',
  schedule: 'Schedule',
  triggers: 'Triggers',
  timezone: 'Timezone',
  agent_id: 'Agent',
  behavior_id: 'Behavior ID',
  behavior_ids: 'Behavior IDs',
  version_id: 'Version ID',
  entity_id: 'Entity ID',
  entity_ids: 'Entity IDs',
  reaction_script: 'Reaction script',
  execution_config: 'Execution config',
  device_worker_id: 'Device worker',
  scheduler_client_id: 'Scheduler client',
  agent_kind: 'Agent kind',
  sources: 'Sources',
  model_config: 'Model config',
  keying_config: 'Keying config',
  classifiers: 'Classifiers',
  tags: 'Tags',
  change_notes: 'Change notes',
  set_as_current: 'Set as current',
  reactions_guidance: 'Reactions guidance',
  notification_channel: 'Notification channel',
  notification_priority: 'Notification priority',
  min_cooldown_seconds: 'Min cooldown (seconds)',
  name_pattern: 'Name pattern',
};

function buildWatcherApprovalInputSchema(fields: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const baseTitle = WATCHER_APPROVAL_FIELD_TITLES[key] ?? key;
    const title = value === WATCHER_APPROVAL_CLEARED ? `${baseTitle} (cleared)` : baseTitle;
    // Every field is readOnly: the watcher approval card is a review-and-decide
    // surface, not an editor. The apply path always executes the ORIGINAL
    // proposal.args, so an editable field would silently discard the reviewer's
    // change. readOnly makes the form render the proposed value as inspectable
    // text without pretending it can be edited.
    const base = { title, readOnly: true } as const;
    // Structured values (execution_config, model_config, sources, arrays of
    // objects) have no nested schema, so the generic form would coerce them to
    // "[object Object]". Serialize to a JSON string so the reviewer sees the
    // actual proposed configuration.
    if (typeof value === 'object' && value !== null) {
      properties[key] = { ...base, type: 'string' };
      continue;
    }
    if (typeof value === 'number') {
      properties[key] = { ...base, type: 'number' };
      continue;
    }
    if (typeof value === 'boolean') {
      properties[key] = { ...base, type: 'boolean' };
      continue;
    }
    properties[key] = { ...base, type: 'string' };
  }
  return { type: 'object', properties };
}

/**
 * Queue a manage_behaviors write for approval instead of running it. Writes a
 * pending `runs` row (run_type='internal', action_key='manage_behaviors') plus an
 * `interaction_type='approval'` event holding the proposed args. The mutation is
 * applied later by manage_operations' approve handler via
 * {@link applyManageBehaviorsProposal}.
 *
 * `acting` is the principal resolved at gate time (same seam as the foreign-
 * owner check) and is persisted on the proposal so apply can re-validate.
 */
async function queueWatcherWriteForApproval(
  args: ManageBehaviorsArgs,
  ctx: ToolContext,
  acting: { actingAgentId: string | null; actingWatcherId: string | null }
): Promise<ManageBehaviorsResult> {
  const proposal = buildWatcherProposal(args, acting);
  const writeAction = watcherWriteAction(args.action)!;

  // create attributes ownership via created_by — fail at request time rather
  // than after the human approves an unattributable create.
  if (writeAction === 'create' && !ctx.userId) {
    throw new ToolUserError('create requires an authenticated caller to own the new Behavior');
  }

  const current = await fetchCurrentWatcher(ctx.organizationId, args);
  if (args.action === 'update' && !current) {
    throw new ToolUserError(`Behavior "${args.behavior_id}" not found`, 404);
  }

  const sql = getDb();
  const initiatorColumns = resolveRunInitiator(ctx);
  const inserted = await sql`
    INSERT INTO runs (
      organization_id, run_type, action_key, action_input,
      created_by_user_id, initiator_kind, initiator_ref,
      approval_status, status, created_at
    ) VALUES (
      ${ctx.organizationId}, 'internal', ${MANAGE_BEHAVIORS_ACTION_KEY},
      ${sql.json(proposal as unknown as Record<string, unknown>)},
      ${initiatorColumns.createdByUserId},
      ${initiatorColumns.initiatorKind},
      ${sql.json(initiatorColumns.initiatorRef)},
      'pending', 'pending', current_timestamp
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
      tool: 'manage_behaviors',
      action_key: MANAGE_BEHAVIORS_ACTION_KEY,
      action: args.action,
      resourceKind: InteractionResourceKind.Behavior,
      watcher_id: args.behavior_id ?? null,
      proposal,
      current: current ?? null,
      initiator: {
        kind: initiatorColumns.initiatorKind,
        ...initiatorColumns.initiatorRef,
      },
      status: 'pending_approval',
      run_id: runId,
      input_schema: inputSchema,
      action_input: displayInput,
      ...currentMcpActivityEventMetadata(ctx),
    },
    authorName: ctx.clientId ?? 'agent',
    clientId: ctx.tokenType === 'oauth' ? (ctx.clientId ?? null) : null,
  });
  const eventId = Number(event.id);

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  // An `update` is config-shaped, so its review surface is the watcher edit form
  // prefilled via `?run_id=` (WI-0.3, watcher parity with manage_agents): the
  // reviewer sees the proposed change in the real form and Approves/Rejects. The
  // route is nested under the OWNING agent (an update may reassign the owner via
  // args.agent_id, so prefer the proposed owner, else the current one). create /
  // create_from_version / set_reaction_script etc. aren't a single-form review,
  // so they keep the run permalink (valid across the supersede chain on approve).
  const ownerAgentId = args.agent_id ?? (current?.agent_id as string | null | undefined) ?? null;
  const settingsReviewUrl =
    args.action === 'update' && args.behavior_id != null && ownerAgentId
      ? await buildBehaviorSettingsUrl(baseUrl, ctx.organizationId, ownerAgentId, args.behavior_id, {
          runId,
        }).catch(() => null)
      : null;
  const approvalUrl =
    settingsReviewUrl ?? buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);

  notifyActionApprovalNeeded({
    orgId: ctx.organizationId,
    runId,
    actionKey: MANAGE_BEHAVIORS_ACTION_KEY,
    connectionName: label,
    eventId,
    approvalUrl,
    mcpActivity: currentMcpActivityAttribution(ctx),
  }).catch((error) => logger.error(error, 'Failed to send manage_behaviors approval notification'));

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
 * Foreign-owner escalation guard shared by the request-time gate and the
 * approve-time apply path. Every effective owner the write would install must
 * equal `actingAgentId`. Pass null to skip (humans are ungoverned here — same
 * as the gate's `actor.kind === 'user'` branch). Throws ToolUserError 403.
 *
 * Uses {@link resolveEffectiveWatcherOwners} so the check matches what each
 * handler actually persists (not the supplied args.agent_id alone).
 */
async function assertWatcherOwnersMatchActingAgent(
  args: ManageBehaviorsArgs,
  ctx: ToolContext,
  actingAgentId: string | null,
  actorKind: string = 'agent'
): Promise<void> {
  if (actingAgentId == null) return;
  const owners = await resolveEffectiveWatcherOwners(args, ctx);
  const foreign = owners.find((o) => o !== actingAgentId);
  if (foreign !== undefined) {
    throw new ToolUserError(
      `A ${actorKind} cannot install a Behavior owned by another agent — every affected owner must be itself (${actingAgentId}); found ${foreign ?? 'none'}.`,
      403
    );
  }
}

/**
 * Apply a previously-queued manage_behaviors proposal. Called by
 * manage_operations' approve handler once a human confirms. Re-runs the original
 * write handler with the held args. `ownerUserId` is the original requester
 * (persisted on the run), so an approving admin doesn't become the created
 * watcher's `created_by`.
 *
 * Re-takes the watcher-group advisory lock and re-runs the foreign-owner guard
 * against the PERSISTED acting agent (not the approver). If ownership changed
 * between queue and approve (e.g. group reassigned to another agent), the apply
 * fails closed — the approve handler supersedes the card to 'failed'.
 *
 * Watcher definition writes have no per-field pre-image; this is a straight
 * re-run — a stale approval may clobber a newer edit (acceptable for launch)
 * when ownership is still valid.
 */
export async function applyManageBehaviorsProposal(
  proposal: ManageBehaviorsProposal,
  ctx: ToolContext,
  env: Env,
  ownerUserId: string | null
): Promise<ManageBehaviorsResult> {
  const args = proposal.args;
  const writeAction = watcherWriteAction(args.action);
  // create attributes ownership to the ORIGINAL requester, not the approver.
  const applyCtx: ToolContext = writeAction === 'create' ? { ...ctx, userId: ownerUserId } : ctx;
  // Lock + re-gate under the same session advisory lock as the request path so
  // a concurrent reassign can't slip between the ownership re-check and the write.
  return withWatcherGroupLock(args, applyCtx, async () => {
    // Humans leave actingAgentId null — skip, matching the gate.
    await assertWatcherOwnersMatchActingAgent(
      args,
      applyCtx,
      proposal.actingAgentId ?? null,
      'agent'
    );
    // Re-run the CURRENT write-gate before applying: policy may have flipped to
    // `deny` (or the acting principal may have been deleted) while the approval
    // sat pending. Fail closed rather than execute a now-denied proposal — the
    // approve handler supersedes the card to 'failed'. Humans (null actingAgentId)
    // are ungoverned here, matching the request-path gate.
    if (proposal.actingAgentId != null) {
      const writeGateAction = watcherWriteAction(args.action);
      if (writeGateAction) {
        const decision = await resolveWritePolicyDecision({
          organizationId: applyCtx.organizationId,
          resourceClass: 'agent_config',
          principalKind: 'agent',
          principalId: proposal.actingAgentId,
          ownerAgentId: proposal.actingAgentId,
          ownerResolved: true,
          action: writeGateAction,
        });
        // Only `deny` blocks the apply: this run IS the approval, so a
        // `require_approval` decision is already satisfied and must not re-block.
        if (decision === 'deny') {
          throw new ToolUserError(
            `Policy now denies ${writeGateAction} of Behaviors for this principal; the approved change was not applied.`,
            403
          );
        }
      }
    }
    return runManageBehaviors(args, env, applyCtx);
  });
}

/**
 * Enforce the `agent_config` write-gate for a watcher definition write. No-op for
 * read-only actions and for human members (whose decision is always 'allow').
 * Returns a pending_approval result when the policy requires approval (queued
 * via the same runs/events primitive manage_agents uses); throws on deny or
 * foreign-owner escalation; returns null when the write may apply now.
 */
async function gateWatcherWrite(
  args: ManageBehaviorsArgs,
  ctx: ToolContext
): Promise<ManageBehaviorsResult | null> {
  const action = watcherWriteAction(args.action);
  if (!action) return null;
  // Resolve the actor through the shared seam. A reaction script editing watchers
  // acts as its own watcher (ctx.actingWatcherId) — the seam folds that watcher's
  // owning agent so the agent's agent_config envelope binds and the reaction can't
  // self-escalate. manage_behaviors has no behavior_source arg, so only the session
  // watcher applies.
  const actor = await resolveActingPrincipal(getDb(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionWatcherId: ctx.actingWatcherId ?? null,
  });
  // Non-human principal identity captured for the ownership guard AND (when
  // queued) the proposal. Same formula the gate has always used.
  const actingAgentId = actor.kind !== 'user' ? (actor.ownerAgentId ?? actor.id) : null;
  const actingWatcherId = ctx.actingWatcherId != null ? String(ctx.actingWatcherId) : null;

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
  await assertWatcherOwnersMatchActingAgent(args, ctx, actingAgentId, actor.kind);

  const decision = await resolveWritePolicyDecision({
    organizationId: ctx.organizationId,
    resourceClass: 'agent_config',
    principalKind: actor.kind,
    principalId: actor.id,
    ownerAgentId: actor.ownerAgentId,
    ownerResolved: actor.ownerResolved,
    action,
  });
  if (decision === 'allow') return null;
  if (decision === 'require_approval') {
    return queueWatcherWriteForApproval(args, ctx, {
      actingAgentId,
      actingWatcherId,
    });
  }
  throw new ToolUserError(
    `Policy denies ${action} of Behaviors (agent config) for this principal.`,
    403
  );
}

const runManageBehaviors = defineFlatActionTool<ManageBehaviorsArgs, ManageBehaviorsResult>(
  'manage_behaviors',
  {
    create: flatAction((args, ctx, env) => handleCreate(args, env, ctx)),
    list: flatAction((args: ManageBehaviorsArgs, ctx, env) => handleList(args, env, ctx)),
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
