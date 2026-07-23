import { getDb } from "../../db/client.js";

/**
 * Cross-connector chat-identity mapping: `(platform, team_id, platform_user_id)
 * → lobu_user_id`.
 *
 * The `chat_user_identities` table is platform-agnostic — Slack, Telegram, or a
 * custom connector all link the same way. This module is the generic seam for
 * resolving and linking those identities so callers don't reach into any one
 * connector's module (e.g. `preview/slack`). It maps a PLATFORM user id (what a
 * connector run carries) to the canonical Lobu `user` it's linked to.
 *
 * NOTE: this is a 1:1 platform-identity → user link, NOT cross-platform identity
 * CONSOLIDATION (one human's Slack + Telegram + custom identities merged to one
 * canonical user). That merge layer is a separate design — see the identity-
 * consolidation RFC.
 */

/**
 * The Lobu user id a chat-platform user has linked to, or null.
 *
 * Prefer a workspace-scoped match on `(platform, team_id, platform_user_id)`.
 * When that misses, fall back to a UNIQUE match on `(platform, platform_user_id)`
 * alone — Slack Grid keeps the same `U…` id across workspaces in an enterprise,
 * and managed installs may link under the enterprise id (`E…`) while inbound
 * events carry a workspace id (`T…`). Ambiguous multi-user matches still fail
 * closed (null): privilege callers must never guess.
 */
export async function resolveChatUserIdentity(
	platform: string,
	teamId: string | undefined,
	platformUserId: string,
): Promise<string | null> {
	const sql = getDb();
	const rows = await sql<{ lobu_user_id: string }>`
    SELECT lobu_user_id FROM chat_user_identities
    WHERE platform = ${platform} AND team_id = ${teamId ?? ""} AND platform_user_id = ${platformUserId}
    LIMIT 1
  `;
	if (rows[0]?.lobu_user_id) return rows[0].lobu_user_id;

	// Unique-by-platform-user fallback (Grid enterprise id vs workspace team id).
	const any = await sql<{ lobu_user_id: string }>`
    SELECT DISTINCT lobu_user_id FROM chat_user_identities
    WHERE platform = ${platform} AND platform_user_id = ${platformUserId}
  `;
	if (any.length === 1) return any[0]!.lobu_user_id;
	return null;
}

/**
 * Link a chat-platform identity to a Lobu user. Generic across connectors.
 *
 * Safety guard: an already-linked `(platform, team_id, platform_user_id)` is
 * NEVER silently re-bound to a DIFFERENT Lobu user by a later call — the
 * `ON CONFLICT … WHERE lobu_user_id = EXCLUDED.lobu_user_id` predicate only
 * touches `updated_at` when the mapping is unchanged, so a stale/malicious
 * re-link is a no-op rather than an account takeover. Re-binding to a new user
 * is a deliberate operation that must delete the old row first.
 *
 * Pass a transaction handle as `sql` to link atomically with a surrounding
 * write (e.g. the link-claim path); omit it to run on the pooled connection.
 */
export async function linkChatUserIdentity(
	opts: {
		platform: string;
		teamId?: string;
		platformUserId: string;
		lobuUserId: string;
	},
	sql: ReturnType<typeof getDb> = getDb(),
): Promise<void> {
	await sql`
    INSERT INTO chat_user_identities (platform, team_id, platform_user_id, lobu_user_id, updated_at)
    VALUES (${opts.platform}, ${opts.teamId ?? ""}, ${opts.platformUserId}, ${opts.lobuUserId}, now())
    ON CONFLICT (platform, team_id, platform_user_id)
      DO UPDATE SET updated_at = now()
      WHERE chat_user_identities.lobu_user_id = EXCLUDED.lobu_user_id
  `;
}
