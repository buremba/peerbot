/**
 * OAuth Broker Routes (SPIKE)
 *
 * Nango-style managed OAuth, Lobu-native. A LOCAL Lobu instance whose
 * `oauth_app` profile is a broker-ref (see `getBrokerRef`) does not hold the
 * provider's client_id/secret. Instead it delegates the secret-requiring OAuth
 * steps to a REMOTE Lobu instance — the "broker" — over these HTTP endpoints.
 *
 * Auth handshake: the local instance calls with `Authorization: Bearer
 * <owl_pat_*>`. The broker verifies the PAT (resolving the authenticated org +
 * tenant membership via the shared `authenticatePat`, exactly as the embedded
 * Agent API does) and uses THAT org's managed `oauth_app` profile to read the
 * real client_id/secret. The broker performs the build/exchange/refresh and
 * returns ONLY the user's tokens — the client_secret never leaves the broker.
 *
 * Endpoints (all POST, all PAT-gated):
 *   - /broker/oauth/authorize-url → buildAuthorizationUrl with broker's client_id
 *   - /broker/oauth/exchange      → exchangeCodeForTokens with broker's secret
 *   - /broker/oauth/refresh       → CredentialService.refreshTokenGeneric
 *
 * The OAuth endpoints + credential key names are resolved SERVER-SIDE from the
 * broker org's own connector metadata (`resolveConnectorOAuthMethod`). The
 * caller never supplies them — that is the security premise (otherwise a caller
 * with any valid PAT could redirect the broker's client_secret to an attacker).
 */

import type { Env } from "@lobu/connector-sdk";
import { type Static, type TObject, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { type Context, Hono } from "hono";
import { CredentialService } from "../auth/credentials";
import { authenticatePat, extractPatBearer } from "../auth/pat-auth";
import { getDb } from "../db/client";
import type { ConnectorAuthOAuthMethod } from "../utils/connector-auth";
import logger from "../utils/logger";
import {
	buildAuthorizationUrl,
	exchangeCodeForTokens,
} from "./oauth-providers";
import {
	resolveConnectorOAuthMethod,
	resolveOAuthClientCredentials,
} from "./oauth-resolution";

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

/**
 * Parse + validate a JSON request body against a typebox schema. Returns the
 * typed value, or sends a 400 with the validation errors. The endpoints supply
 * the schema, so malformed/missing fields are rejected (not cast).
 */
async function parseBody<S extends TObject>(
	c: Context<BrokerEnv>,
	validator: ReturnType<typeof TypeCompiler.Compile<S>>,
): Promise<Static<S> | { _error: Response }> {
	const raw = await c.req.json().catch(() => null);
	if (!validator.Check(raw)) {
		const detail = [...validator.Errors(raw)]
			.map((e) => `${e.path || "/"} ${e.message}`)
			.join("; ");
		return {
			_error: c.json(
				{
					error: "bad_request",
					error_description: detail || "Invalid request body",
				},
				400,
			),
		};
	}
	return raw as Static<S>;
}

function isBodyError<T>(
	parsed: T | { _error: Response },
): parsed is { _error: Response } {
	return typeof parsed === "object" && parsed !== null && "_error" in parsed;
}

/**
 * Resolve the broker org's OAuth method + managed client credentials in one
 * step. Returns an error Response when the connector/provider is unmanaged or
 * no managed app exists, so each endpoint can early-return uniformly.
 */
async function resolveBrokerConfig(
	c: Context<BrokerEnv>,
	body: { connector_key: string; provider: string },
): Promise<
	| {
			method: ConnectorAuthOAuthMethod;
			clientId: string;
			clientSecret: string | null;
	  }
	| { _error: Response }
> {
	const organizationId = c.get("brokerOrgId");
	const method = await resolveConnectorOAuthMethod({
		organizationId,
		connectorKey: body.connector_key,
		provider: body.provider,
	});
	if (!method) {
		return {
			_error: c.json(
				{
					error: "unknown_connector",
					error_description: `Broker org does not manage connector '${body.connector_key}' / provider '${body.provider}'`,
				},
				400,
			),
		};
	}

	const { clientId, clientSecret } = await resolveOAuthClientCredentials({
		organizationId,
		connectorKey: body.connector_key,
		provider: body.provider,
		clientIdKey: method.clientIdKey,
		clientSecretKey: method.clientSecretKey,
	});
	if (!clientId) {
		return {
			_error: c.json(
				{
					error: "no_managed_app",
					error_description: `No managed oauth_app for ${body.provider}`,
				},
				400,
			),
		};
	}

	return { method, clientId, clientSecret };
}

const AuthorizeUrlBody = Type.Object({
	connector_key: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
	redirect_uri: Type.String({ minLength: 1 }),
	state: Type.String({ minLength: 1 }),
	scopes: Type.Optional(Type.Array(Type.String())),
	code_challenge: Type.Optional(Type.String()),
});
const authorizeUrlValidator = TypeCompiler.Compile(AuthorizeUrlBody);

/**
 * POST /broker/oauth/authorize-url
 * Build the provider authorization URL using the broker org's managed client_id
 * and SERVER-RESOLVED authorization endpoint (never caller-supplied).
 */
brokerRoutes.post("/oauth/authorize-url", async (c) => {
	const body = await parseBody(c, authorizeUrlValidator);
	if (isBodyError(body)) return body._error;

	const resolved = await resolveBrokerConfig(c, body);
	if (isBodyError(resolved)) return resolved._error;

	const authorizationUrl = buildAuthorizationUrl({
		provider: body.provider,
		clientId: resolved.clientId,
		redirectUri: body.redirect_uri,
		scopes: body.scopes ?? [],
		state: body.state,
		authorizationUrl: resolved.method.authorizationUrl,
		authParams: resolved.method.authParams,
		codeChallenge: body.code_challenge,
	});
	if (!authorizationUrl) {
		return c.json(
			{ error: "unsupported_provider", error_description: body.provider },
			400,
		);
	}

	return c.json({ authorization_url: authorizationUrl });
});

const ExchangeBody = Type.Object({
	connector_key: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
	code: Type.String({ minLength: 1 }),
	redirect_uri: Type.String({ minLength: 1 }),
	code_verifier: Type.Optional(Type.String()),
});
const exchangeValidator = TypeCompiler.Compile(ExchangeBody);

/**
 * POST /broker/oauth/exchange
 * Exchange an authorization code for tokens using the broker org's managed
 * client_id/secret and SERVER-RESOLVED token endpoint (never caller-supplied —
 * otherwise a caller could redirect the client_secret to an attacker). Returns
 * ONLY the user's tokens — never the client_secret.
 */
brokerRoutes.post("/oauth/exchange", async (c) => {
	const body = await parseBody(c, exchangeValidator);
	if (isBodyError(body)) return body._error;

	const resolved = await resolveBrokerConfig(c, body);
	if (isBodyError(resolved)) return resolved._error;

	const tokens = await exchangeCodeForTokens({
		provider: body.provider,
		code: body.code,
		clientId: resolved.clientId,
		clientSecret: resolved.clientSecret,
		redirectUri: body.redirect_uri,
		tokenUrl: resolved.method.tokenUrl,
		tokenEndpointAuthMethod: resolved.method.tokenEndpointAuthMethod,
		codeVerifier: body.code_verifier,
	});
	if (!tokens) {
		return c.json(
			{ error: "exchange_failed", error_description: "Token exchange failed" },
			502,
		);
	}

	return c.json({
		access_token: tokens.accessToken,
		refresh_token: tokens.refreshToken,
		expires_in: tokens.expiresIn,
		scope: tokens.scope,
		token_type: tokens.tokenType,
	});
});

const RefreshBody = Type.Object({
	connector_key: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
	refresh_token: Type.String({ minLength: 1 }),
});
const refreshValidator = TypeCompiler.Compile(RefreshBody);

/**
 * POST /broker/oauth/refresh
 * Refresh an access token using the broker org's managed client_id/secret and
 * SERVER-RESOLVED token endpoint (never caller-supplied).
 */
brokerRoutes.post("/oauth/refresh", async (c) => {
	const body = await parseBody(c, refreshValidator);
	if (isBodyError(body)) return body._error;

	const resolved = await resolveBrokerConfig(c, body);
	if (isBodyError(resolved)) return resolved._error;

	if (!resolved.method.tokenUrl) {
		return c.json(
			{
				error: "unknown_connector",
				error_description: `Broker org does not manage connector '${body.connector_key}' / provider '${body.provider}' (no token endpoint)`,
			},
			400,
		);
	}

	const refreshed = await new CredentialService(getDb()).refreshTokenGeneric({
		tokenUrl: resolved.method.tokenUrl,
		clientId: resolved.clientId,
		clientSecret: resolved.clientSecret ?? undefined,
		refreshToken: body.refresh_token,
		authMethod: resolved.method.tokenEndpointAuthMethod,
	});
	if (!refreshed) {
		return c.json(
			{ error: "refresh_failed", error_description: "Token refresh failed" },
			502,
		);
	}

	logger.info(
		{ provider: body.provider, organizationId: c.get("brokerOrgId") },
		"Broker refreshed token",
	);
	return c.json({
		access_token: refreshed.accessToken,
		refresh_token: refreshed.refreshToken ?? null,
		expires_in: Math.max(
			0,
			Math.round((refreshed.expiresAt.getTime() - Date.now()) / 1000),
		),
	});
});

export { brokerRoutes };
