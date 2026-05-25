/**
 * Shared OAuth resolution helpers for the Connect flow and the OAuth broker.
 *
 * Two pieces of resolution both surfaces need:
 *   1. The provider's OAuth method (endpoints + auth method + credential key
 *      names) for a connector — resolved SERVER-SIDE from the org's own
 *      `connector_definitions` row, never from a request body.
 *   2. The org's managed `oauth_app` client_id/secret for that provider.
 *
 * The broker reuses these against ITS own org (so the caller can never
 * influence the endpoints or leak the secret); the local Connect flow uses
 * them against the local org. One implementation each, no parallel queries.
 */

import { getDb } from "../db/client";
import {
	getAuthProfileById,
	getPrimaryAuthProfileForKind,
	normalizeAuthValues,
} from "../utils/auth-profiles";
import {
	type ConnectorAuthOAuthMethod,
	getOAuthAuthMethods,
	normalizeConnectorAuthSchema,
} from "../utils/connector-auth";

/**
 * Resolve the OAuth method (endpoints, auth method, credential key names) for a
 * connector + provider from the org's `connector_definitions`. Prefers the
 * org's own row over a global (null-org) one. Returns `null` when the connector
 * or a matching oauth method isn't found — the caller refuses to act on a
 * connector/provider the org doesn't manage. Endpoints come from HERE, never
 * from a request body.
 */
export async function resolveConnectorOAuthMethod(params: {
	organizationId: string;
	connectorKey: string;
	provider: string;
}): Promise<ConnectorAuthOAuthMethod | null> {
	const sql = getDb();
	const rows = await sql`
    SELECT auth_schema
    FROM connector_definitions
    WHERE key = ${params.connectorKey}
      AND status = 'active'
      AND (organization_id = ${params.organizationId} OR organization_id IS NULL)
    ORDER BY CASE WHEN organization_id = ${params.organizationId} THEN 0 ELSE 1 END
    LIMIT 1
  `;
	if (rows.length === 0) return null;

	const authSchema = normalizeConnectorAuthSchema(
		(rows[0] as { auth_schema: unknown }).auth_schema,
	);
	return (
		getOAuthAuthMethods(authSchema).find(
			(m) => m.provider.toLowerCase() === params.provider.toLowerCase(),
		) ?? null
	);
}

/**
 * Resolve OAuth client_id/secret from the org's managed `oauth_app` profile.
 *
 * Resolution order:
 *   1. A specific selected app profile (by id), when provided.
 *   2. The org's primary managed `oauth_app` for the connector/provider.
 *
 * The credential KEY NAMES come from the (server-resolved) connector config
 * when known, with the provider-uppercase default as a fallback.
 */
export async function resolveOAuthClientCredentials(params: {
	organizationId: string;
	connectorKey: string;
	provider: string;
	appAuthProfileId?: number | null;
	clientIdKey?: string;
	clientSecretKey?: string;
}): Promise<{ clientId: string | null; clientSecret: string | null }> {
	const providerUpper = params.provider.toUpperCase();
	const clientIdKey = params.clientIdKey || `${providerUpper}_CLIENT_ID`;
	const clientSecretKey =
		params.clientSecretKey || `${providerUpper}_CLIENT_SECRET`;

	const appProfile =
		(params.appAuthProfileId
			? await getAuthProfileById(params.organizationId, params.appAuthProfileId)
			: null) ??
		(await getPrimaryAuthProfileForKind({
			organizationId: params.organizationId,
			connectorKey: params.connectorKey,
			profileKind: "oauth_app",
			provider: params.provider,
		}));

	const authValues = normalizeAuthValues(appProfile?.auth_data ?? {});
	return {
		clientId: authValues[clientIdKey] ?? null,
		clientSecret: authValues[clientSecretKey] ?? null,
	};
}
