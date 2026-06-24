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
import { type DbClient, getDb } from "../../../db/client.js";
import {
	handleWebhookIngest,
	readBodyWithCap,
	verifyWebhookSignature,
	WEBHOOK_INGEST_MAX_BODY_BYTES,
} from "../../connections/webhook-ingest.js";
import type { SecretStore } from "../../secrets/index.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { insertEvent } from "../../../utils/insert-event.js";
import { extractGithubActor, resolveGithubWebhookActor } from "./github-webhook-actor.js";

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
	/**
	 * Optional: handle the delivery itself instead of storing a raw event. For
	 * connectors with a sync mapping (github) the canonical record is the poll, so
	 * the provider decides per event type (see the github plugin):
	 *  - TRIGGER (most events) — mark the affected feed due (`next_run_at = now()`)
	 *    and let the poll fetch the complete record (dedupes/supersedes by stable
	 *    origin_id). No identity resolution here — the poll resolves it once.
	 *  - STORE (event-complete signals, e.g. stars) — resolve the actor and insert
	 *    the structured event directly, keyed on the same origin_id the poll uses.
	 * No raw blob is stored either way. Providers that define this NEVER fall
	 * through to the raw ingest path; providers without it keep raw store
	 * (jira/linear). `triggered` reports whether a feed was marked due OR an event
	 * stored (telemetry only — the router acks 200 either way; an unconfigured
	 * repo/feed is a no-op, not an error).
	 */
	onDelivery?(params: {
		rawBody: Uint8Array;
		headers: Headers;
		install: { id: number | string; organizationId: string };
		sql: DbClient;
	}): Promise<{ triggered: boolean }>;
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
	/** Optional trigger handler (see {@link AppWebhookProvider.onDelivery}). */
	onDelivery?: AppWebhookProvider["onDelivery"];
}): AppWebhookProvider {
	const { provider, webhookSchema, extractTenant, extractContent, resolveActor, onDelivery } =
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
		...(onDelivery ? { onDelivery } : {}),
	};
}

/** Webhook routing for one feed: which feed a delivery updates, and how. */
interface WebhookRoute {
	feedKey: string;
	mode: "trigger" | "store";
}

/**
 * Build the github event → feed routing from the org's connector definition
 * feeds_schema, where each feed declares `webhook: { events, mode }`. Read from
 * the DB — the same persisted surface the poll path reads its entity-link rules
 * from — so the server hardcodes NO provider event types or feed names. A
 * per-delivery query (webhooks are low-frequency); an org with no active github
 * definition yields an empty map → deliveries ack as no-ops.
 *
 * Routing strategies (declared by the connector per feed):
 *  - TRIGGER — the poll brings strictly more than the webhook (an `issues`
 *    payload omits computed counts; a `push` lacks the immutable github user id
 *    `/commits` returns), so the delivery marks THAT feed due and the poll
 *    fetches the complete record.
 *  - STORE — the payload is event-complete (a `star` carries actor + starred_at)
 *    and re-polling the whole list is waste, so the event is stored directly.
 */
async function loadGithubWebhookRoutes(
	organizationId: string,
): Promise<Map<string, WebhookRoute>> {
	const rows = await getDb()`
		SELECT feeds_schema FROM connector_definitions
		WHERE key = 'github' AND organization_id = ${organizationId} AND status = 'active'
		ORDER BY updated_at DESC
		LIMIT 1
	`;
	const routes = new Map<string, WebhookRoute>();
	const feedsSchema = rows[0]?.feeds_schema as
		| Record<string, { webhook?: { events?: unknown; mode?: unknown } }>
		| null
		| undefined;
	if (!feedsSchema) return routes;
	for (const [feedKey, feed] of Object.entries(feedsSchema)) {
		const events = feed?.webhook?.events;
		if (!Array.isArray(events)) continue;
		const mode = feed.webhook?.mode === "store" ? "store" : "trigger";
		for (const event of events) {
			if (typeof event === "string" && event) routes.set(event, { feedKey, mode });
		}
	}
	return routes;
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
 * Delivery: routing comes from {@link loadGithubWebhookRoutes} (the connector's
 * feeds_schema), not a hardcoded map. Most events TRIGGER the affected feed's
 * poll; event-complete signals (stars) are STORED directly, consolidating with
 * the poll on origin_id.
 */
export function createGithubAppWebhookProvider(options: {
	/** Receiving GitHub App id, stamped as `provider_app_id`. */
	appId: string;
	/**
	 * Land event-complete deliveries (stars) directly instead of re-polling.
	 * Default true. Set false to make every delivery a trigger (the scheduled
	 * poll then captures stars on its next backstop run).
	 */
	storeWebhookEvents?: boolean;
}): AppWebhookProvider {
	const storeWebhookEvents = options.storeWebhookEvents ?? true;
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
		async onDelivery({ rawBody, headers, install, sql }) {
			const event = headers.get("x-github-event");
			if (!event) return { triggered: false };
			// Routing is declared by the connector (feeds_schema), read from the DB.
			const route = (await loadGithubWebhookRoutes(install.organizationId)).get(
				event,
			);
			if (!route) return { triggered: false };
			const payload = parseJson(rawBody);
			const repo = extractGithubRepo(payload);
			if (!repo) return { triggered: false };

			// STORE (event-complete signals, e.g. stars): land the structured event
			// directly, consolidating with the poll on origin_id — no wasteful
			// re-poll. Resolution happens here because the poll won't run for this
			// feed on the webhook's account. Gated by storeWebhookEvents; when off,
			// fall through to a trigger so the scheduled poll picks it up.
			if (route.mode === "store" && storeWebhookEvents) {
				const stored = await storeGithubWebhookEvent({
					sql,
					install,
					repo,
					event,
					feedKey: route.feedKey,
					payload,
				});
				return { triggered: stored };
			}

			// TRIGGER: the poll brings more, so mark THAT feed due and let the poll
			// fetch the complete record (dedupes/supersedes by origin_id) and resolve
			// the person once — no webhook-side resolution (avoids double work).
			const triggered = await markGithubFeedDue({
				sql,
				install,
				repo,
				feedKey: route.feedKey,
			});
			return { triggered };
		},
	});
}

/** Extract the {owner, name} of the repo a GitHub delivery is about, or null. */
function extractGithubRepo(
	body: unknown,
): { owner: string; name: string } | null {
	if (body === null || typeof body !== "object") return null;
	const repository = (body as Record<string, unknown>).repository;
	if (repository === null || typeof repository !== "object") return null;
	const repo = repository as Record<string, unknown>;
	const name = typeof repo.name === "string" ? repo.name : undefined;
	const owner = strField(repo.owner, "login");
	if (owner && name) return { owner, name };
	// Fall back to full_name ("owner/name") when the split fields are absent.
	const fullName = typeof repo.full_name === "string" ? repo.full_name : undefined;
	if (fullName?.includes("/")) {
		const [o, n] = fullName.split("/", 2);
		if (o && n) return { owner: o, name: n };
	}
	return null;
}

/**
 * Mark the active github feed for (install, repo, feedKey) due NOW so the
 * orchestrator syncs it on its next tick — the webhook becomes the "when to run"
 * signal, with the schedule as the self-covering backstop. Scoped to the one
 * feed the event belongs to, so unrelated feeds aren't re-polled. Idempotent:
 * redeliveries just re-stamp `next_run_at`. Returns whether the feed matched
 * (telemetry only — an unconfigured repo/feed is a no-op, not an error).
 */
async function markGithubFeedDue(params: {
	sql: DbClient;
	install: { id: number | string; organizationId: string };
	repo: { owner: string; name: string };
	feedKey: string;
}): Promise<boolean> {
	const { sql, install, repo, feedKey } = params;
	const rows = await sql`
		UPDATE feeds f
		SET next_run_at = now(), updated_at = now()
		FROM connections c
		WHERE f.connection_id = c.id
		  AND c.organization_id = ${install.organizationId}
		  AND c.connector_key = 'github'
		  AND c.status = 'active'
		  AND c.deleted_at IS NULL
		  AND (c.config->>'installation_ref') = ${String(install.id)}
		  AND f.feed_key = ${feedKey}
		  AND lower(f.config->>'repo_owner') = lower(${repo.owner})
		  AND lower(f.config->>'repo_name') = lower(${repo.name})
		  AND f.status = 'active'
		  AND f.deleted_at IS NULL
		RETURNING f.id
	`;
	return rows.length > 0;
}

/**
 * The active github feed matching (install, repo, feedKey) and its connection.
 * The store path is gated on this exactly like the trigger path
 * ({@link markGithubFeedDue}) — a repo with no such feed configured is a no-op,
 * not an unconfigured event. The connection id is the feed's own, so the stored
 * event shares the poll's (connection_id, origin_id) and consolidates.
 */
async function resolveGithubFeedTarget(params: {
	sql: DbClient;
	install: { id: number | string; organizationId: string };
	repo: { owner: string; name: string };
	feedKey: string;
}): Promise<{
	connectionId: number;
	feedId: number;
	owner: string;
	name: string;
} | null> {
	const { sql, install, repo, feedKey } = params;
	// GitHub owner/repo are case-insensitive; match accordingly and return the
	// feed config's canonical casing so the store builds the SAME origin_id the
	// poll does (the connector keys origin_id off the feed config, not the
	// webhook payload's display casing) — otherwise consolidation would break.
	const [row] = await sql`
		SELECT f.id AS feed_id, f.connection_id,
		       f.config->>'repo_owner' AS repo_owner, f.config->>'repo_name' AS repo_name
		FROM feeds f
		JOIN connections c ON c.id = f.connection_id
		WHERE c.organization_id = ${install.organizationId}
		  AND c.connector_key = 'github'
		  AND c.status = 'active'
		  AND c.deleted_at IS NULL
		  AND (c.config->>'installation_ref') = ${String(install.id)}
		  AND f.feed_key = ${feedKey}
		  AND lower(f.config->>'repo_owner') = lower(${repo.owner})
		  AND lower(f.config->>'repo_name') = lower(${repo.name})
		  AND f.status = 'active'
		  AND f.deleted_at IS NULL
		LIMIT 1
	`;
	return row
		? {
				connectionId: Number(row.connection_id),
				feedId: Number(row.feed_id),
				owner: String(row.repo_owner),
				name: String(row.repo_name),
			}
		: null;
}

/**
 * Land an event-complete github delivery (star/watch) as a structured event
 * instead of re-polling. The origin_id mirrors the github connector's stargazer
 * scheme (`stargazer_<owner>_<repo>_<github_user_id:ID | github_login:login>`,
 * non-alnum → `_`) and the event is stored under the install's github
 * connection, so the scheduled `/stargazers` poll supersedes/dedupes it on the
 * SAME (connection_id, origin_id). The actor is resolved to a person here (the
 * poll won't run on the webhook's account). Unstars are transient — not tracked
 * (the user opted out of delete signals). Returns false (no-op) when no active
 * matching feed is configured for the repo or the delivery isn't a new star.
 */
async function storeGithubWebhookEvent(params: {
	sql: DbClient;
	install: { id: number | string; organizationId: string };
	repo: { owner: string; name: string };
	event: string;
	feedKey: string;
	payload: unknown;
}): Promise<boolean> {
	const { sql, install, repo, event, feedKey, payload } = params;
	const root =
		payload && typeof payload === "object"
			? (payload as Record<string, unknown>)
			: null;
	if (!root) return false;
	// `star` → action created/deleted; `watch` → action started. Only a NEW star
	// is landed; unstars/transient states are intentionally ignored.
	const action = strField(root, "action");
	if (event === "star" && action !== "created") return false;
	if (event === "watch" && action !== "started") return false;

	const actor = extractGithubActor(payload);
	if (!actor) return false;
	// Gate on the configured feed (same as the trigger path) so an unconfigured
	// repo never lands a stray event; use the feed's own connection + id, and its
	// canonical owner/name casing so origin_id matches the poll's exactly.
	const target = await resolveGithubFeedTarget({ sql, install, repo, feedKey });
	if (!target) return false;
	const { owner, name } = target;

	// origin_id mirrors the connector: key on the immutable user id when present.
	const key = actor.author_id
		? `github_user_id:${actor.author_id}`
		: `github_login:${actor.author_login.toLowerCase()}`;
	const originId = `stargazer_${owner}_${name}_${key.replace(/[^a-z0-9]+/gi, "_")}`;
	const starredAt = strField(root, "starred_at") ?? new Date().toISOString();
	const profileUrl =
		strField(root.sender, "html_url") ??
		`https://github.com/${actor.author_login}`;

	// Resolve the actor → person so the star is attributed exactly like the poll.
	// Best-effort by design: a failure leaves the event unattributed (the poll
	// backstop re-resolves on its next run), but we log it so it isn't invisible.
	const resolution = await resolveGithubWebhookActor({
		organizationId: install.organizationId,
		githubEvent: event,
		payload,
		sql,
	}).catch((error) => {
		logger.warn(
			{ event, originId, error: String(error) },
			"[app-webhook] github star actor resolution failed; storing unattributed",
		);
		return null;
	});

	await insertEvent(
		{
			organizationId: install.organizationId,
			connectorKey: "github",
			connectionId: target.connectionId,
			feedKey,
			feedId: target.feedId,
			originId,
			originType: "stargazer",
			semanticType: "content",
			title: `${actor.author_login} starred ${owner}/${name}`,
			authorName: actor.author_login,
			sourceUrl: profileUrl,
			occurredAt: starredAt,
			score: 1,
			entityIds: resolution?.entityIds ?? [],
			metadata: {
				action: "starred",
				starred_at: starredAt,
				source: "github_star_webhook",
				author_login: actor.author_login,
				...(actor.author_id ? { author_id: actor.author_id } : {}),
				...(resolution?.metadata ?? {}),
			},
		},
		{ onConflictUpdate: true },
	);
	return true;
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

		// 4. Trigger-handling providers (github) treat the delivery as a "sync now"
		//    signal rather than a record: resolve identity + mark the affected
		//    repo's feeds due, no raw event. The canonical record is the poll, so
		//    push and backfill stay one consolidated dataset. Providers without
		//    onDelivery fall through to the raw store below (jira/linear).
		if (provider.onDelivery) {
			try {
				const { triggered } = await provider.onDelivery({
					rawBody,
					headers: c.req.raw.headers,
					install,
					sql: getDb(),
				});
				return json(200, { ok: true, triggered });
			} catch (error) {
				logger.error(
					{ provider: providerName, installationId: install.id, error: String(error) },
					"[app-webhook] onDelivery trigger failed",
				);
				return json(500, { error: "Failed to handle delivery" });
			}
		}

		// 5. Land the RAW delivery through the same event-log path as connection
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
