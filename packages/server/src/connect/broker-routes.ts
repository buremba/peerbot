/**
 * OAuth Broker Route (SPIKE) — grant-on-broker model.
 *
 * Nango-style managed OAuth, Lobu-native. The grant lives on the BROKER: the
 * broker runs consent through its OWN existing `/connect/...` flow against its
 * managed `oauth_app` (client_id/secret), and stores the resulting grant
 * (`oauth_account` → `account` row) — the local instance never sees the client
 * secret or the refresh token. At RUNTIME the local instance asks the broker
 * for a fresh access token for a specific broker-side connection.
 *
 * Auth handshake: the local instance calls with `Authorization: Bearer
 * <owl_pat_*>`. The broker verifies the PAT (resolving the authenticated org +
 * tenant membership via the shared `authenticatePat`, exactly as the embedded
 * Agent API does) and scopes the lookup to THAT org — a PAT for org A cannot
 * fetch org B's tokens.
 *
 * Endpoint (PAT-gated):
 *   - POST /broker/oauth/token → fresh access token for a broker connection,
 *     refreshed server-side with the broker's secret via the EXISTING
 *     CredentialService. Returns ONLY `{ access_token, expires_at }` — never the
 *     refresh token or client secret.
 */

import type { Env } from "@lobu/connector-sdk";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Hono } from "hono";
import { authenticatePat, extractPatBearer } from "../auth/pat-auth";
import { getDb } from "../db/client";
import { resolveExecutionAuth } from "../utils/execution-context";
import logger from "../utils/logger";

type BrokerEnv = {
	Bindings: Env;
	Variables: { brokerOrgId: string };
};

const brokerRoutes = new Hono<BrokerEnv>();

/**
 * PAT auth for broker calls — the single shared `authenticatePat` gate. No /
 * invalid / null-org / cross-tenant PAT short-circuits 401/403; on success the
 * resolved org is stashed on the context.
 */
brokerRoutes.use("/oauth/*", async (c, next) => {
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

	c.set("brokerOrgId", result.organizationId);
	return next();
});

const TokenBody = Type.Object({
	connection_id: Type.Integer({ minimum: 1 }),
});
const tokenValidator = TypeCompiler.Compile(TokenBody);

/**
 * POST /broker/oauth/token
 * Return a fresh access token for a broker-side connection.
 *
 * The broker owns the grant: it resolves the connection's `oauth_account`
 * (token store) + managed `oauth_app` (client_id/secret) and runs the EXISTING
 * `resolveExecutionAuth` path, which refreshes via the broker's secret when the
 * token is expiring. The body carries ONLY the broker connection id; endpoints,
 * secrets and the refresh token are resolved/held server-side and never leave
 * the broker. The connection MUST belong to the PAT's org (else 403) so a PAT
 * for org A cannot fetch org B's tokens.
 */
brokerRoutes.post("/oauth/token", async (c) => {
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

	const organizationId = c.get("brokerOrgId");
	const sql = getDb();

	// Scope check: the connection MUST belong to the PAT's org. A connection in
	// another org (or a non-existent one) is indistinguishable from "not found"
	// to the caller — return 403 either way so org membership can't be probed.
	const rows = await sql`
    SELECT id, auth_profile_id, app_auth_profile_id
    FROM connections
    WHERE id = ${raw.connection_id}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
	if (rows.length === 0) {
		return c.json(
			{
				error: "forbidden",
				error_description: "Connection not found in this organization",
			},
			403,
		);
	}

	const connection = rows[0] as {
		id: number;
		auth_profile_id: number | null;
		app_auth_profile_id: number | null;
	};

	const { credentials } = await resolveExecutionAuth({
		organizationId,
		connectionId: Number(connection.id),
		authProfileId: connection.auth_profile_id,
		appAuthProfileId: connection.app_auth_profile_id,
		credentialDb: sql,
		logContext: { broker_org_id: organizationId },
		logMessage: "Broker failed to resolve connection token",
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
		{ organizationId, connection_id: Number(connection.id) },
		"Broker resolved connection token",
	);

	// Return ONLY the access token + expiry. Never the refresh token or secret.
	return c.json({
		access_token: credentials.accessToken,
		expires_at: credentials.expiresAt ?? null,
	});
});

export { brokerRoutes };
