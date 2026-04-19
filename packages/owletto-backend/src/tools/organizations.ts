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
