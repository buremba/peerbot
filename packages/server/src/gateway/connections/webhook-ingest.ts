/**
 * Inbound webhook ingest for `platform: "webhook"` connections (#1235).
 *
 * A webhook connection is NOT a chat platform: there is no Chat SDK adapter,
 * no mention/DM handlers, no thread semantics. It is a push-source primitive —
 * any external system (Sentry, GitHub, Stripe, healthchecks) POSTs JSON to
 * `POST /api/v1/webhooks/:connectionId` and the payload is persisted as an
 * `events` row (`connector_key = 'webhook:<connectionId>'`). Watchers consume
 * those rows through their existing checkpointed SQL sources; reaction latency
 * is bounded by the watcher cadence, not by this handler.
 *
 * Request pipeline (persist BEFORE ack — a 202 issued before the insert
 * commits would lose the delivery on pod crash, and providers won't retry a
 * 2xx):
 *   1. body size cap (256 KB)                          → 413
 *   2. pre-auth rate limit per (connection, source IP) → 429
 *   3. token auth (constant-time)                      → 401
 *   4. authenticated per-connection budget (120/min)   → 429
 *   5. dedupe key: configured header value, else sha256(raw body)
 *   6. synchronous event insert                        → 202 {"ok":true,"id":<eventId>}
 *
 * Idempotency: `events.connection_id` is a bigint FK to connector
 * `connections` (NOT `agent_connections`) and `events.origin_id` is only
 * indexed, not unique — so redelivery dedupe rides the partial unique index
 * `events_webhook_ingest_dedupe` on `(organization_id, connector_key,
 * origin_id) WHERE connector_key LIKE 'webhook:%'` (see
 * db/migrations/20260612210000_webhook_ingest_dedupe.sql): pre-check first,
 * and treat a 23505 from a concurrent duplicate as success.
 *
 * Multi-replica: stateless by construction — every step reads the connection
 * row and writes Postgres; nothing is memoized per pod.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { StoredConnection } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { insertEvent } from "../../utils/insert-event.js";
import logger from "../../utils/logger.js";
import { getClientIP, getRateLimiter } from "../../utils/rate-limiter.js";
import { resolveSecretValue, type SecretStore } from "../secrets/index.js";
import type { WebhookIngestPlatformConfig } from "./types.js";

/** Raw-body cap. Oversized deliveries are rejected, so stored payloads stay bounded. */
export const WEBHOOK_INGEST_MAX_BODY_BYTES = 256 * 1024;

/**
 * Authenticated per-connection delivery budget (cluster-wide, fail-open like
 * every limiter use). Counted only AFTER token verification — otherwise an
 * attacker spamming bad tokens at a guessable connection id (apply-created
 * ids are deterministic) could exhaust the budget and 429 real deliveries.
 */
export const WEBHOOK_INGEST_RATE_LIMIT = {
	limit: 120,
	windowSeconds: 60,
	errorMessage:
		"Webhook rate limit exceeded. Maximum 120 deliveries per minute.",
};

/**
 * Pre-auth attempt budget per (connection, source IP). Bounds secret-store
 * reads and brute-force attempts without letting unauthenticated traffic
 * starve the authenticated budget above: a flooding source only exhausts its
 * own bucket. Roomier than the delivery budget so a legitimate sender behind
 * one egress IP (Sentry, GitHub) never trips it before the authenticated
 * limit applies.
 */
export const WEBHOOK_INGEST_PREAUTH_RATE_LIMIT = {
	limit: 240,
	windowSeconds: 60,
	errorMessage:
		"Too many webhook requests from this source. Try again shortly.",
};

/** Header-based alternative to `Authorization: Bearer` for senders that reserve it. */
const TOKEN_HEADER = "x-lobu-webhook-token";

type WebhookIngestConfig = WebhookIngestPlatformConfig;

/**
 * Auto-generate a strong bearer token when the caller didn't supply one, so
 * an ingest endpoint is never created unauthenticated — same posture as the
 * Telegram `secretToken` auto-generation. The field name matches
 * `isSecretField`, so persistence turns it into a `secret://` ref like any
 * other credential.
 */
export function prepareWebhookIngestConfig(
	config: Record<string, unknown>,
): void {
	if (typeof config.token !== "string" || config.token.length === 0) {
		config.token = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
	}
}

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Constant-time equality over fixed-length digests (inputs vary in length). */
function tokensMatch(presented: string, configured: string): boolean {
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(configured).digest();
	return timingSafeEqual(a, b);
}

/**
 * Verify a provider's HMAC signature over the raw request body — the auth
 * scheme for connector-owned webhooks (GitHub `x-hub-signature-256`, Linear
 * `linear-signature`, Jira `x-hub-signature`). The provider signs the exact
 * bytes it sent, so we HMAC `rawBody` (never the re-serialized JSON) with the
 * shared secret and constant-time compare against the header digest. Returns
 * false on any miss (no header, malformed hex) — the caller fails closed.
 */
function verifyWebhookSignature(
	rawBody: Uint8Array,
	headerValue: string | null,
	secret: string,
	algorithm: "sha256" | "sha1",
	prefix: string | undefined,
): boolean {
	if (!headerValue) return false;
	const presented = prefix && headerValue.startsWith(prefix)
		? headerValue.slice(prefix.length)
		: headerValue;
	const expected = createHmac(algorithm, secret).update(rawBody).digest();
	// Buffer.from(hex) silently TRUNCATES on invalid hex, so a right-length but
	// non-hex header would slip past a hex-string length check and then make
	// timingSafeEqual throw. Compare the DECODED byte lengths instead — a
	// malformed signature decodes short → length mismatch → false (clean 401).
	const presentedBuf = Buffer.from(presented, "hex");
	if (presentedBuf.length !== expected.length) return false;
	return timingSafeEqual(presentedBuf, expected);
}

function isQueryTokenAllowed(config: WebhookIngestConfig): boolean {
	return config.allowQueryAuth === true || config.allowQueryAuth === "true";
}

/**
 * Whether to project the payload into `payload_text` so the row is embedded
 * and recallable via `search_memory`. Off by default — store-only rows stay
 * cheap and keep high-volume webhook noise out of semantic memory; watchers
 * read them via SQL regardless. Accepts the string spelling because
 * declarative (`lobu apply`) configs carry string values only.
 */
function isSearchableEnabled(config: WebhookIngestConfig): boolean {
	return config.searchable === true || config.searchable === "true";
}

/**
 * Extract the presented token: `Authorization: Bearer`, the dedicated header,
 * or — only when the connection opted in — the `?token=` query param.
 */
function extractPresentedToken(
	request: Request,
	config: WebhookIngestConfig,
): string | undefined {
	const authorization = request.headers.get("authorization");
	if (authorization) {
		const match = authorization.match(/^Bearer\s+(.+)$/i);
		if (match) return match[1];
	}
	const headerToken = request.headers.get(TOKEN_HEADER);
	if (headerToken) return headerToken;
	if (isQueryTokenAllowed(config)) {
		const queryToken = new URL(request.url).searchParams.get("token");
		if (queryToken) return queryToken;
	}
	return undefined;
}

/**
 * Read the request body, bailing as soon as the cap is exceeded — a
 * Content-Length lie (or chunked encoding) must not buffer an unbounded
 * body into memory. Returns null when over the cap.
 */
async function readBodyWithCap(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** RFC 6901 JSON-pointer lookup; returns undefined on any miss. */
function resolveJsonPointer(root: unknown, pointer: string): unknown {
	if (!pointer.startsWith("/")) return undefined;
	let current: unknown = root;
	for (const rawSegment of pointer.slice(1).split("/")) {
		const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(current)) {
			if (!/^(0|[1-9]\d*)$/.test(segment)) {
				return undefined;
			}
			const index = Number.parseInt(segment, 10);
			if (index >= current.length) {
				return undefined;
			}
			current = current[index];
		} else if (current !== null && typeof current === "object") {
			if (!Object.hasOwn(current as object, segment)) return undefined;
			current = (current as Record<string, unknown>)[segment];
		} else {
			return undefined;
		}
	}
	return current;
}

/** Cap on the rendered `payload_text` so a large delivery can't bloat the
 * search index / embedding input. The raw payload is always preserved in
 * full in `payload_data` — this is only the searchable text projection. */
export const WEBHOOK_PAYLOAD_TEXT_MAX_CHARS = 8 * 1024;

/**
 * Render the parsed payload into a flat text document for `events.payload_text`.
 * Without this the column is null, so the embed-backfill (which skips rows with
 * empty payload_text) never embeds the row and it stays invisible to semantic
 * recall / `search_memory` — reachable only by watcher SQL. Leaf scalars become
 * `dotted.path: value` lines, so the JSON structure doubles as searchable
 * context (e.g. `event.title: ZeroDivisionError`). Bounded by
 * WEBHOOK_PAYLOAD_TEXT_MAX_CHARS.
 */
export function renderPayloadText(payload: unknown): string {
	const lines: string[] = [];
	let budget = WEBHOOK_PAYLOAD_TEXT_MAX_CHARS;
	const push = (text: string): void => {
		if (budget <= 0) return;
		const clipped = text.length > budget ? text.slice(0, budget) : text;
		lines.push(clipped);
		budget -= clipped.length + 1; // + newline
	};
	const walk = (node: unknown, path: string): void => {
		if (budget <= 0) return;
		if (
			node === null ||
			typeof node === "string" ||
			typeof node === "number" ||
			typeof node === "boolean"
		) {
			push(path ? `${path}: ${String(node)}` : String(node));
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
			return;
		}
		if (typeof node === "object") {
			for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
				walk(value, path ? `${path}.${key}` : key);
			}
		}
	};
	walk(payload, "");
	return lines.join("\n");
}

function extractTitle(
	payload: unknown,
	titlePath: string | undefined,
): string | undefined {
	if (!titlePath) return undefined;
	const value = resolveJsonPointer(payload, titlePath);
	if (typeof value === "string" && value.length > 0) return value.slice(0, 500);
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function isUniqueViolation(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "23505";
}

async function findExistingDeliveryId(
	organizationId: string,
	connectorKey: string,
	originId: string,
): Promise<number | undefined> {
	const rows = await getDb()`
    SELECT id FROM events
    WHERE organization_id = ${organizationId}
      AND connector_key = ${connectorKey}
      AND origin_id = ${originId}
    LIMIT 1
  `;
	return (rows[0] as { id: number } | undefined)?.id;
}

/**
 * Handle one inbound delivery for a `platform: "webhook"` connection.
 *
 * The caller passes the RAW stored row (config still holding `secret://`
 * refs) — never a sanitized connection, whose redacted token could not
 * authenticate anything. Tokens are never logged; this handler logs only
 * connection ids and outcome codes.
 */
export async function handleWebhookIngest(
	stored: StoredConnection,
	request: Request,
	secretStore: SecretStore,
	peerAddress?: string | null,
): Promise<Response> {
	const organizationId = stored.organizationId;
	if (!organizationId) {
		// Pre-Phase-C rows only; the storage layer requires org scoping today.
		logger.error(
			{ connectionId: stored.id },
			"[webhook-ingest] connection has no organization_id — refusing delivery",
		);
		return json(500, { error: "Connection is not org-scoped" });
	}
	const config = stored.config as WebhookIngestConfig;

	// 1. Size cap. Trust Content-Length only to reject early; the capped body
	//    read below enforces the limit for chunked/lying senders.
	const declaredLength = Number(request.headers.get("content-length") ?? "0");
	if (declaredLength > WEBHOOK_INGEST_MAX_BODY_BYTES) {
		return json(413, { error: "Payload too large" });
	}

	// 2. Pre-auth rate limit, keyed by (connection, source IP) so a flood of
	//    bad-token requests can't exhaust the authenticated delivery budget
	//    below (cluster-wide counters, fail-open on DB trouble — matching
	//    every other limiter call site).
	const preauthRate = getRateLimiter().checkLimit(
		`webhook-ingest-preauth:${stored.id}:${getClientIP(request, peerAddress)}`,
		WEBHOOK_INGEST_PREAUTH_RATE_LIMIT,
	);
	if (!preauthRate.allowed) {
		return new Response(JSON.stringify({ error: preauthRate.errorMessage }), {
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(preauthRate.resetInSeconds),
			},
		});
	}

	// 3. Auth. A delivery authenticates by EITHER a matching bearer token OR a
	//    verified provider HMAC signature (connector webhooks: GitHub/Linear/Jira
	//    sign, they don't send a bearer). Fail closed when neither method is
	//    configured — an ingest endpoint must never be open just because its
	//    secret went missing.
	// Resolve both candidate secrets concurrently — either (or both) may gate
	// this delivery, so we need them before deciding auth.
	const [configuredToken, signatureSecret] = await Promise.all([
		resolveSecretValue(
			secretStore,
			typeof config.token === "string" ? config.token : undefined,
		),
		resolveSecretValue(
			secretStore,
			typeof config.signatureSecret === "string" ? config.signatureSecret : undefined,
		),
	]);
	if (!configuredToken && !signatureSecret) {
		logger.warn(
			{ connectionId: stored.id },
			"[webhook-ingest] no resolvable token or signature secret — rejecting delivery",
		);
		return json(401, { error: "Unauthorized" });
	}
	// Token check is decisive pre-body when no signature is configured (preserves
	// the fast-reject path for plain ingest connections). When a signature IS
	// configured, a token miss isn't fatal yet — the signature is verified after
	// the body is read below (HMAC needs the raw bytes).
	const presentedToken = extractPresentedToken(request, config);
	let authenticated =
		!!configuredToken &&
		!!presentedToken &&
		tokensMatch(presentedToken, configuredToken);
	if (!authenticated && !signatureSecret) {
		return json(401, { error: "Unauthorized" });
	}

	// 4. Authenticated per-connection delivery budget — only verified senders
	//    spend it.
	const rate = getRateLimiter().checkLimit(
		`webhook-ingest:${stored.id}`,
		WEBHOOK_INGEST_RATE_LIMIT,
	);
	if (!rate.allowed) {
		return new Response(JSON.stringify({ error: rate.errorMessage }), {
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(rate.resetInSeconds),
			},
		});
	}

	const rawBody = await readBodyWithCap(request, WEBHOOK_INGEST_MAX_BODY_BYTES);
	if (rawBody === null) {
		return json(413, { error: "Payload too large" });
	}

	// Complete auth: when the token didn't already authenticate and a signature
	// secret is configured, the provider's HMAC over the raw body must verify.
	if (!authenticated && signatureSecret) {
		const ok =
			typeof config.signatureHeader === "string" &&
			!!config.signatureHeader &&
			verifyWebhookSignature(
				rawBody,
				request.headers.get(config.signatureHeader),
				signatureSecret,
				config.algorithm === "sha1" ? "sha1" : "sha256",
				typeof config.signaturePrefix === "string"
					? config.signaturePrefix
					: undefined,
			);
		if (!ok) {
			return json(401, { error: "Unauthorized" });
		}
		authenticated = true;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return json(400, { error: "Request body must be valid JSON" });
	}

	// 5. Dedupe key: provider delivery id header when configured and present,
	//    else a content hash. Either way redeliveries map to the same origin_id.
	let originId: string | undefined;
	let dedupeSource: "header" | "body-hash" = "body-hash";
	if (typeof config.dedupeHeader === "string" && config.dedupeHeader) {
		const headerValue = request.headers.get(config.dedupeHeader);
		if (headerValue) {
			// Sender-controlled value feeding a btree index — keep entries bounded.
			// Real delivery ids (UUIDs etc.) pass through verbatim; anything
			// oversized collapses to its hash, which dedupes identically.
			originId =
				headerValue.length <= 256
					? headerValue
					: createHash("sha256").update(headerValue).digest("hex");
			dedupeSource = "header";
		}
	}
	if (!originId) {
		originId = createHash("sha256").update(rawBody).digest("hex");
	}

	const connectorKey = `webhook:${stored.id}`;
	const payloadData =
		parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: { payload: parsed };
	const semanticType =
		typeof config.semanticType === "string" && config.semanticType
			? config.semanticType
			: "content";

	// 6. Persist, then ack. A duplicate (pre-checked or raced) is still a 202 —
	//    the provider delivered successfully; we just already had it.
	const existingId = await findExistingDeliveryId(
		organizationId,
		connectorKey,
		originId,
	);
	if (existingId !== undefined) {
		return json(202, { ok: true, id: existingId, duplicate: true });
	}

	try {
		const inserted = await insertEvent({
			entityIds: [],
			organizationId,
			originId,
			connectorKey,
			semanticType,
			payloadType: "json_template",
			payloadData,
			// Opt-in searchable text projection: only when `searchable` is set
			// do we render payload_text, which is the gate the embed-backfill
			// keys on (it skips empty payload_text). Default off keeps the row
			// store-only (watcher SQL) and out of semantic memory. The full
			// payload always stays in payload_data; this is lossy-by-cap.
			content: isSearchableEnabled(config) ? renderPayloadText(parsed) : null,
			title: extractTitle(parsed, config.titlePath),
			occurredAt: new Date(),
			metadata: {
				webhook_connection_id: stored.id,
				dedupe_source: dedupeSource,
			},
		});
		logger.info(
			{ connectionId: stored.id, eventId: inserted.id, dedupeSource },
			"[webhook-ingest] delivery persisted",
		);
		return json(202, { ok: true, id: inserted.id });
	} catch (error) {
		if (isUniqueViolation(error)) {
			const racedId = await findExistingDeliveryId(
				organizationId,
				connectorKey,
				originId,
			);
			if (racedId !== undefined) {
				return json(202, { ok: true, id: racedId, duplicate: true });
			}
		}
		logger.error(
			{ connectionId: stored.id, error: String(error) },
			"[webhook-ingest] failed to persist delivery",
		);
		// Non-2xx so the provider retries; nothing was acked.
		return json(500, { error: "Failed to persist delivery" });
	}
}
