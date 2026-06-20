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

import { type Static, Type } from '@sinclair/typebox';
import { createDbClientFromEnv } from '../../db/client';
import type { Env } from '../../index';
import { isValidAgentId } from '../../lobu/stores/postgres-stores';
import { ToolUserError } from '../../utils/errors';
import { requireOrgReadAccess, requireOrgWriteAccess } from '../../utils/organization-access';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { defineFlatActionTool, flatAction } from './action-tool';

// ============================================
// Typebox Schema (Flattened for MCP)
// ============================================

export const ManageAgentsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('list'),
      Type.Literal('get'),
      Type.Literal('create'),
      Type.Literal('update'),
      Type.Literal('delete'),
      Type.Literal('set_system_agent'),
    ],
    { description: 'Action to perform' }
  ),

  agent_id: Type.Optional(
    Type.String({
      description:
        '[get/create/update/delete/set_system_agent] Agent ID (lowercase slug, e.g. "builder").',
    })
  ),
  name: Type.Optional(
    Type.String({ description: '[create/update] Display name for the agent.' })
  ),
  description: Type.Optional(
    Type.String({ description: '[create/update] Agent description.' })
  ),
  identity_md: Type.Optional(
    Type.String({ description: '[create/update] Agent identity / system prompt (Markdown).' })
  ),
});

// ============================================
// Type Definitions
// ============================================

export type ManageAgentsArgs = Static<typeof ManageAgentsSchema>;

interface AgentRecord {
  id: string;
  name: string;
  description: string | null;
  owner_platform: string | null;
  owner_user_id: string | null;
  created_at: string;
  last_used_at: string | null;
  is_system_agent: boolean;
}

export type ManageAgentsResult =
  | { action: 'list'; agents: AgentRecord[] }
  | { action: 'get'; agent: AgentRecord }
  | { action: 'create'; agent_id: string; created: boolean }
  | { action: 'update'; agent_id: string; updated_fields: string[] }
  | { action: 'delete'; agent_id: string; deleted: boolean }
  | { action: 'set_system_agent'; system_agent_id: string };

// ============================================
// Action handlers
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

async function handleCreate(
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

async function handleUpdate(
  args: ManageAgentsArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  if (!args.agent_id) {
    throw new ToolUserError('agent_id is required for update action');
  }
  const sql = createDbClientFromEnv(env);
  const updatedFields: string[] = [];
  if (args.name !== undefined) updatedFields.push('name');
  if (args.description !== undefined) updatedFields.push('description');
  if (args.identity_md !== undefined) updatedFields.push('identity_md');
  if (updatedFields.length === 0) {
    throw new ToolUserError(
      'update requires at least one of: name, description, identity_md'
    );
  }
  // Per-field CASE WHEN ... THEN ... ELSE col END so only provided fields change
  // (mirrors manage_watchers crud's partial-update idiom).
  const rows = await sql`
    UPDATE agents SET
      updated_at = NOW(),
      name = CASE WHEN ${args.name !== undefined} THEN ${args.name ?? null} ELSE name END,
      description = CASE WHEN ${args.description !== undefined} THEN ${args.description ?? null} ELSE description END,
      identity_md = CASE WHEN ${args.identity_md !== undefined} THEN ${args.identity_md ?? ''} ELSE identity_md END
    WHERE organization_id = ${ctx.organizationId} AND id = ${args.agent_id}
    RETURNING id
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Agent "${args.agent_id}" not found`, 404);
  }
  return { action: 'update', agent_id: args.agent_id, updated_fields: updatedFields };
}

async function handleDelete(
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

const runManageAgents = defineFlatActionTool<ManageAgentsArgs, ManageAgentsResult>(
  'manage_agents',
  {
    list: flatAction((args, ctx, env) => handleList(args, ctx, env)),
    get: flatAction((args, ctx, env) => handleGet(args, ctx, env)),
    create: flatAction((args, ctx, env) => handleCreate(args, ctx, env)),
    update: flatAction((args, ctx, env) => handleUpdate(args, ctx, env)),
    delete: flatAction((args, ctx, env) => handleDelete(args, ctx, env)),
    set_system_agent: flatAction((args, ctx, env) => handleSetSystemAgent(args, ctx, env)),
  }
);
