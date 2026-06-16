/**
 * Read-only REST routes that back `lobu connector run` on the CLI.
 *
 * Two lookups the CLI needs before it can execute a connector locally against
 * a device-bound browser_session:
 *
 *   GET /api/:orgSlug/connector-run/auth-profile/:slug   resolves the auth
 *     profile (including user_data_dir / cdp_url) so the CLI knows where the
 *     managed Chrome lives on this Mac.
 *
 *   GET /api/:orgSlug/connector-run/feed/:id             returns the feed's
 *     connector_key, config, and checkpoint so `--from-feed <id>` can
 *     subsume connector + auth + config + checkpoint in one flag.
 *
 * Both endpoints authenticate the user via the existing mcpAuth middleware
 * and scope by the user's bound org. They never write — there's no parallel
 * mutation in this surface to keep the CLI's local-run path strictly
 * read-only against the server.
 */
import type { Context } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { getAuthProfileBySlug } from '../utils/auth-profiles';
import { requireOrgUser } from '../utils/require-org-user';

export async function restGetAuthProfileForRun(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const slug = (c.req.param('slug') ?? '').trim();
  if (!slug) return c.json({ error: 'slug required' }, 400);

  const profile = await getAuthProfileBySlug(auth.organizationId, slug);
  if (!profile) return c.json({ error: `Auth profile '${slug}' not found` }, 404);

  // Pass through the read-only fields the CLI's local executor consumes.
  // browser_session auth is CDP attach (cdp_url); no cookie/auth_data
  // material is ever returned to the CLI.
  return c.json({
    profile: {
      id: profile.id,
      slug: profile.slug,
      display_name: profile.display_name,
      connector_key: profile.connector_key,
      profile_kind: profile.profile_kind,
      status: profile.status,
      browser_kind: profile.browser_kind,
      cdp_url: profile.cdp_url,
      device_worker_id: profile.device_worker_id,
    },
  });
}

export async function restGetFeedForRun(c: Context<{ Bindings: Env }>) {
  const auth = requireOrgUser(c);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const id = Number((c.req.param('id') ?? '').trim());
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: 'invalid feed id' }, 400);
  }

  const sql = getDb();
  const rows = (await sql`
    SELECT f.id, f.feed_key, f.config, f.checkpoint, f.connection_id,
           c.connector_key, c.auth_profile_id, c.device_worker_id,
           ap.slug AS auth_profile_slug
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    WHERE f.id = ${id}
      AND f.organization_id = ${auth.organizationId}
      AND f.deleted_at IS NULL
      AND c.deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return c.json({ error: `Feed ${id} not found` }, 404);

  const row = rows[0]!;
  return c.json({
    feed: {
      id: row.id,
      feed_key: row.feed_key,
      connection_id: row.connection_id,
      connector_key: row.connector_key,
      auth_profile_slug: row.auth_profile_slug,
      device_worker_id: row.device_worker_id,
      config: row.config ?? {},
      checkpoint: row.checkpoint ?? null,
    },
  });
}
