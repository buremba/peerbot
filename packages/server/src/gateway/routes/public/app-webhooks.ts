/**
 * Shared multi-tenant app-webhook router (PR4 of the app-installation design,
 * docs/design/app-installation.md §4.3).
 *
 * `POST /api/v1/app-webhooks/:provider` is ONE public endpoint per provider for
 * an installed Lobu App (GitHub App, Slack app, Jira Connect). Unlike the
 * per-connection ingest route (`/api/v1/webhooks/:connectionId`), the sender
 * here is a single app-level webhook configured ONCE on the provider side; the
 * delivery carries no Lobu connection id. The router therefore:
 *
 *   1. verifies the delivery with the APP-LEVEL secret (provider plugin), then
 *   2. extracts the provider tenant tuple (provider_instance, provider_app_id,
 *      external_tenant_id) from the body/headers (provider plugin), then
 *   3. resolves the active `app_installations` row for that tuple → owning org,
 *      and lands the raw delivery through the SAME event-log path as the
 *      per-connection ingest (`connector_key='webhook:<id>'`, reusing the
 *      dedupe index, size cap, and rate limit).
 *
 * Verification is per-PROVIDER (HMAC scheme differs), not schema-driven —
 * `ConnectorWebhookSchema` is HMAC-only and can't express Slack's
 * `v0:{ts}:{body}` or Jira's per-app-type rules. Hence the plugin registry.
 *
 * Delivery before the install callback: a provider may deliver before the
 * OAuth/install callback has written the `app_installations` row. That is NOT
 * an error — we ack 200 and log, so the provider doesn't retry-storm; the
 * install reconciles on the callback and subsequent deliveries land. (§4.3.4)
 *
 * Multi-replica: stateless by construction — verify is pure, tenant resolution
 * and the landing insert read/write Postgres only; nothing is memoized per pod.
 * Any replica can serve any delivery.
 */

import { Hono } from "hono";
import { createLogger } from "@lobu/core";
import type { StoredConnection } from "@lobu/core";
import {
	handleWebhookIngest,
	readBodyWithCap,
	verifyWebhookSignature,
	WEBHOOK_INGEST_MAX_BODY_BYTES,
} from "../../connections/webhook-ingest.js";
import type { SecretStore } from "../../secrets/index.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";

const logger = createLogger("app-webhook-routes");

/** The provider tenant tuple a plugin extracts to route a delivery. */
export interface AppWebhookTenant {
	/** 'cloud' | GHES host | atlassian site class. */
	providerInstance: string;
	/** Which Lobu App (GitHub App id, Slack app id, Jira app key). */
	providerAppId: string;
	/** installation_id / team_id / cloudId. */
	externalTenantId: string;
}

/**
 * Per-provider verifier + tenant extractor. New providers (Slack, Jira) add a
 * plugin without touching the router — only GitHub ships in this PR.
 */
export interface AppWebhookProvider {
	provider: string;
	/**
	 * Verify the delivery against the APP-LEVEL webhook secret. Pure over
	 * (rawBody, headers, secret) — no I/O — so it's trivially multi-replica
	 * safe. Returns false on any miss (the router fails closed with 401).
	 */
	verify(
		rawBody: Uint8Array,
		headers: Headers,
		appWebhookSecret: string,
	): boolean;
	/**
	 * Pull the provider tenant tuple from the body/headers. Returns null when
	 * the delivery carries no resolvable tenant (e.g. a ping with no
	 * installation), in which case the router acks 200 without landing.
	 */
	extractTenant(rawBody: Uint8Array, headers: Headers): AppWebhookTenant | null;
}

/** Parse the raw JSON body once; returns undefined on malformed JSON. */
function parseJson(rawBody: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return undefined;
	}
}

/**
 * GitHub App webhook plugin.
 *
 * Verify: GitHub signs the raw request body with the App's webhook secret and
 * sends `x-hub-signature-256: sha256=<hex>`. We reuse the connection-ingest
 * HMAC verifier (constant-time, decoded-length compare — a non-hex right-length
 * header can't slip through or throw).
 *
 * Extract: the tenant is the `installation.id` in the JSON body; the Lobu App
 * is the receiving GitHub App (`GITHUB_APP_ID`), and the instance is 'cloud'
 * (GHES would be the host — out of scope here). A delivery with no
 * `installation.id` (rare app-level events) has no tenant to route to → null.
 */
export function createGithubAppWebhookProvider(options: {
	/** Receiving GitHub App id, stamped as `provider_app_id`. */
	appId: string;
}): AppWebhookProvider {
	return {
		provider: "github",
		verify(rawBody, headers, appWebhookSecret) {
			return verifyWebhookSignature(
				rawBody,
				headers.get("x-hub-signature-256"),
				appWebhookSecret,
				"sha256",
				"sha256=",
			);
		},
		extractTenant(rawBody) {
			const body = parseJson(rawBody);
			if (body === null || typeof body !== "object") return null;
			const installation = (body as Record<string, unknown>).installation;
			if (installation === null || typeof installation !== "object") return null;
			const id = (installation as Record<string, unknown>).id;
			// GitHub installation ids are integers; accept the numeric/string forms.
			if (typeof id !== "number" && typeof id !== "string") return null;
			const externalTenantId = String(id);
			if (!externalTenantId) return null;
			return {
				providerInstance: "cloud",
				providerAppId: options.appId,
				externalTenantId,
			};
		},
	};
}

/** Dependencies the router needs, injected at registration (testable). */
export interface AppWebhookRouterDeps {
	installationStore: AppInstallationStore;
	secretStore: SecretStore;
	/** Provider plugins keyed by `provider` (the `:provider` path param). */
	providers: AppWebhookProvider[];
	/**
	 * Resolve the APP-LEVEL webhook secret for a provider. Returns undefined
	 * when no secret is configured — the router then fails closed (401), never
	 * accepting an unverifiable delivery.
	 */
	resolveAppWebhookSecret(provider: string): Promise<string | undefined>;
}

/**
 * Default app-webhook secret resolver: env var first
 * (`GITHUB_APP_WEBHOOK_SECRET` etc.), then a conventional secret-store ref
 * (`secret://app-webhook/<provider>`) so prod can seal it like any other
 * credential. Plaintext env wins for local/dev parity with the rest of the
 * gateway (`.env` is the single source of truth).
 */
export function createDefaultAppWebhookSecretResolver(
	secretStore: SecretStore,
): (provider: string) => Promise<string | undefined> {
	return async (provider) => {
		const envName = `${provider.toUpperCase()}_APP_WEBHOOK_SECRET`;
		const fromEnv = process.env[envName];
		if (fromEnv) return fromEnv;
		return (await secretStore.get(`secret://app-webhook/${provider}`)) ?? undefined;
	};
}

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Build the public app-webhook router.
 *
 * Registered like the other public routes (`app.route("", ...)`), so it shares
 * the global `peerRemoteAddress` middleware var used for per-source rate
 * limiting in the landing path.
 */
export function createAppWebhookRoutes(deps: AppWebhookRouterDeps): Hono {
	const router = new Hono();
	const providers = new Map(deps.providers.map((p) => [p.provider, p]));

	router.post("/api/v1/app-webhooks/:provider", async (c) => {
		const providerName = c.req.param("provider");
		const provider = providers.get(providerName);
		if (!provider) {
			// Unknown provider: no plugin to verify with. 404, not 500.
			return json(404, { error: "Unknown webhook provider" });
		}

		// Read the raw body under the same cap as connection ingest. We need the
		// bytes BEFORE we can HMAC-verify (the signature is over the raw body) and
		// before we can extract the tenant, so this is a single capped read.
		const rawBody = await readBodyWithCap(c.req.raw, WEBHOOK_INGEST_MAX_BODY_BYTES);
		if (rawBody === null) {
			return json(413, { error: "Payload too large" });
		}

		// 1. Verify with the app-level secret. Fail closed when the secret is
		//    missing — an app-webhook endpoint must never accept unverifiable
		//    deliveries just because its secret went unconfigured.
		const appSecret = await deps.resolveAppWebhookSecret(providerName);
		if (!appSecret) {
			logger.warn(
				{ provider: providerName },
				"[app-webhook] no app webhook secret configured — rejecting delivery",
			);
			return json(401, { error: "Unauthorized" });
		}
		if (!provider.verify(rawBody, c.req.raw.headers, appSecret)) {
			return json(401, { error: "Unauthorized" });
		}

		// 2. Extract the provider tenant tuple. A delivery with no resolvable
		//    tenant (e.g. an app-level ping) is acked without landing.
		const tenant = provider.extractTenant(rawBody, c.req.raw.headers);
		if (!tenant) {
			logger.info(
				{ provider: providerName },
				"[app-webhook] delivery carries no tenant — acked without landing",
			);
			return json(200, { ok: true, landed: false });
		}

		// 3. Resolve the active installation for the tuple → owning org. A miss
		//    means the delivery arrived before the install callback wrote the row
		//    (§4.3.4): ack 200 + log, never 500 — the provider must not retry-storm,
		//    and the install reconciles on its callback.
		const install = await deps.installationStore.resolveActiveByTenant({
			provider: providerName,
			providerInstance: tenant.providerInstance,
			providerAppId: tenant.providerAppId,
			externalTenantId: tenant.externalTenantId,
		});
		if (!install) {
			logger.info(
				{
					provider: providerName,
					providerInstance: tenant.providerInstance,
					providerAppId: tenant.providerAppId,
					externalTenantId: tenant.externalTenantId,
				},
				"[app-webhook] no active installation for tenant — acked, awaiting install callback",
			);
			return json(200, { ok: true, landed: false });
		}

		// 4. Land the RAW delivery through the same event-log path as connection
		//    ingest. We synthesize a StoredConnection scoped to the install's org
		//    and keyed on the install id, replaying the GitHub signature scheme
		//    with the app secret as a plaintext config value so handleWebhookIngest
		//    re-verifies and lands under connector_key='webhook:app_install:<id>'
		//    (matches the `webhook:%` dedupe index + size cap + rate limit). A
		//    fresh Request carries the same raw bytes + headers; the original body
		//    stream was already consumed above.
		const synthesized: StoredConnection = {
			id: `app_install:${install.id}`,
			platform: "webhook",
			organizationId: install.organizationId,
			config: {
				platform: "webhook",
				// Replay the GitHub HMAC scheme so the ingest handler's own verify
				// passes against the app secret (plaintext passes resolveSecretValue
				// through untouched).
				signatureHeader: "x-hub-signature-256",
				algorithm: "sha256",
				signaturePrefix: "sha256=",
				signatureSecret: appSecret,
				// GitHub stamps a per-delivery UUID; dedupe redeliveries on it.
				dedupeHeader: "x-github-delivery",
				semanticType: "content",
			},
			settings: {},
			metadata: {},
			status: "active",
			createdAt: install.createdAt,
			updatedAt: install.updatedAt,
		};

		const ingestRequest = new Request(c.req.raw.url, {
			method: "POST",
			headers: c.req.raw.headers,
			body: rawBody,
		});

		try {
			return await handleWebhookIngest(
				synthesized,
				ingestRequest,
				deps.secretStore,
				c.var.peerRemoteAddress,
			);
		} catch (error) {
			logger.error(
				{ provider: providerName, installationId: install.id, error: String(error) },
				"[app-webhook] failed to land delivery",
			);
			return json(500, { error: "Failed to land delivery" });
		}
	});

	return router;
}
