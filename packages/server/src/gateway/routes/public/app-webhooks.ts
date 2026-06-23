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
 * Verification is per-PROVIDER (HMAC scheme differs). For pure raw-body HMAC
 * providers (GitHub, Jira, Linear) the `verify` is DERIVED from the connector's
 * `ConnectorWebhookSchema` (signatureHeader / algorithm / signaturePrefix) by
 * {@link createSchemaDrivenAppWebhookProvider} — those plugins supply only the
 * tenant extractor, never a hand-written verify. Slack stays a custom plugin:
 * its `v0:{ts}:{rawBody}` + timestamp-freshness scheme can't be expressed by the
 * HMAC-only schema. Hence the plugin registry.
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
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";
import type { DbClient } from "../../../db/client.js";
import {
	handleWebhookIngest,
	readBodyWithCap,
	verifyWebhookSignature,
	WEBHOOK_INGEST_MAX_BODY_BYTES,
} from "../../connections/webhook-ingest.js";
import type { SecretStore } from "../../secrets/index.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { resolveGithubWebhookActor } from "./github-webhook-actor.js";

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
 * `events.title` / `events.source_url` for the landed row. Extracted per
 * provider, not via a config JSON pointer: a comment's title lives on its parent
 * subject, so where the title/url live varies by event type.
 */
export interface AppWebhookContent {
	title?: string;
	sourceUrl?: string;
}

/**
 * Per-provider verifier + tenant extractor. New providers add a plugin without
 * touching the router. Pure-HMAC providers (GitHub, Jira, Linear) are built by
 * {@link createSchemaDrivenAppWebhookProvider}; Slack ships its own custom
 * verify (timestamped signing base, not expressible by the HMAC schema).
 */
export interface AppWebhookProvider {
	provider: string;
	/**
	 * The provider's raw-body HMAC scheme, used by the router to synthesize the
	 * ingest connection config so `handleWebhookIngest` re-verifies against the
	 * SAME header/algorithm/prefix the provider just verified — not a hardcoded
	 * GitHub scheme. `dedupeHeader` is the provider's per-delivery id header
	 * (when one exists); absent → ingest dedupes on a body hash.
	 */
	webhookScheme: {
		signatureHeader: string;
		algorithm: "sha256" | "sha1";
		signaturePrefix?: string;
		dedupeHeader?: string;
	};
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
	/** Optional title/source_url for the landed row; omitted → empty fields. */
	extractContent?(rawBody: Uint8Array, headers: Headers): AppWebhookContent;
	/**
	 * Optional: resolve the delivery's authoring actor to a tenant-scoped
	 * `person` → entity ids + identifier metadata slots for the landed row. The
	 * org is the caller's resolved install, so resolution never crosses orgs.
	 * Invoked lazily by handleWebhookIngest on the winning insert only; `sql` is
	 * that insert's transaction, so the graph writes commit atomically with it.
	 */
	resolveActor?(params: {
		organizationId: string;
		rawBody: Uint8Array;
		headers: Headers;
		sql: DbClient;
	}): Promise<{ entityIds: number[]; metadata: Record<string, string> } | null>;
}

/** Parse the raw JSON body once; returns undefined on malformed JSON. */
function parseJson(rawBody: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return undefined;
	}
}

/** Narrow an unknown JSON node to a string field, or undefined. */
function strField(node: unknown, key: string): string | undefined {
	if (node === null || typeof node !== "object") return undefined;
	const value = (node as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Project a GitHub webhook payload to a human title + source url.
 *
 * GitHub event payloads put the subject under one of a handful of top-level
 * keys, each with `title` + `html_url`:
 *   - `issues`         → `issue.{title,html_url}`
 *   - `pull_request`   → `pull_request.{title,html_url}`
 *   - `discussion`     → `discussion.{title,html_url}`
 * Comment events (`issue_comment`, `pull_request_review_comment`,
 * `discussion_comment`, `commit_comment`) carry the comment under `comment`
 * (whose `html_url` deep-links the comment) AND the parent subject alongside it
 * (`issue`/`pull_request`/`discussion`) — the title belongs to the PARENT, so
 * we read the title from the parent and prefer the comment's own `html_url`.
 * Falls back across keys so a new comment-bearing event still lands a title.
 */
export function extractGithubWebhookContent(rawBody: Uint8Array): AppWebhookContent {
	const body = parseJson(rawBody);
	if (body === null || typeof body !== "object") return {};
	const root = body as Record<string, unknown>;

	// The subject the title comes from: a comment's parent, else the subject
	// itself. Order matters only for the parent lookup — a payload has exactly
	// one of these for a given event.
	const subject =
		root.issue ?? root.pull_request ?? root.discussion ?? root.release;
	const comment = root.comment;

	const title = strField(subject, "title");
	// Prefer the comment's deep link when this is a comment event; else the
	// subject's own url.
	const sourceUrl =
		strField(comment, "html_url") ?? strField(subject, "html_url");

	const content: AppWebhookContent = {};
	if (title) content.title = title;
	if (sourceUrl) content.sourceUrl = sourceUrl;
	return content;
}

/**
 * Build an {@link AppWebhookProvider} whose `verify` is DERIVED from a
 * connector's {@link ConnectorWebhookSchema} — the single source of truth for
 * the provider's raw-body HMAC scheme. The caller supplies ONLY the
 * provider-specific tenant extractor (and optionally a content projector); the
 * verify is identical machinery across every pure-HMAC provider, so it never
 * gets hand-written again (GitHub, Jira, Linear all flow through here).
 *
 * The schema's `signatureHeader` is REQUIRED here: an app-webhook endpoint must
 * fail closed, so a provider that signs nothing has no schema-driven verify to
 * derive — it would have to ship a custom plugin (Slack). We throw at
 * construction rather than silently accepting unverifiable deliveries.
 *
 * `algorithm` defaults to `sha256` and `signaturePrefix` to none, matching
 * {@link ConnectorWebhookSchema} defaults.
 */
export function createSchemaDrivenAppWebhookProvider(options: {
	/** The `:provider` path segment + `app_installations.provider` value. */
	provider: string;
	/** The connector's declared HMAC scheme; `verify` is derived from it. */
	webhookSchema: ConnectorWebhookSchema;
	/** Pull the tenant tuple from the delivery (the only per-provider verify-free part). */
	extractTenant(rawBody: Uint8Array, headers: Headers): AppWebhookTenant | null;
	/** Optional title/source_url projector for the landed row. */
	extractContent?(rawBody: Uint8Array, headers: Headers): AppWebhookContent;
	/** Optional actor → person resolver (see {@link AppWebhookProvider.resolveActor}). */
	resolveActor?: AppWebhookProvider["resolveActor"];
}): AppWebhookProvider {
	const { provider, webhookSchema, extractTenant, extractContent, resolveActor } =
		options;
	const signatureHeader = webhookSchema.signatureHeader;
	if (!signatureHeader) {
		throw new Error(
			`Schema-driven app-webhook provider "${provider}" requires a webhook ` +
				`signatureHeader (a non-signing provider must ship a custom verify plugin).`,
		);
	}
	const algorithm = webhookSchema.algorithm ?? "sha256";
	const signaturePrefix = webhookSchema.signaturePrefix;
	return {
		provider,
		webhookScheme: {
			signatureHeader,
			algorithm,
			...(signaturePrefix ? { signaturePrefix } : {}),
			...(webhookSchema.dedupeHeader
				? { dedupeHeader: webhookSchema.dedupeHeader }
				: {}),
		},
		verify(rawBody, headers, appWebhookSecret) {
			return verifyWebhookSignature(
				rawBody,
				headers.get(signatureHeader),
				appWebhookSecret,
				algorithm,
				signaturePrefix,
			);
		},
		extractTenant,
		...(extractContent ? { extractContent } : {}),
		...(resolveActor ? { resolveActor } : {}),
	};
}

/**
 * GitHub App webhook plugin.
 *
 * Verify: schema-driven (GitHub signs the raw body and sends
 * `x-hub-signature-256: sha256=<hex>`; the scheme is the github connector's
 * {@link ConnectorWebhookSchema}). The shared HMAC verifier is constant-time
 * with a decoded-length compare — a non-hex right-length header can't slip
 * through or throw.
 *
 * Extract: the tenant is the `installation.id` in the JSON body; the Lobu App
 * is the receiving GitHub App (`GITHUB_APP_ID`), and the instance is 'cloud'
 * (GHES would be the host — out of scope here). A delivery with no
 * `installation.id` (rare app-level events) has no tenant to route to → null.
 *
 * Content: issue/PR/discussion title + html_url (a comment's title is its
 * parent's; its url is the comment deep-link) populate `events.title` +
 * `events.source_url` so the landed row is legible without digging payload_data.
 */
export function createGithubAppWebhookProvider(options: {
	/** Receiving GitHub App id, stamped as `provider_app_id`. */
	appId: string;
}): AppWebhookProvider {
	return createSchemaDrivenAppWebhookProvider({
		provider: "github",
		// GitHub raw-body HMAC: `x-hub-signature-256: sha256=<hex>` (sha256).
		// `x-github-delivery` is the per-delivery UUID used for redelivery dedupe.
		webhookSchema: {
			signatureHeader: "x-hub-signature-256",
			algorithm: "sha256",
			signaturePrefix: "sha256=",
			dedupeHeader: "x-github-delivery",
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
		extractContent(rawBody) {
			return extractGithubWebhookContent(rawBody);
		},
		// Resolve the authoring github actor → a tenant-scoped person. Lazy: the
		// router hands it the persist transaction so the graph writes are atomic
		// with the event insert (and never run for deduped/lost-race deliveries).
		async resolveActor({ organizationId, rawBody, headers, sql }) {
			return resolveGithubWebhookActor({
				organizationId,
				githubEvent: headers.get("x-github-event"),
				payload: parseJson(rawBody),
				sql,
			});
		},
	});
}

/** First non-empty `*.self` URL found by a shallow scan of the delivery body. */
function firstSelfUrl(body: unknown): string | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const root = body as Record<string, unknown>;
	const direct = strField(root, "self");
	if (direct) return direct;
	// Jira nests the entity (issue/comment/user/project) one level down; each
	// entity carries its own REST `self` URL on the same Atlassian site.
	for (const value of Object.values(root)) {
		const nested = strField(value, "self");
		if (nested) return nested;
	}
	return undefined;
}

/**
 * Jira (Cloud) app webhook plugin.
 *
 * Verify: schema-driven from the jira connector's {@link ConnectorWebhookSchema}
 * — Jira dynamic webhooks HMAC-sign the raw body with the registration secret
 * and send `x-hub-signature: sha256=<hex>`.
 *
 * Extract: the tenant is the Atlassian SITE the delivery came from. Jira webhook
 * bodies don't carry the cloudId directly, but every entity exposes a REST
 * `self` URL on its site host (e.g.
 * `https://acme.atlassian.net/rest/api/2/issue/10000`). We use the site host as
 * `external_tenant_id` (one install row per site); `provider_app_id` is the Lobu
 * OAuth/Connect app id. A delivery with no resolvable `self` URL (e.g. a test
 * ping) has no tenant → null.
 */
export function createJiraAppWebhookProvider(options: {
	/** Lobu Jira app id (`JIRA_CLIENT_ID`), stamped as `provider_app_id`. */
	appId: string;
}): AppWebhookProvider {
	return createSchemaDrivenAppWebhookProvider({
		provider: "jira",
		// Jira raw-body HMAC: `x-hub-signature: sha256=<hex>` (sha256).
		webhookSchema: {
			signatureHeader: "x-hub-signature",
			algorithm: "sha256",
			signaturePrefix: "sha256=",
		},
		extractTenant(rawBody) {
			const body = parseJson(rawBody);
			const selfUrl = firstSelfUrl(body);
			if (!selfUrl) return null;
			let host: string;
			try {
				host = new URL(selfUrl).host;
			} catch {
				return null;
			}
			if (!host) return null;
			return {
				providerInstance: "cloud",
				providerAppId: options.appId,
				externalTenantId: host,
			};
		},
	});
}

/**
 * Linear app webhook plugin.
 *
 * Verify: schema-driven from the linear connector's {@link ConnectorWebhookSchema}
 * — Linear HMAC-signs the raw body and sends a BARE hex digest in
 * `linear-signature` (no `sha256=` prefix).
 *
 * Extract: every Linear webhook delivery carries the top-level `organizationId`
 * of the workspace it belongs to — that's the tenant (one install row per Linear
 * workspace). `provider_app_id` is the Lobu Linear OAuth app id. A delivery with
 * no `organizationId` has no tenant → null.
 */
export function createLinearAppWebhookProvider(options: {
	/** Lobu Linear app id (`LINEAR_CLIENT_ID`), stamped as `provider_app_id`. */
	appId: string;
}): AppWebhookProvider {
	return createSchemaDrivenAppWebhookProvider({
		provider: "linear",
		// Linear raw-body HMAC: `linear-signature: <hex>` (sha256, no prefix).
		webhookSchema: {
			signatureHeader: "linear-signature",
			algorithm: "sha256",
		},
		extractTenant(rawBody) {
			const body = parseJson(rawBody);
			if (body === null || typeof body !== "object") return null;
			const organizationId = strField(body, "organizationId");
			if (!organizationId) return null;
			return {
				providerInstance: "cloud",
				providerAppId: options.appId,
				externalTenantId: organizationId,
			};
		},
	});
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
		//    and keyed on the install id, replaying the PROVIDER's signature scheme
		//    (from `provider.webhookScheme`, not a hardcoded GitHub one) with the
		//    app secret as a plaintext config value so handleWebhookIngest
		//    re-verifies and lands under connector_key='webhook:app_install:<id>'
		//    (matches the `webhook:%` dedupe index + size cap + rate limit). A
		//    fresh Request carries the same raw bytes + headers; the original body
		//    stream was already consumed above.
		const scheme = provider.webhookScheme;
		const synthesized: StoredConnection = {
			id: `app_install:${install.id}`,
			platform: "webhook",
			organizationId: install.organizationId,
			config: {
				platform: "webhook",
				// Replay the provider's HMAC scheme so the ingest handler's own verify
				// passes against the app secret (plaintext passes resolveSecretValue
				// through untouched). Providers without a per-delivery id header
				// (Jira/Linear) omit dedupeHeader → ingest dedupes on a body hash.
				signatureHeader: scheme.signatureHeader,
				algorithm: scheme.algorithm,
				...(scheme.signaturePrefix
					? { signaturePrefix: scheme.signaturePrefix }
					: {}),
				signatureSecret: appSecret,
				...(scheme.dedupeHeader ? { dedupeHeader: scheme.dedupeHeader } : {}),
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

		// Title/source_url for the landed row; a miss leaves them empty.
		const content = provider.extractContent?.(rawBody, c.req.raw.headers);

		// Resolution runs lazily inside handleWebhookIngest on the winning insert
		// only — resolving here would mutate the graph for deduped redeliveries.
		// `sql` is the persist transaction, threaded so the actor writes are atomic.
		const resolveActor = provider.resolveActor
			? (sql: DbClient) =>
					provider.resolveActor!({
						organizationId: install.organizationId,
						rawBody,
						headers: c.req.raw.headers,
						sql,
					})
			: undefined;

		try {
			return await handleWebhookIngest(
				synthesized,
				ingestRequest,
				deps.secretStore,
				c.var.peerRemoteAddress,
				content || resolveActor
					? {
							title: content?.title,
							sourceUrl: content?.sourceUrl,
							resolveActor,
						}
					: undefined,
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
