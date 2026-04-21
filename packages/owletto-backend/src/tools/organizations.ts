/**
 * Tools: list_organizations, switch_organization
 *
 * Exposed only when the MCP session was initiated from the unscoped /mcp endpoint.
 * Allows agents to discover orgs and switch context mid-session.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { buildWorkspaceInstructions } from '../utils/workspace-instructions';
import { getWorkspaceProvider } from '../workspace';
import { joinPublicOrganization } from '../workspace/join-public';
import type { OrgInfo } from '../workspace/types';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ListOrganizationsSchema = Type.Object({
  search: Type.Optional(
    Type.String({ description: 'Filter organizations by name (case-insensitive substring match)' })
  ),
});

export const SwitchOrganizationSchema = Type.Object({
  org: Type.String({
    description:
      'Organization slug to switch to (must appear in a prior list_organizations result)',
    minLength: 1,
  }),
});

export const JoinOrganizationSchema = Type.Object({
  organization_slug: Type.Optional(
    Type.String({
      description:
        'Organization slug to join. Optional on scoped /mcp/{slug} sessions (defaults to the current workspace). Required on the unscoped /mcp endpoint.',
      minLength: 1,
    })
  ),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function listOrganizations(
  args: Static<typeof ListOrganizationsSchema>,
  _env: Env,
  ctx: { userId: string }
): Promise<unknown> {
  const provider = getWorkspaceProvider();
  const orgs = await provider.listOrganizations(args.search, ctx.userId);
  return orgs.map((o: OrgInfo) => ({
    slug: o.slug,
    name: o.name,
    is_member: o.is_member,
    visibility: o.visibility,
  }));
}

export async function switchOrganization(
  args: Static<typeof SwitchOrganizationSchema>,
  _env: Env,
  ctx: { userId: string; currentOrgId: string | null }
): Promise<{
  switched: true;
  org: { slug: string; name: string; id: string; role: string };
  previous_org_slug: string | null;
  instructions: string | null;
}> {
  const sql = getDb();

  // Resolve slug → org
  const orgRows = await sql`
    SELECT id, name, slug FROM "organization" WHERE slug = ${args.org} LIMIT 1
  `;
  if (orgRows.length === 0) {
    throw new Error(`Organization '${args.org}' not found`);
  }
  const org = orgRows[0] as { id: string; name: string; slug: string };

  // Verify membership
  const memberRows = await sql`
    SELECT role FROM "member"
    WHERE "organizationId" = ${org.id} AND "userId" = ${ctx.userId}
    LIMIT 1
  `;
  if (memberRows.length === 0) {
    throw new Error(`You are not a member of organization '${args.org}'`);
  }
  const role = memberRows[0].role as string;

  // Resolve previous org slug
  let previousOrgSlug: string | null = null;
  if (ctx.currentOrgId) {
    previousOrgSlug = await getWorkspaceProvider().getOrgSlug(ctx.currentOrgId);
  }

  // Build workspace instructions for the new org
  const instructions = await buildWorkspaceInstructions(org.id);

  return {
    switched: true,
    org: { slug: org.slug, name: org.name, id: org.id, role },
    previous_org_slug: previousOrgSlug,
    instructions,
  };
}

export async function joinOrganization(
  args: Static<typeof JoinOrganizationSchema>,
  _env: Env,
  ctx: { userId: string; currentOrgId: string | null; scopes: string[] | null }
): Promise<{
  status: 'joined' | 'already_member';
  org: { slug: string; name: string; id: string; role: string };
  note?: string;
}> {
  let slug = args.organization_slug ?? null;
  if (!slug) {
    if (!ctx.currentOrgId) {
      throw new Error(
        'organization_slug is required when calling join_organization on the unscoped /mcp endpoint.'
      );
    }
    slug = await getWorkspaceProvider().getOrgSlug(ctx.currentOrgId);
    if (!slug) {
      throw new Error('Could not resolve the current organization slug.');
    }
  }

  const result = await joinPublicOrganization({ userId: ctx.userId, orgSlug: slug });
  if (result.status === 'not_found') {
    throw new Error(`Organization '${slug}' not found.`);
  }
  if (result.status === 'not_public') {
    throw new Error(
      `Organization '${slug}' is not public. Ask an organization owner for an invitation.`
    );
  }

  const sql = getDb();
  const rows = await sql<{ name: string }>`
    SELECT name FROM "organization" WHERE id = ${result.organizationId} LIMIT 1
  `;
  const name = rows[0]?.name ?? slug;

  const scopes = ctx.scopes;
  const readOnlyScopes =
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    !scopes.includes('mcp:write') &&
    !scopes.includes('mcp:admin');
  const note = readOnlyScopes
    ? 'Your current OAuth session is read-only. Reconnect with write access (mcp:write) to push data to this workspace.'
    : undefined;

  return {
    status: result.status,
    org: { slug, name, id: result.organizationId, role: result.role },
    ...(note ? { note } : {}),
  };
}
