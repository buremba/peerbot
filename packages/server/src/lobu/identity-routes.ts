import { Hono } from 'hono';
import { mcpAuth } from '../auth/middleware';
import { isAdminOrOwnerRole } from '../tools/access-control';
import type { Env } from '../index';
import { IdentityRekeyError, rekeyEntityIdentities } from '../identity/rekey';
import { requireSessionOrAdminPat } from './agent-routes';
import { orgContext } from './stores/org-context';

export const identityRoutes = new Hono<{ Bindings: Env }>();

identityRoutes.post('/rekey', mcpAuth, async (c) => {
  const organizationId = c.get('organizationId');
  if (!organizationId) return c.json({ error: 'Organization required' }, 401);
  // Two layers, as every other admin mutation in this directory: the token must
  // be a web session or carry mcp:admin, AND the caller must be owner/admin. A
  // re-key rewrites the scope of every live identity row in the namespace, so a
  // read-scoped PAT belonging to an admin must not reach it.
  const denied = requireSessionOrAdminPat(c);
  if (denied) return denied;
  if (!isAdminOrOwnerRole(c.get('memberRole'))) {
    return c.json({ error: 'Re-keying identities requires an owner or admin.' }, 403);
  }
  let body: { namespace?: unknown; mapping?: unknown; apply?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400);
  }
  if (typeof body.namespace !== 'string' || !body.namespace.trim()) {
    return c.json({ error: 'Identity namespace is required.' }, 400);
  }
  if (body.apply !== undefined && typeof body.apply !== 'boolean') {
    return c.json({ error: 'apply must be a boolean.' }, 400);
  }
  try {
    return await orgContext.run({ organizationId: String(organizationId) }, async () =>
      c.json(
        await rekeyEntityIdentities({
          organizationId: String(organizationId),
          namespace: body.namespace as string,
          mapping: body.mapping,
          apply: body.apply === true,
        })
      )
    );
  } catch (error) {
    if (error instanceof IdentityRekeyError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});
