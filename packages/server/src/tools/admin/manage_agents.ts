/**
 * Tool: manage_agents
 *
 * Manage agent definitions within an organization.
 *
 * Actions:
 * - list: List all agents in the org (marks the org's system agent)
 * - get: Get one agent's row
 * - create: Create an agent owned by the authenticated caller (owner_platform=
 *   'external' + an agent_users mapping, so the per-user chat path can reach it)
 * - update: Update name/description/identity_md on an agent
 * - delete: Delete an agent (refuses the org's system agent)
 * - set_system_agent: Point organization.system_agent_id at an agent
 *
 * The org's "system" agent is the builder/console agent backing the
 * org-management surface. `set_system_agent` is the only writer of
 * organization.system_agent_id here (default-org provisioning is the other).
 */

import {
  ManageAgentsSchema,
  type AgentRecord,
  type ManageAgentsArgs,
  type ManageAgentsProposal,
  type ManageAgentsResult,
} from '@lobu/core/contracts/tools/manage-agents';
import {
  resolveActingPrincipal,
  resolveWritePolicyDecision,
} from '../../authz/entity-policy';
import { createDbClientFromEnv, getDb } from '../../db/client';
import type { Env } from '../../index';
import { isValidAgentId } from '../../lobu/stores/postgres-stores';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';
import { insertEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { buildResourcePermalink } from '../../utils/url-builder';
import { ToolUserError } from '../../utils/errors';
import { requireOrgReadAccess, requireOrgWriteAccess } from '../../utils/organization-access';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { getOrgUrlContext } from '../view-urls';
import { defineFlatActionTool, flatAction } from './action-tool';

export { ManageAgentsSchema };
export type { ManageAgentsProposal };

/**
 * Synthetic `runs.action_key` tagging a manage_agents write held for approval.
 * `manage_operations`' approve/reject handlers branch on this value to apply
 * (or cancel) the held mutation, reusing the same durable runs/events approval
 * primitive that connector operations use. These rows have run_type='internal'
 * (no connector / connection), so the operation lookup in the connector path is
 * skipped.
 */
export const MANAGE_AGENTS_ACTION_KEY = 'manage_agents';

// ============================================
// Typeon handlers
// ============================================

async function handleList(
  _args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT
      a.id,
      a.name,
      a.description,
      a.owner_platform,
      a.owner_user_id,
      a.created_at,
      a.last_used_at,
      (a.id = o.system_agent_id) AS is_system_agent
    FROM agents a
    JOIN organization o ON o.id = a.organization_id
    WHERE a.organization_id = ${ctx.organizationId}
    ORDER BY a.created_at ASC
  `;
  return { action: 'list', agents: rows as unknown as AgentRecord[] };
}

async function handleGet(
  args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  if (!args.agent_id) {
    throw new ToolUserError('agent_id is required for get action');
  }
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT
      a.id,
      a.name,
      a.description,
      a.owner_platform,
      a.owner_user_id,
      a.created_at,
      a.last_used_at,
      (a.id = o.system_agent_id) AS is_system_agent
    FROM agents a
    JOIN organization o ON o.id = a.organization_id
    WHERE a.organization_id = ${ctx.organizationId} AND a.id = ${args.agent_id}
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Agent "${args.agent_id}" not found`, 404);
  }
  return { action: 'get', agent: rows[0] as unknown as AgentRecord };
}

export async function applyCreate(
  args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  if (!args.agent_id) {
    throw new ToolUserError('agent_id is required for create action');
  }
  if (!isValidAgentId(args.agent_id)) {
    throw new ToolUserError(
      `Invalid agent_id "${args.agent_id}": must match /^[a-z][a-z0-9-]{2,59}$/`
    );
  }
  if (!args.name) {
    throw new ToolUserError('name is required for create action');
  }
  // Created agents must have an owner to attribute them to — without one the
  // agents row exists but the per-user ownership path can't reach it.
  if (!ctx.userId) {
    throw new ToolUserError(
      'create requires an authenticated caller to own the new agent'
    );
  }
  const sql = createDbClientFromEnv(env);
  const ownerUserId = ctx.userId;
  // Mirror the provisioning pattern (ensureDefaultAgent / ensureBuilderAgent):
  // owner_platform='external' on the row AND an agent_users mapping, so the
  // per-user ownership check (SPA cookie / PAT session) can reach the new agent.
  // Without the agent_users row the agent is unreachable through chat,
  // especially in non-default orgs.
  const rows = await sql`
    INSERT INTO agents (
      id, organization_id, name, description, identity_md,
      owner_platform, owner_user_id, created_at, updated_at
    )
    VALUES (
      ${args.agent_id}, ${ctx.organizationId}, ${args.name}, ${args.description ?? null},
      ${args.identity_md ?? ''}, 'external', ${ownerUserId}, NOW(), NOW()
    )
    ON CONFLICT (organization_id, id) DO NOTHING
    RETURNING id
  `;
  const created = rows.length > 0;
  if (created) {
    await sql`
      INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
      VALUES (${ctx.organizationId}, ${args.agent_id}, 'external', ${ownerUserId}, NOW())
      ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
    `;
  }
  return { action: 'create', agent_id: args.agent_id, created };
}

export async function applyUpdate(
  args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env,
  /**
   * Pre-image captured when a queued update was proposed. When present, a field
   * is written only if its live value still equals its pre-image — a stale
   * approval skips (and reports) fields another writer has since changed. Absent
   * for immediate (human) applies, which overwrite unconditionally.
   */
  base?: ManageAgentsProposal['base'],
  /**
   * Set by the QUEUED-approval apply path ({@link applyManageAgentsProposal}).
   * A queued update MUST carry a pre-image for every field it writes — that's
   * how a stale approval is prevented from clobbering a newer human edit. A
   * legacy pending run created before this branch has no `base`; without this
   * flag a missing base read as "overwrite unconditionally" and silently
   * clobbered the newer value (sol review #8). With it set, a field lacking a
   * pre-image FAILS CLOSED: the field is skipped and reported, never written on
   * blind faith. Immediate (human) applies leave this false and overwrite.
   */
  requireBase = false
): Promise<ManageAgentsResult> {
  if (!args.agent_id) {
    throw new ToolUserError('agent_id is required for update action');
  }
  const sql = createDbClientFromEnv(env);
  const requested: string[] = [];
  if (args.name !== undefined) requested.push('name');
  if (args.description !== undefined) requested.push('description');
  if (args.identity_md !== undefined) requested.push('identity_md');
  if (requested.length === 0) {
    throw new ToolUserError(
      'update requires at least one of: name, description, identity_md'
    );
  }
  // A queued apply with no pre-image for a requested field can't safely write it
  // (it might clobber a human edit made after the proposal was queued). Fail that
  // field closed: drop it from the requested set so its CASE arm never fires and
  // it's reported as skipped. Legacy pre-`base` runs thus apply nothing rather
  // than everything. Immediate applies (requireBase=false) are unaffected.
  const unbackedFields = requireBase
    ? requested.filter((field) => {
        if (field === 'name') return base?.name === undefined;
        if (field === 'description') return base?.description === undefined;
        return base?.identity_md === undefined;
      })
    : [];
  const writable = requested.filter((f) => !unbackedFields.includes(f));
  const writeName = args.name !== undefined && writable.includes('name');
  const writeDesc =
    args.description !== undefined && writable.includes('description');
  const writeIdentity =
    args.identity_md !== undefined && writable.includes('identity_md');
  // Each writable field is written iff (no pre-image given) OR (its live value
  // still equals the pre-image). `${base ? … : true}` collapses to a constant per
  // field so the guard is a no-op for immediate applies. IS NOT DISTINCT FROM
  // matches NULLs. updated_at only bumps when at least one field actually changes.
  const nameGuard = base ? base.name !== undefined : false;
  const descGuard = base ? base.description !== undefined : false;
  const identityGuard = base ? base.identity_md !== undefined : false;
  const rows = await sql<{ id: string; name: string | null; description: string | null; identity_md: string | null }>`
    UPDATE agents SET
      name = CASE
        WHEN ${writeName}
          AND (${!nameGuard} OR name IS NOT DISTINCT FROM ${base?.name ?? null})
        THEN ${args.name ?? null} ELSE name END,
      description = CASE
        WHEN ${writeDesc}
          AND (${!descGuard} OR description IS NOT DISTINCT FROM ${base?.description ?? null})
        THEN ${args.description ?? null} ELSE description END,
      identity_md = CASE
        WHEN ${writeIdentity}
          AND (${!identityGuard} OR identity_md IS NOT DISTINCT FROM ${base?.identity_md ?? null})
        THEN ${args.identity_md ?? ''} ELSE identity_md END,
      updated_at = NOW()
    WHERE organization_id = ${ctx.organizationId} AND id = ${args.agent_id}
    RETURNING id, name, description, identity_md
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Agent "${args.agent_id}" not found`, 404);
  }
  // Report which requested fields actually landed. A field is skipped when its
  // live value diverged from the pre-image (stale) OR it had no pre-image on a
  // queued apply (unbacked — never written on blind faith).
  const after = rows[0];
  const appliedFields = writable.filter((field) => {
    if (field === 'name') return after.name === (args.name ?? null);
    if (field === 'description') return after.description === (args.description ?? null);
    return after.identity_md === (args.identity_md ?? '');
  });
  const skippedFields = requested.filter((f) => !appliedFields.includes(f));
  return {
    action: 'update',
    agent_id: args.agent_id,
    updated_fields: appliedFields,
    ...(skippedFields.length > 0 ? { skipped_fields: skippedFields } : {}),
  };
}

export async function applyDelete(
  args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  if (!args.agent_id) {
    throw new ToolUserError('agent_id is required for delete action');
  }
  const sql = createDbClientFromEnv(env);
  const orgRows = await sql`
    SELECT system_agent_id FROM organization WHERE id = ${ctx.organizationId}
  `;
  if (orgRows[0]?.system_agent_id === args.agent_id) {
    throw new ToolUserError(
      `Cannot delete agent "${args.agent_id}": it is the org's system agent. Point system_agent_id elsewhere first.`
    );
  }
  const rows = await sql`
    DELETE FROM agents
    WHERE organization_id = ${ctx.organizationId} AND id = ${args.agent_id}
    RETURNING id
  `;
  // The agent's write-gate policy rows (principal_kind='agent') cascade via a DB
  // trigger on `agents` (see 20260710140000) — covers this path AND the dashboard's
  // configStore.deleteMetadata, so no app-level cleanup is duplicated here.
  return { action: 'delete', agent_id: args.agent_id, deleted: rows.length > 0 };
}

async function handleSetSystemAgent(
  args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  if (!args.agent_id) {
    throw new ToolUserError('agent_id is required for set_system_agent action');
  }
  const sql = createDbClientFromEnv(env);
  const agentRows = await sql`
    SELECT id FROM agents
    WHERE organization_id = ${ctx.organizationId} AND id = ${args.agent_id}
  `;
  if (agentRows.length === 0) {
    throw new ToolUserError(`Agent "${args.agent_id}" not found`, 404);
  }
  await sql`
    UPDATE organization
    SET system_agent_id = ${args.agent_id}
    WHERE id = ${ctx.organizationId}
  `;
  return { action: 'set_system_agent', system_agent_id: args.agent_id };
}

// ============================================
// Approval gate (reuses the runs/events primitive)
// ============================================

/** Fetch the current agent row so the approval card can diff proposed vs current. */
async function fetchCurrentAgent(
  organizationId: string,
  agentId: string,
  env: Env
): Promise<Record<string, unknown> | null> {
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT id, name, description, identity_md
    FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    LIMIT 1
  `;
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

/** Human label for each gated action, used in card titles + notifications. */
function actionLabel(action: 'create' | 'update' | 'delete', agentId: string): string {
  switch (action) {
    case 'create':
      return `Create agent "${agentId}"`;
    case 'update':
      return `Update agent "${agentId}"`;
    case 'delete':
      return `Delete agent "${agentId}"`;
  }
}

/**
 * Build the proposed-change payload held on the run for a write action, after
 * validating the per-action required fields (so a malformed proposal is
 * rejected at request time, not at approve time).
 */
function buildProposal(args: ManageAgentsArgs): ManageAgentsProposal {
  const action = args.action as 'create' | 'update' | 'delete';
  if (!args.agent_id) {
    throw new ToolUserError(`agent_id is required for ${action} action`);
  }
  if (action === 'create') {
    if (!isValidAgentId(args.agent_id)) {
      throw new ToolUserError(
        `Invalid agent_id "${args.agent_id}": must match /^[a-z][a-z0-9-]{2,59}$/`
      );
    }
    if (!args.name) {
      throw new ToolUserError('name is required for create action');
    }
  }
  if (action === 'update') {
    const hasField =
      args.name !== undefined ||
      args.description !== undefined ||
      args.identity_md !== undefined;
    if (!hasField) {
      throw new ToolUserError(
        'update requires at least one of: name, description, identity_md'
      );
    }
  }
  const proposal: ManageAgentsProposal = { action, agent_id: args.agent_id };
  if (args.name !== undefined) proposal.name = args.name;
  if (args.description !== undefined) proposal.description = args.description;
  if (args.identity_md !== undefined) proposal.identity_md = args.identity_md;
  return proposal;
}

/**
 * Queue a manage_agents write for approval instead of running it. Writes a
 * pending `runs` row (run_type='internal', action_key='manage_agents') plus an
 * `interaction_type='approval'` event holding the proposed change AND the
 * current agent row (for the frontend diff). The mutation is applied later by
 * manage_operations' approve handler via {@link applyManageAgentsProposal}.
 */
async function queueWriteForApproval(
  args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  const proposal = buildProposal(args);
  // create needs an owner to attribute the new agent to — fail at request time
  // rather than after the human approves an unattributable create.
  if (proposal.action === 'create' && !ctx.userId) {
    throw new ToolUserError(
      'create requires an authenticated caller to own the new agent'
    );
  }

  const sql = getDb();
  const current = await fetchCurrentAgent(ctx.organizationId, proposal.agent_id, env);
  if (proposal.action === 'create' && current) {
    throw new ToolUserError(`Agent "${proposal.agent_id}" already exists`, 409);
  }
  if (proposal.action !== 'create' && !current) {
    throw new ToolUserError(`Agent "${proposal.agent_id}" not found`, 404);
  }

  // Capture the pre-image of each field this update touches, so the eventual
  // approve applies only fields that haven't since been changed by someone else.
  if (proposal.action === 'update' && current) {
    proposal.base = {};
    if (proposal.name !== undefined)
      proposal.base.name = (current.name as string | null) ?? null;
    if (proposal.description !== undefined)
      proposal.base.description = (current.description as string | null) ?? null;
    if (proposal.identity_md !== undefined)
      proposal.base.identity_md = (current.identity_md as string | null) ?? null;
  }

  // Reject a delete of the org's system agent up-front (same guard as
  // applyDelete) so we never surface an un-approvable card.
  if (proposal.action === 'delete') {
    const orgRows = await sql`
      SELECT system_agent_id FROM organization WHERE id = ${ctx.organizationId}
    `;
    if (orgRows[0]?.system_agent_id === proposal.agent_id) {
      throw new ToolUserError(
        `Cannot delete agent "${proposal.agent_id}": it is the org's system agent. Point system_agent_id elsewhere first.`
      );
    }
  }

  const inserted = await sql`
    INSERT INTO runs (
      organization_id, run_type, action_key, action_input,
      created_by_user_id, approval_status, status, created_at
    ) VALUES (
      ${ctx.organizationId}, 'internal', ${MANAGE_AGENTS_ACTION_KEY},
      ${sql.json(proposal as unknown as Record<string, unknown>)},
      ${ctx.userId ?? null}, 'pending', 'pending', current_timestamp
    )
    RETURNING id
  `;
  const runId = Number((inserted[0] as { id: unknown }).id);

  const label = actionLabel(proposal.action, proposal.agent_id);
  const event = await insertEvent({
    entityIds: [],
    organizationId: ctx.organizationId,
    originId: `run_${runId}_pending`,
    title: `${label} — pending approval`,
    content: `Builder requested: ${label}`,
    semanticType: 'operation',
    runId,
    interactionType: 'approval',
    interactionStatus: 'pending',
    interactionInput: proposal as unknown as Record<string, unknown>,
    metadata: {
      tool: 'manage_agents',
      action_key: MANAGE_AGENTS_ACTION_KEY,
      action: proposal.action,
      agent_id: proposal.agent_id,
      proposal,
      current: current ?? null,
      status: 'pending_approval',
      run_id: runId,
    },
    authorName: ctx.clientId ?? 'agent',
  });
  const eventId = Number(event.id);

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  // Run-scoped: the pending event is superseded on approve→complete; a run link
  // stays valid across the chain. (Read-side content_ids resolution also covers
  // the event id below, carried for the notification's resourceId.)
  const approvalUrl = buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);

  notifyActionApprovalNeeded({
    orgId: ctx.organizationId,
    runId,
    actionKey: MANAGE_AGENTS_ACTION_KEY,
    connectionName: label,
    eventId,
    approvalUrl,
  }).catch((error) =>
    logger.error(error, 'Failed to send manage_agents approval notification')
  );

  return {
    action: proposal.action,
    run_id: runId,
    event_id: eventId,
    status: 'pending_approval',
    // An interactive approval card (change details + Approve/Reject buttons) is
    // rendered into the chat from this result — so instruct the model to stay
    // terse and NOT restate the change or paste a link. Narrating a Markdown
    // "Approval Link" duplicates the card and leaves a dead link once resolved.
    message: `${label} is queued for approval. A confirmation card with the change details and Approve/Reject buttons is now shown to the user in the chat — reply with at most one short sentence and do NOT restate the change or include an approval link.`,
    proposal,
    current,
  };
}

/**
 * Apply a previously-queued manage_agents proposal. Called by
 * manage_operations' approve handler once a human confirms. Maps the held
 * proposal back onto the real apply* handler. `ownerUserId` is the original
 * requester (persisted on the run), so an approving admin doesn't become the
 * created agent's owner.
 */
export async function applyManageAgentsProposal(
  proposal: ManageAgentsProposal,
  ctx: ToolContext,
  env: Env,
  ownerUserId: string | null
): Promise<ManageAgentsResult> {
  const args: ManageAgentsArgs = {
    action: proposal.action,
    agent_id: proposal.agent_id,
    name: proposal.name,
    description: proposal.description,
    identity_md: proposal.identity_md,
  };
  // create attributes ownership to the ORIGINAL requester, not the approver.
  const applyCtx: ToolContext =
    proposal.action === 'create' ? { ...ctx, userId: ownerUserId } : ctx;
  switch (proposal.action) {
    case 'create':
      return applyCreate(args, applyCtx, env);
    case 'update':
      // Queued apply: require a pre-image per field. A legacy pending run with no
      // `base` thus skips (never blind-overwrites a newer human edit) — fail closed.
      return applyUpdate(args, applyCtx, env, proposal.base, true);
    case 'delete':
      return applyDelete(args, applyCtx, env);
  }
}

// ============================================
// Main Function
// ============================================

export const manageAgents = withValidatedArgs(
  'manage_agents',
  ManageAgentsSchema,
  manageAgentsImpl
);

async function manageAgentsImpl(
  args: ManageAgentsArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageAgentsResult> {
  const pgSql = createDbClientFromEnv(env);

  // Validate organization access based on action type.
  if (args.action === 'list' || args.action === 'get') {
    await requireOrgReadAccess(pgSql, ctx);
  } else {
    await requireOrgWriteAccess(pgSql, ctx);
  }

  return runManageAgents(args, env, ctx);
}

/**
 * Route one agent write through the `agent_config` write-gate class. The policy
 * decides per (principal, action): a human member applies immediately, an
 * agent/watcher-driven write follows the org's policy (default: create/update
 * queue an approval, delete is denied). `require_approval` → queue a pending run
 * + card; `allow` → run the apply* handler now; `deny` → refuse.
 */
async function dispatchAgentWrite(
  action: 'create' | 'update' | 'delete',
  args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  // Resolve identity through the shared seam so a watcher reaction (which sets
  // ctx.actingWatcherId but no agentId) binds its owning agent's `agent_config`
  // envelope — otherwise it would gate as a null-id agent and skip the owner's
  // approval/deny override. manage_agents has no watcher_source arg, so only the
  // trusted session watcher applies.
  const actor = await resolveActingPrincipal(getDb(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionWatcherId: ctx.actingWatcherId ?? null,
    sourceForMode: ctx.sourceContext?.source,
  });
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
  if (decision === 'deny') {
    throw new ToolUserError(
      `Policy denies ${action} of agents for this principal.`,
      403
    );
  }
  if (decision === 'require_approval') {
    return queueWriteForApproval(args, ctx, env);
  }
  // allow → apply immediately (validate the proposal first so an immediate apply
  // enforces the same required-field checks the queued path does).
  buildProposal(args);
  switch (action) {
    case 'create':
      return applyCreate(args, ctx, env);
    case 'update':
      return applyUpdate(args, ctx, env);
    case 'delete':
      return applyDelete(args, ctx, env);
  }
}

// Write actions (create/update/delete) consult the agent_config write-gate:
// a human member applies immediately; an agent/watcher-driven write follows the
// org policy and may queue a pending run + approval card (applied later by
// manage_operations' approve handler via applyManageAgentsProposal → the apply*
// functions). list/get/set_system_agent stay immediate.
const runManageAgents = defineFlatActionTool<ManageAgentsArgs, ManageAgentsResult>(
  'manage_agents',
  {
    list: flatAction((args, ctx, env) => handleList(args, ctx, env)),
    get: flatAction((args, ctx, env) => handleGet(args, ctx, env)),
    create: flatAction((args, ctx, env) => dispatchAgentWrite('create', args, ctx, env)),
    update: flatAction((args, ctx, env) => dispatchAgentWrite('update', args, ctx, env)),
    delete: flatAction((args, ctx, env) => dispatchAgentWrite('delete', args, ctx, env)),
    set_system_agent: flatAction((args, ctx, env) => handleSetSystemAgent(args, ctx, env)),
  }
);
