/**
 * Tool: manage_goals
 *
 * Manage goal primitives — top-level handles that group watchers under a
 * single user-facing intent (e.g. "Keep my CRM clean"). Goals own zero or
 * more watchers via `watchers.goal_id` (ON DELETE SET NULL). The canvas
 * surface (#801) consumes this list; goal-template loading from disk is a
 * separate (owletto-side) concern.
 *
 * Actions:
 * - create: Create a goal (slug, name, optional description / template_key / metadata).
 * - update: Modify name / description / status / template_key / metadata.
 * - get:    Fetch a single goal by id or slug.
 * - list:   List goals in the org with optional status filter.
 * - archive: Soft-disable a goal (sets status='archived'); watchers keep
 *            running, the goal just leaves the active canvas.
 * - delete: Remove a goal row. Linked watchers survive via ON DELETE SET NULL.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import { recordLifecycleEvent } from '../../utils/insert-event';
import { requireOrgReadAccess, requireOrgWriteAccess } from '../../utils/organization-access';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';

// ============================================
// Types
// ============================================

const GOAL_STATUSES = ['active', 'paused', 'archived'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Goal {
  id: number;
  organization_id: string;
  slug: string;
  name: string;
  description: string | null;
  status: GoalStatus;
  template_key: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** Count of watchers currently linked via watchers.goal_id. Populated by list/get. */
  watcher_count?: number;
}

function mapGoalRow(row: Record<string, unknown>): Goal {
  const metadata = row.metadata;
  return {
    id: Number(row.id),
    organization_id: String(row.organization_id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    status: String(row.status) as GoalStatus,
    template_key: row.template_key == null ? null : String(row.template_key),
    metadata:
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    watcher_count: row.watcher_count == null ? undefined : Number(row.watcher_count),
  };
}

// ============================================
// Schema
// ============================================

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertValidSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid goal slug '${slug}'. Use 1-64 lowercase alphanumerics, '-' or '_', starting with a letter or digit.`
    );
  }
}

function assertValidStatus(status: string): asserts status is GoalStatus {
  if (!(GOAL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `Invalid goal status '${status}'. Expected one of: ${GOAL_STATUSES.join(', ')}`
    );
  }
}

const CreateGoalAction = Type.Object({
  action: Type.Literal('create'),
  slug: Type.String({
    description: 'Stable slug, unique per organization (1-64 chars, [a-z0-9_-]).',
  }),
  name: Type.String({ description: 'Human-readable goal name.' }),
  description: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('archived')], {
      description: "Initial status. Defaults to 'active'.",
    })
  ),
  template_key: Type.Optional(
    Type.String({
      description: 'Free-form pointer to the template that seeded this goal (out-of-scope loader).',
    })
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Forward-compat blob (icon, color, owner, …).',
    })
  ),
});

const UpdateGoalAction = Type.Object({
  action: Type.Literal('update'),
  goal_id: Type.Optional(Type.Number({ description: 'Goal id (or use `slug`).' })),
  slug: Type.Optional(Type.String({ description: 'Goal slug (or use `goal_id`).' })),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.Optional(
    Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('archived')])
  ),
  template_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /**
   * When true and `metadata` is provided, replace the stored metadata with
   * exactly that object (declarative apply); when false/omitted, merge into
   * the existing metadata (default).
   */
  replace_metadata: Type.Optional(Type.Boolean()),
});

const GetGoalAction = Type.Object({
  action: Type.Literal('get'),
  goal_id: Type.Optional(Type.Number()),
  slug: Type.Optional(Type.String()),
});

const ListGoalsAction = Type.Object({
  action: Type.Literal('list'),
  status: Type.Optional(
    Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('archived')])
  ),
  limit: Type.Optional(Type.Number({ description: 'Max rows to return (default 100, max 500).' })),
  offset: Type.Optional(Type.Number()),
});

const ArchiveGoalAction = Type.Object({
  action: Type.Literal('archive'),
  goal_id: Type.Optional(Type.Number()),
  slug: Type.Optional(Type.String()),
});

const DeleteGoalAction = Type.Object({
  action: Type.Literal('delete'),
  goal_id: Type.Optional(Type.Number()),
  slug: Type.Optional(Type.String()),
});

export const ManageGoalsSchema = Type.Union([
  CreateGoalAction,
  UpdateGoalAction,
  GetGoalAction,
  ListGoalsAction,
  ArchiveGoalAction,
  DeleteGoalAction,
]);

export type ManageGoalsArgs = Static<typeof ManageGoalsSchema>;

// ============================================
// Result Types
// ============================================

type ManageGoalsResult =
  | { action: 'create'; goal: Goal }
  | { action: 'update'; goal: Goal }
  | { action: 'get'; goal: Goal }
  | { action: 'list'; goals: Goal[]; total: number; limit: number; offset: number }
  | { action: 'archive'; goal: Goal }
  | { action: 'delete'; deleted: true; goal_id: number; slug: string };

// ============================================
// Main Function
// ============================================

export async function manageGoals(
  args: ManageGoalsArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<ManageGoalsResult> {
  return routeAction<ManageGoalsResult>('manage_goals', args.action, ctx, {
    create: () => handleCreate(args as Extract<ManageGoalsArgs, { action: 'create' }>, ctx),
    update: () => handleUpdate(args as Extract<ManageGoalsArgs, { action: 'update' }>, ctx),
    get: () => handleGet(args as Extract<ManageGoalsArgs, { action: 'get' }>, ctx),
    list: () => handleList(args as Extract<ManageGoalsArgs, { action: 'list' }>, ctx),
    archive: () => handleArchive(args as Extract<ManageGoalsArgs, { action: 'archive' }>, ctx),
    delete: () => handleDelete(args as Extract<ManageGoalsArgs, { action: 'delete' }>, ctx),
  });
}

// ============================================
// Helpers
// ============================================

/**
 * Resolve a goal by id or slug, scoped to the caller's organization. Throws
 * if neither is provided or the row doesn't exist.
 */
async function resolveGoal(
  goalId: number | undefined,
  slug: string | undefined,
  ctx: ToolContext
): Promise<Goal> {
  if (goalId === undefined && (slug === undefined || slug === null)) {
    throw new Error('Either goal_id or slug is required');
  }
  if (!ctx.organizationId) {
    throw new Error('Organization context is required');
  }

  const sql = getDb();
  const rows = goalId !== undefined
    ? await sql`
        SELECT g.*, (SELECT COUNT(*)::int FROM watchers w WHERE w.goal_id = g.id) AS watcher_count
        FROM goals g
        WHERE g.id = ${goalId} AND g.organization_id = ${ctx.organizationId}
        LIMIT 1
      `
    : await sql`
        SELECT g.*, (SELECT COUNT(*)::int FROM watchers w WHERE w.goal_id = g.id) AS watcher_count
        FROM goals g
        WHERE g.slug = ${slug as string} AND g.organization_id = ${ctx.organizationId}
        LIMIT 1
      `;

  if (rows.length === 0) {
    throw new Error(`Goal ${goalId ?? `'${slug}'`} not found`);
  }
  return mapGoalRow(rows[0] as Record<string, unknown>);
}

// ============================================
// Action Handlers
// ============================================

async function handleCreate(
  args: Extract<ManageGoalsArgs, { action: 'create' }>,
  ctx: ToolContext
): Promise<ManageGoalsResult> {
  const sql = getDb();
  await requireOrgWriteAccess(sql, ctx);
  if (!ctx.organizationId) {
    throw new Error('Organization context is required');
  }

  assertValidSlug(args.slug);
  const status: GoalStatus = args.status ?? 'active';
  // status is already constrained by the Type.Union, but assert for the
  // CHECK constraint mirror — keeps the error path predictable for handler-
  // direct callers that skip the typebox layer.
  assertValidStatus(status);

  const metadata = args.metadata ?? {};

  const inserted = await sql`
    INSERT INTO goals (organization_id, slug, name, description, status, template_key, metadata)
    VALUES (
      ${ctx.organizationId},
      ${args.slug},
      ${args.name},
      ${args.description ?? null},
      ${status},
      ${args.template_key ?? null},
      ${sql.json(metadata)}
    )
    RETURNING *
  `;

  const goal = mapGoalRow(inserted[0] as Record<string, unknown>);
  goal.watcher_count = 0;

  recordLifecycleEvent({
    organizationId: ctx.organizationId,
    entityType: 'goal',
    op: 'created',
    entityId: goal.id,
    summary: `Goal '${goal.name}' created`,
    createdBy: ctx.userId,
  });

  return { action: 'create', goal };
}

async function handleUpdate(
  args: Extract<ManageGoalsArgs, { action: 'update' }>,
  ctx: ToolContext
): Promise<ManageGoalsResult> {
  const sql = getDb();
  await requireOrgWriteAccess(sql, ctx);
  const existing = await resolveGoal(args.goal_id, args.slug, ctx);

  if (args.status !== undefined) {
    assertValidStatus(args.status);
  }

  const replaceMetadata = args.replace_metadata === true && args.metadata !== undefined;
  const hasMetadata = args.metadata !== undefined;

  // description / template_key are tri-state (undefined = leave, null = clear).
  const hasDescriptionArg = Object.hasOwn(args, 'description');
  const descriptionValue = hasDescriptionArg ? (args.description ?? null) : null;
  const hasTemplateKeyArg = Object.hasOwn(args, 'template_key');
  const templateKeyValue = hasTemplateKeyArg ? (args.template_key ?? null) : null;

  const updated = await sql`
    UPDATE goals
    SET name = COALESCE(${args.name ?? null}::text, name),
        description = CASE WHEN ${hasDescriptionArg} THEN ${descriptionValue}::text ELSE description END,
        status = COALESCE(${args.status ?? null}::text, status),
        template_key = CASE WHEN ${hasTemplateKeyArg} THEN ${templateKeyValue}::text ELSE template_key END,
        metadata = ${
          replaceMetadata
            ? sql`${sql.json(args.metadata ?? {})}::jsonb`
            : hasMetadata
              ? sql`COALESCE(metadata, '{}'::jsonb) || ${sql.json(args.metadata ?? {})}::jsonb`
              : sql`metadata`
        },
        updated_at = now()
    WHERE id = ${existing.id} AND organization_id = ${ctx.organizationId}
    RETURNING *, (SELECT COUNT(*)::int FROM watchers w WHERE w.goal_id = goals.id) AS watcher_count
  `;

  if (updated.length === 0) {
    throw new Error(`Goal ${existing.id} not found`);
  }

  return { action: 'update', goal: mapGoalRow(updated[0] as Record<string, unknown>) };
}

async function handleGet(
  args: Extract<ManageGoalsArgs, { action: 'get' }>,
  ctx: ToolContext
): Promise<ManageGoalsResult> {
  const sql = getDb();
  await requireOrgReadAccess(sql, ctx);
  const goal = await resolveGoal(args.goal_id, args.slug, ctx);
  return { action: 'get', goal };
}

async function handleList(
  args: Extract<ManageGoalsArgs, { action: 'list' }>,
  ctx: ToolContext
): Promise<ManageGoalsResult> {
  const sql = getDb();
  await requireOrgReadAccess(sql, ctx);
  if (!ctx.organizationId) {
    throw new Error('Organization context is required');
  }
  if (args.status !== undefined) {
    assertValidStatus(args.status);
  }

  const limit = Math.min(args.limit ?? 100, 500);
  const offset = args.offset ?? 0;

  const rows = args.status
    ? await sql`
        SELECT g.*, (SELECT COUNT(*)::int FROM watchers w WHERE w.goal_id = g.id) AS watcher_count
        FROM goals g
        WHERE g.organization_id = ${ctx.organizationId} AND g.status = ${args.status}
        ORDER BY g.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await sql`
        SELECT g.*, (SELECT COUNT(*)::int FROM watchers w WHERE w.goal_id = g.id) AS watcher_count
        FROM goals g
        WHERE g.organization_id = ${ctx.organizationId}
        ORDER BY g.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  const goals = (rows as Record<string, unknown>[]).map(mapGoalRow);
  return { action: 'list', goals, total: goals.length, limit, offset };
}

async function handleArchive(
  args: Extract<ManageGoalsArgs, { action: 'archive' }>,
  ctx: ToolContext
): Promise<ManageGoalsResult> {
  const sql = getDb();
  await requireOrgWriteAccess(sql, ctx);
  const existing = await resolveGoal(args.goal_id, args.slug, ctx);

  const updated = await sql`
    UPDATE goals
    SET status = 'archived', updated_at = now()
    WHERE id = ${existing.id} AND organization_id = ${ctx.organizationId}
    RETURNING *, (SELECT COUNT(*)::int FROM watchers w WHERE w.goal_id = goals.id) AS watcher_count
  `;

  if (updated.length === 0) {
    throw new Error(`Goal ${existing.id} not found`);
  }

  const goal = mapGoalRow(updated[0] as Record<string, unknown>);

  recordLifecycleEvent({
    organizationId: ctx.organizationId!,
    entityType: 'goal',
    op: 'updated',
    entityId: goal.id,
    summary: `Goal '${goal.name}' archived`,
    extra: { status: 'archived' },
    createdBy: ctx.userId,
  });

  return { action: 'archive', goal };
}

async function handleDelete(
  args: Extract<ManageGoalsArgs, { action: 'delete' }>,
  ctx: ToolContext
): Promise<ManageGoalsResult> {
  const sql = getDb();
  await requireOrgWriteAccess(sql, ctx);
  const existing = await resolveGoal(args.goal_id, args.slug, ctx);

  const deleted = await sql`
    DELETE FROM goals
    WHERE id = ${existing.id} AND organization_id = ${ctx.organizationId}
    RETURNING id, slug, name
  `;

  if (deleted.length === 0) {
    throw new Error(`Goal ${existing.id} not found`);
  }

  recordLifecycleEvent({
    organizationId: ctx.organizationId!,
    entityType: 'goal',
    op: 'deleted',
    entityId: existing.id,
    summary: `Goal '${existing.name}' deleted`,
    createdBy: ctx.userId,
  });

  return {
    action: 'delete',
    deleted: true,
    goal_id: existing.id,
    slug: existing.slug,
  };
}
