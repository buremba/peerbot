/**
 * Generic entity lifecycle hook registry.
 *
 * Entity types can register hooks that fire during create/delete operations.
 * Hooks are skipped when `skipHooks: true` is passed (used by auth callbacks
 * to prevent circular calls).
 */

import { createElement } from 'react';
import { sendTransactionalEmail } from '../email/send';
import { InvitationEmail, invitationSubject } from '../email/templates/invitation';
import type { Env } from '../index';
import { type DbClient, getDb } from '../db/client';
import { resolveMemberSchemaFields } from './member-entity';
import { getConfiguredPublicOrigin } from './public-origin';
import {
  insertWorkspaceChangeEventInTransaction,
  recordWorkspaceChangeEvent,
  type WorkspaceChangeEventParams,
} from './insert-event';
import type { CreatedEntity, EntityData } from './entity-management';
import logger from './logger';

export interface EntityHookContext {
  organizationId: string;
  userId: string | null;
  env?: Env;
  /** Caller-owned transaction for hook database work. */
  sql?: DbClient;
  /** Register network side effects that may run only after the caller commits. */
  deferAfterCommit?: (effect: () => Promise<void>) => void;
}

interface EntityLifecycleHooks {
  /** Runs before INSERT. Can mutate data (e.g. set status). Throw to abort. */
  beforeCreate?: (data: EntityData, ctx: EntityHookContext) => Promise<EntityData>;
  /** Runs after INSERT. For side-effects (e.g. sending notifications). */
  afterCreate?: (entity: CreatedEntity, ctx: EntityHookContext) => Promise<void>;
  /** Runs before soft/hard delete. For cleanup (e.g. cancelling invitations). */
  beforeDelete?: (
    entity: { id: number; entity_type: string; metadata: Record<string, unknown> | null },
    ctx: EntityHookContext
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry: Record<string, EntityLifecycleHooks> = {};

function registerEntityHooks(entityType: string, hooks: EntityLifecycleHooks): void {
  registry[entityType] = hooks;
}

export function getEntityHooks(entityType: string): EntityLifecycleHooks | undefined {
  return registry[entityType];
}

// ---------------------------------------------------------------------------
// $member hooks
// ---------------------------------------------------------------------------

async function sendMemberInvitationEmail(
  entity: CreatedEntity,
  ctx: EntityHookContext
): Promise<void> {
  const { emailField } = await resolveMemberSchemaFields(ctx.organizationId);
  const meta = entity.metadata as Record<string, unknown> | null;
  const email = meta?.[emailField] as string | undefined;
  if (!email || !ctx.env?.RESEND_API_KEY) return;

  try {
    const sql = getDb();
    const orgRows =
      await sql`SELECT name FROM organization WHERE id = ${ctx.organizationId} LIMIT 1`;
    const orgName = (orgRows[0]?.name as string) || 'your organization';

    let inviterName: string | undefined;
    if (ctx.userId) {
      const userRows = await sql`SELECT name FROM "user" WHERE id = ${ctx.userId} LIMIT 1`;
      if (userRows[0]?.name) inviterName = userRows[0].name as string;
    }

    const invRows = await sql`
      SELECT id FROM invitation
      WHERE "organizationId" = ${ctx.organizationId} AND email = ${email} AND status = 'pending'
      ORDER BY "createdAt" DESC LIMIT 1
    `;
    if (invRows.length === 0) return;

    const baseUrl = getConfiguredPublicOrigin() || 'http://localhost:8787';
    const acceptUrl = `${baseUrl}/auth/accept-invitation?invitationId=${invRows[0].id}`;

    await sendTransactionalEmail({
      env: ctx.env,
      to: email,
      category: 'invite',
      subject: invitationSubject({ inviterName, orgName }),
      react: createElement(InvitationEmail, { inviterName, orgName, acceptUrl }),
    });
  } catch (err) {
    logger.error({ err }, '[Entity Hook] Failed to send invitation email');
  }
}

registerEntityHooks('$member', {
  async beforeCreate(data, ctx) {
    const sql = ctx.sql ?? getDb();
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, sql);
    const meta = { ...(data.metadata ?? {}) };
    const email = meta[emailField] as string | undefined;

    if (email) {
      // Insert a Better Auth invitation (skip if one already pending)
      const inserted = (await sql`
        INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId", "createdAt")
        SELECT
          gen_random_uuid()::text,
          ${ctx.organizationId},
          ${email},
          'member',
          'pending',
          ${new Date(Date.now() + 48 * 60 * 60 * 1000)},
          ${ctx.userId},
          current_timestamp
        WHERE NOT EXISTS (
          SELECT 1 FROM invitation
          WHERE "organizationId" = ${ctx.organizationId}
            AND email = ${email}
            AND status = 'pending'
        )
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      if (inserted.length > 0) {
        const event: WorkspaceChangeEventParams = {
          organizationId: ctx.organizationId,
          resourceKind: 'invitation',
          resourceId: inserted[0].id,
          op: 'created',
          summary: 'Invitation sent',
          state: {
            id: inserted[0].id,
            role: 'member',
            status: 'pending',
          },
          changedFields: ['role', 'status'],
          actorSource: 'ui',
          createdBy: ctx.userId ?? null,
        };
        if (ctx.sql) {
          await insertWorkspaceChangeEventInTransaction(event, sql);
        } else {
          recordWorkspaceChangeEvent(event);
        }
      }
      meta.status = 'invited';
    } else {
      meta.status = meta.status ?? 'active';
    }

    return { ...data, metadata: meta };
  },

  async afterCreate(entity, ctx) {
    if (ctx.deferAfterCommit) {
      ctx.deferAfterCommit(() => sendMemberInvitationEmail(entity, ctx));
      return;
    }
    await sendMemberInvitationEmail(entity, ctx);
  },

  async beforeDelete(entity, ctx) {
    const sql = ctx.sql ?? getDb();
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, sql);
    const email = entity.metadata?.[emailField] as string | undefined;
    if (!email) return;

    // Cancel any pending invitation for this email
    const cancelled = (await sql`
      UPDATE invitation
      SET status = 'canceled'
      WHERE "organizationId" = ${ctx.organizationId}
        AND email = ${email}
        AND status = 'pending'
      RETURNING id, role, status
    `) as unknown as Array<{
      id: string;
      role: string | null;
      status: string | null;
    }>;
    // The $member delete cancels every pending invite; record each
    // cancellation so the invitation lifecycle audit (send → canceled) stays
    // complete.
    for (const inv of cancelled) {
      const event: WorkspaceChangeEventParams = {
        organizationId: ctx.organizationId,
        resourceKind: 'invitation',
        resourceId: inv.id,
        op: 'updated',
        summary: 'Invitation cancelled',
        state: {
          id: inv.id,
          role: inv.role ?? 'member',
          status: inv.status ?? 'canceled',
        },
        changedFields: ['status'],
        actorSource: 'ui',
        createdBy: ctx.userId ?? null,
      };
      if (ctx.sql) {
        await insertWorkspaceChangeEventInTransaction(event, sql);
      } else {
        recordWorkspaceChangeEvent(event);
      }
    }
  },
});
