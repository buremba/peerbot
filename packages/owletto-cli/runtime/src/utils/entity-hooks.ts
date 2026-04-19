/**
 * Generic entity lifecycle hook registry.
 *
 * Entity types can register hooks that fire during create/delete operations.
 * Hooks are skipped when `skipHooks: true` is passed (used by auth callbacks
 * to prevent circular calls).
 */

import type { Env } from '../index';
import type { CreatedEntity, EntityData } from './entity-management';

export interface EntityHookContext {
  organizationId: string;
  userId: string | null;
  env?: Env;
}

export interface EntityLifecycleHooks {
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

export function registerEntityHooks(entityType: string, hooks: EntityLifecycleHooks): void {
  registry[entityType] = hooks;
}

export function getEntityHooks(entityType: string): EntityLifecycleHooks | undefined {
  return registry[entityType];
}

// ---------------------------------------------------------------------------
// $member hooks
// ---------------------------------------------------------------------------

import { getDb } from '../db/client';

/**
 * Resolve the email field name from the $member entity type's metadata_schema.
 * Uses the `x-email` annotation; falls back to 'email'.
 */
async function resolveMemberEmailField(organizationId: string): Promise<string> {
  const sql = getDb();
  const rows = await sql`
    SELECT metadata_schema FROM entity_types
    WHERE slug = '$member' AND deleted_at IS NULL AND organization_id = ${organizationId}
    LIMIT 1
  `;
  if (rows.length === 0) return 'email';
  const schema = rows[0].metadata_schema as
    | { properties?: Record<string, { 'x-email'?: boolean }> }
    | undefined;
  const props = schema?.properties;
  if (!props) return 'email';
  return Object.entries(props).find(([, p]) => p['x-email'])?.[0] ?? 'email';
}

registerEntityHooks('$member', {
  async beforeCreate(data, ctx) {
    const emailField = await resolveMemberEmailField(ctx.organizationId);
    const meta = { ...(data.metadata ?? {}) };
    const email = meta[emailField] as string | undefined;

    if (email) {
      // Insert a Better Auth invitation (skip if one already pending)
      const sql = getDb();
      await sql`
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
      `;
      meta.status = 'invited';
    } else {
      meta.status = meta.status ?? 'active';
    }

    return { ...data, metadata: meta };
  },

  async afterCreate(entity, ctx) {
    const emailField = await resolveMemberEmailField(ctx.organizationId);
    const meta = entity.metadata as Record<string, unknown> | null;
    const email = meta?.[emailField] as string | undefined;
    if (!email || !ctx.env) return;

    // Send invitation email via Resend
    const resendKey = ctx.env.RESEND_API_KEY;
    if (!resendKey) return;

    const runtimeNodeEnv = ctx.env.NODE_ENV || process.env.NODE_ENV || 'development';
    const fromAddress =
      ctx.env.AUTH_EMAIL_FROM ||
      (runtimeNodeEnv !== 'production' ? 'Owletto <onboarding@resend.dev>' : null);
    if (!fromAddress) return;

    try {
      const { Resend } = await import('resend');
      const resend = new Resend(resendKey);

      // Look up org name
      const sql = getDb();
      const orgRows =
        await sql`SELECT name FROM organization WHERE id = ${ctx.organizationId} LIMIT 1`;
      const orgName = (orgRows[0]?.name as string) || 'your organization';

      // Look up inviter name
      let inviterName = 'Someone';
      if (ctx.userId) {
        const userRows = await sql`SELECT name FROM "user" WHERE id = ${ctx.userId} LIMIT 1`;
        if (userRows[0]?.name) inviterName = userRows[0].name as string;
      }

      // Get the invitation ID for the accept URL
      const invRows = await sql`
        SELECT id FROM invitation
        WHERE "organizationId" = ${ctx.organizationId} AND email = ${email} AND status = 'pending'
        ORDER BY "createdAt" DESC LIMIT 1
      `;
      if (invRows.length === 0) return;

      const { getConfiguredPublicOrigin } = await import('./public-origin');
      const baseUrl = getConfiguredPublicOrigin() || 'http://localhost:8787';
      const acceptUrl = `${baseUrl}/auth/accept-invitation?invitationId=${invRows[0].id}`;

      await resend.emails.send({
        from: fromAddress,
        to: email,
        subject: `You've been invited to ${orgName}`,
        html: `<p>${inviterName} invited you to join <strong>${orgName}</strong> on Owletto.</p><p><a href="${acceptUrl}">Accept invitation</a></p><p>This invitation will expire in 48 hours.</p>`,
      });
      console.info(`[Entity Hook] Invitation email sent to ${email}`);
    } catch (err) {
      console.error('[Entity Hook] Failed to send invitation email:', err);
    }
  },

  async beforeDelete(entity, ctx) {
    const emailField = await resolveMemberEmailField(ctx.organizationId);
    const email = entity.metadata?.[emailField] as string | undefined;
    if (!email) return;

    // Cancel any pending invitation for this email
    const sql = getDb();
    await sql`
      UPDATE invitation
      SET status = 'canceled'
      WHERE "organizationId" = ${ctx.organizationId}
        AND email = ${email}
        AND status = 'pending'
    `;
  },
});
