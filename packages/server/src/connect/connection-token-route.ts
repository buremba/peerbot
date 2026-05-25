/**
 * Managed-connector connection-token endpoint.
 *
 * Public-org managed connectors: a managed connector lives in a PUBLIC org
 * (`organization.visibility = 'public'`) with a managed `oauth_app`. A user
 * JOINS that org (a `member` row) and CONNECTS normally — consent against the
 * managed app mints a connection OWNED by them (`connections.created_by`). The
 * managed client secret + refresh token stay in the cloud and never leave it.
 *
 * At RUNTIME the user's LOCAL Lobu instance fetches a fresh ACCESS token for
 * its own user's connection via this endpoint, authenticating with that user's
 * own cloud PAT (`owl_pat_*`). The token is resolved/refreshed server-side via
 * the existing `CredentialService` (`resolveExecutionAuth`) and ONLY the access
 * token + expiry are returned — never the refresh token or client secret.
 *
 * Owner-scoped: the lookup is keyed on `created_by = <authed user>`, so a user
 * can only fetch tokens for connections they own.
 *
 * Endpoint (PAT-gated):
 *   - POST /oauth/connection-token  { org, connector_key }
 */

import type { Env } from "@lobu/connector-sdk";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Hono } from "hono";
import { authenticatePat, extractPatBearer } from "../auth/pat-auth";
import { getDb } from "../db/client";
import { resolveExecutionAuth } from "../utils/execution-context";
import logger from "../utils/logger";

type ConnectionTokenEnv = {
	Bindings: Env;
	Variables: { authedUserId: string; authedOrgId: string };
};

const connectionTokenRoutes = new Hono<ConnectionTokenEnv>();

/**
 * PAT auth for the connection-token endpoint — the single shared
 * `authenticatePat` gate (verifies the token, rejects null-org / cross-tenant
 * PATs, resolves the user + org). On success the authenticated user + org are
 * stashed on the context for the handler's owner-scoped lookup.
 */
connectionTokenRoutes.use("/oauth/connection-token", async (c, next) => {
	const bearerValue = extractPatBearer(c.req.header("Authorization"));
	if (!bearerValue) {
		return c.json(
			{ error: "unauthorized", error_description: "Bearer PAT required" },
			401,
		);
	}

	const result = await authenticatePat(getDb(), bearerValue);
	if (!result.ok) {
		return c.json(
			{ error: result.error, error_description: result.error_description },
			result.status,
		);
	}

	c.set("authedUserId", result.userId);
	c.set("authedOrgId", result.organizationId);
	return next();
});

const TokenBody = Type.Object({
	org: Type.String({ minLength: 1 }),
	connector_key: Type.String({ minLength: 1 }),
});
const tokenValidator = TypeCompiler.Compile(TokenBody);

/**
 * POST /oauth/connection-token
 * Return a fresh access token for the authed user's OWN active connection to
 * `connector_key` in `org`.
 *
 * The cloud owns the managed grant: it resolves the connection's
 * `oauth_account` (token store) + managed `oauth_app` (client_id/secret) and
 * runs the EXISTING `resolveExecutionAuth` path, which refreshes via the
 * managed secret when the token is expiring. Secrets + the refresh token are
 * held server-side and never returned.
 *
 * Authorization:
 *   - 403 if the authed user is not a `member` of `org`.
 *   - The connection lookup is owner-scoped (`created_by = <authed user>`), so
 *     a user can only fetch tokens for connections they own. 404 if none.
 */
connectionTokenRoutes.post("/oauth/connection-token", async (c) => {
	const raw = await c.req.json().catch(() => null);
	if (!tokenValidator.Check(raw)) {
		const detail = [...tokenValidator.Errors(raw)]
			.map((e) => `${e.path || "/"} ${e.message}`)
			.join("; ");
		return c.json(
			{
				error: "bad_request",
				error_description: detail || "Invalid request body",
			},
			400,
		);
	}

	const authedUserId = c.get("authedUserId");
	const sql = getDb();

	// Membership check: the authed user must be a member of the target org. A
	// PAT's own org binding does NOT imply membership in an ARBITRARY `org` in
	// the body — managed connectors live in a separate public org the user has
	// joined, so verify membership explicitly.
	const memberRows = (await sql`
    SELECT 1
    FROM "member"
    WHERE "userId" = ${authedUserId}
      AND "organizationId" = ${raw.org}
    LIMIT 1
  `) as unknown as Array<unknown>;
	if (memberRows.length === 0) {
		return c.json(
			{
				error: "forbidden",
				error_description: "Not a member of this organization",
			},
			403,
		);
	}

	// Owner-scoped connection lookup: a user can only fetch tokens for
	// connections they OWN (`created_by`). A connection owned by another member
	// of the same org is indistinguishable from "not found".
	const rows = (await sql`
    SELECT id, auth_profile_id, app_auth_profile_id
    FROM connections
    WHERE organization_id = ${raw.org}
      AND connector_key = ${raw.connector_key}
      AND created_by = ${authedUserId}
      AND deleted_at IS NULL
      AND status = 'active'
    LIMIT 1
  `) as unknown as Array<{
		id: number;
		auth_profile_id: number | null;
		app_auth_profile_id: number | null;
	}>;
	if (rows.length === 0) {
		return c.json(
			{
				error: "not_found",
				error_description: "No active connection found for this connector",
			},
			404,
		);
	}

	const connection = rows[0];

	const { credentials } = await resolveExecutionAuth({
		organizationId: raw.org,
		connectionId: Number(connection.id),
		authProfileId: connection.auth_profile_id,
		appAuthProfileId: connection.app_auth_profile_id,
		credentialDb: sql,
		logContext: { org: raw.org, connector_key: raw.connector_key },
		logMessage: "Failed to resolve managed connection token",
	});

	if (!credentials?.accessToken) {
		return c.json(
			{
				error: "no_token",
				error_description: "No access token available for this connection",
			},
			502,
		);
	}

	logger.info(
		{ org: raw.org, connector_key: raw.connector_key, connection_id: Number(connection.id) },
		"Resolved managed connection token",
	);

	// Return ONLY the access token + expiry. Never the refresh token or secret.
	return c.json({
		access_token: credentials.accessToken,
		expires_at: credentials.expiresAt ?? null,
	});
});

export { connectionTokenRoutes };
