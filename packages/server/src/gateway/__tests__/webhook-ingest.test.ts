/**
 * Inbound webhook ingest (#1235) — the push-source primitive.
 *
 * Three layers under test against a real Postgres:
 *
 *  1. `handleWebhookIngest` request pipeline: token auth (bearer / dedicated
 *     header / opt-in query param, constant-time, fail-closed), the 256 KB
 *     body cap, JSON validation, payload wrapping, title extraction, dedupe
 *     (configured header vs body hash), and persist-before-ack semantics.
 *  2. The `events_webhook_ingest_dedupe` partial unique index: concurrent
 *     duplicates collapse to one row at the database layer, independent of
 *     the handler's pre-check.
 *  3. `ChatInstanceManager` wiring: `platform: "webhook"` is adapterless
 *     (no instance started), auto-generates a bearer token at create,
 *     persists it as a `secret://` ref, and `handleIngestWebhook` round-trips
 *     a delivery through the real org-scoped secret store.
 */

import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	ensureDbForGatewayTests,
	ensureEncryptionKey,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "org-webhook";
const AGENT = "agent-webhook";
const TOKEN = "whk-test-token-0123456789abcdef";
const SIG_SECRET = "whk-sig-secret-0123456789abcdef";

/** Compute a provider HMAC signature header value over the exact raw bytes. */
function sign(
	rawBody: string,
	{
		secret = SIG_SECRET,
		algorithm = "sha256",
		prefix = "",
	}: { secret?: string; algorithm?: "sha256" | "sha1"; prefix?: string } = {},
): string {
	return prefix + createHmac(algorithm, secret).update(rawBody).digest("hex");
}

/** GitHub-style signature config: prefixed sha256 in x-hub-signature-256. */
const githubSigConfig = {
	signatureHeader: "x-hub-signature-256",
	algorithm: "sha256",
	signaturePrefix: "sha256=",
	signatureSecret: SIG_SECRET,
};

beforeAll(async () => {
	await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
	await resetTestDatabase();
	ensureEncryptionKey();
	const { resetRateLimiterForTests } = await import(
		"../../utils/rate-limiter.js"
	);
	resetRateLimiterForTests();
}, 30_000);

/** Plaintext-only fake; the manager-level test exercises the real store. */
const fakeSecretStore = {
	get: async () => null,
};

function storedRow(
	overrides: Partial<Record<string, unknown>> = {},
	config: Record<string, unknown> = {},
) {
	return {
		id: "whk1",
		platform: "webhook",
		agentId: AGENT,
		organizationId: ORG,
		config: { platform: "webhook", token: TOKEN, ...config },
		settings: { allowGroups: true },
		metadata: {},
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as any;
}

function delivery(
	body: unknown,
	init: { headers?: Record<string, string>; query?: string; raw?: string } = {},
) {
	return new Request(
		`http://gateway.test/api/v1/webhooks/whk1${init.query ?? ""}`,
		{
			method: "POST",
			body: init.raw ?? JSON.stringify(body),
			headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		},
	);
}

const bearer = { authorization: `Bearer ${TOKEN}` };

async function ingest(
	row: ReturnType<typeof storedRow>,
	request: Request,
	peerAddress?: string | null,
): Promise<Response> {
	const { handleWebhookIngest } = await import(
		"../connections/webhook-ingest.js"
	);
	return handleWebhookIngest(row, request, fakeSecretStore, peerAddress);
}

async function eventRows(connectionId = "whk1"): Promise<any[]> {
	const { getDb } = await import("../../db/client.js");
	return getDb()`
    SELECT * FROM events
    WHERE connector_key = ${`webhook:${connectionId}`}
    ORDER BY id
  `;
}

describe("handleWebhookIngest auth", () => {
	test("accepts Authorization: Bearer and persists the event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery({ hello: "world" }, { headers: bearer }),
		);
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(typeof body.id).toBe("number");

		const rows = await eventRows();
		expect(rows.length).toBe(1);
		expect(rows[0].payload_data).toEqual({ hello: "world" });
		expect(rows[0].payload_type).toBe("json_template");
		expect(rows[0].semantic_type).toBe("content");
		expect(rows[0].entity_ids).toBeNull();
		expect(rows[0].metadata.webhook_connection_id).toBe("whk1");
		expect(rows[0].metadata.dedupe_source).toBe("body-hash");
	});

	test("accepts the x-lobu-webhook-token header", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery({ a: 1 }, { headers: { "x-lobu-webhook-token": TOKEN } }),
		);
		expect(res.status).toBe(202);
	});

	test("rejects a wrong token and persists nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery({ a: 1 }, { headers: { authorization: "Bearer nope" } }),
		);
		expect(res.status).toBe(401);
		expect((await eventRows()).length).toBe(0);
	});

	test("rejects a missing token", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(storedRow(), delivery({ a: 1 }));
		expect(res.status).toBe(401);
	});

	test("fails closed when the connection has no resolvable token", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const row = storedRow();
		delete row.config.token;
		const res = await ingest(row, delivery({ a: 1 }, { headers: bearer }));
		expect(res.status).toBe(401);
	});

	test("query token is rejected unless allowQueryAuth is enabled", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const denied = await ingest(
			storedRow(),
			delivery({ a: 1 }, { query: `?token=${TOKEN}` }),
		);
		expect(denied.status).toBe(401);

		const allowed = await ingest(
			storedRow({}, { allowQueryAuth: true }),
			delivery({ a: 1 }, { query: `?token=${TOKEN}` }),
		);
		expect(allowed.status).toBe(202);

		// `lobu apply` configs carry strings — the string spelling counts too.
		const allowedString = await ingest(
			storedRow({ id: "whk2" }, { allowQueryAuth: "true" }),
			delivery({ b: 2 }, { query: `?token=${TOKEN}` }),
		);
		expect(allowedString.status).toBe(202);
	});

	test("refuses an org-less row", async () => {
		const res = await ingest(
			storedRow({ organizationId: undefined }),
			delivery({ a: 1 }, { headers: bearer }),
		);
		expect(res.status).toBe(500);
	});
});

describe("handleWebhookIngest signature auth (connector webhooks)", () => {
	/** A signature-only connection — GitHub/Linear/Jira sign, no bearer token. */
	function sigRow(
		config: Record<string, unknown>,
		overrides: Partial<Record<string, unknown>> = {},
	) {
		const row = storedRow(overrides, config);
		delete row.config.token; // provider authenticates by signature, not bearer
		return row;
	}

	test("GitHub-style: a valid x-hub-signature-256 lands the raw event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({
			action: "opened",
			issue: { number: 7, title: "Bug" },
		});
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw,
				headers: {
					"x-github-event": "issues",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(202);
		const rows = await eventRows();
		expect(rows.length).toBe(1);
		// EL: the raw payload lands verbatim — no transform on ingest.
		expect(rows[0].payload_data).toEqual({
			action: "opened",
			issue: { number: 7, title: "Bug" },
		});
	});

	test("Linear-style: a valid prefix-less linear-signature lands the event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({ type: "Issue", action: "create" });
		const res = await ingest(
			sigRow({
				signatureHeader: "linear-signature",
				algorithm: "sha256",
				signatureSecret: SIG_SECRET,
			}),
			delivery(null, { raw, headers: { "linear-signature": sign(raw) } }),
		);
		expect(res.status).toBe(202);
		expect((await eventRows()).length).toBe(1);
	});

	test("rejects an invalid signature and persists nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({ issue: 1 });
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw,
				headers: { "x-hub-signature-256": "sha256=deadbeef" },
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows()).length).toBe(0);
	});

	test("rejects a tampered body (signature over different bytes)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const signedOver = JSON.stringify({ issue: 1 });
		const tampered = JSON.stringify({ issue: 999 });
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw: tampered,
				headers: { "x-hub-signature-256": sign(signedOver, { prefix: "sha256=" }) },
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows()).length).toBe(0);
	});

	test("rejects a missing signature header", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery({ issue: 1 }),
		);
		expect(res.status).toBe(401);
	});

	test("rejects a wrong secret", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({ issue: 1 });
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw,
				headers: {
					"x-hub-signature-256": sign(raw, {
						secret: "the-wrong-secret",
						prefix: "sha256=",
					}),
				},
			}),
		);
		expect(res.status).toBe(401);
	});

	test("rejects a right-length non-hex signature with a clean 401 (no throw)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({ issue: 1 });
		// 64 chars = sha256 hex length, but non-hex → Buffer.from(hex) truncates;
		// must still be a clean 401, not a 500 from timingSafeEqual length mismatch.
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw,
				headers: { "x-hub-signature-256": `sha256=${"z".repeat(64)}` },
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows()).length).toBe(0);
	});

	test("token still authenticates when both token and signature are configured", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		// Connection carries a bearer token AND signature config; a valid bearer
		// with no signature header must still pass (token short-circuits pre-body).
		const res = await ingest(
			storedRow({}, githubSigConfig),
			delivery({ a: 1 }, { headers: bearer }),
		);
		expect(res.status).toBe(202);
		expect((await eventRows()).length).toBe(1);
	});

	test("redelivery dedupes on x-github-delivery under signature auth", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const config = { ...githubSigConfig, dedupeHeader: "x-github-delivery" };
		const raw1 = JSON.stringify({ run: 1 });
		const first = await ingest(
			sigRow(config),
			delivery(null, {
				raw: raw1,
				headers: {
					"x-github-delivery": "gh-d-1",
					"x-hub-signature-256": sign(raw1, { prefix: "sha256=" }),
				},
			}),
		);
		const raw2 = JSON.stringify({ run: 2 });
		const dup = await ingest(
			sigRow(config),
			delivery(null, {
				raw: raw2,
				headers: {
					"x-github-delivery": "gh-d-1",
					"x-hub-signature-256": sign(raw2, { prefix: "sha256=" }),
				},
			}),
		);
		expect(first.status).toBe(202);
		expect((await dup.json()).duplicate).toBe(true);
		const rows = await eventRows();
		expect(rows.length).toBe(1);
		expect(rows[0].origin_id).toBe("gh-d-1");
	});
});

describe("handleWebhookIngest body handling", () => {
	test("413 on a body over the cap (Content-Length honest)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const huge = JSON.stringify({ pad: "x".repeat(300 * 1024) });
		const res = await ingest(
			storedRow(),
			delivery(null, { raw: huge, headers: bearer }),
		);
		expect(res.status).toBe(413);
		expect((await eventRows()).length).toBe(0);
	});

	test("413 when Content-Length lies (capped streaming read)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const huge = JSON.stringify({ pad: "y".repeat(300 * 1024) });
		// Hand-built stream so the runtime can't compute an honest length.
		const request = new Request("http://gateway.test/api/v1/webhooks/whk1", {
			method: "POST",
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(huge));
					controller.close();
				},
			}),
			headers: { ...bearer, "content-length": "10" },
			// @ts-expect-error duplex is required for streaming bodies in Node
			duplex: "half",
		});
		const res = await ingest(storedRow(), request);
		expect(res.status).toBe(413);
	});

	test("400 on a non-JSON body", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery(null, { raw: "not json {", headers: bearer }),
		);
		expect(res.status).toBe(400);
	});

	test("wraps array and primitive roots so payload_data stays an object", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery([1, 2, 3], { headers: bearer }),
		);
		expect(res.status).toBe(202);
		const rows = await eventRows();
		expect(rows[0].payload_data).toEqual({ payload: [1, 2, 3] });
	});

	test("wraps primitive roots so payload_data stays an object", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(storedRow(), delivery(42, { headers: bearer }));
		expect(res.status).toBe(202);
		const rows = await eventRows();
		expect(rows[0].payload_data).toEqual({ payload: 42 });
	});

	test("extracts title via titlePath and stamps configured semanticType", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow({}, { titlePath: "/event/title", semanticType: "alert" }),
			delivery(
				{ event: { title: "ZeroDivisionError in worker" } },
				{ headers: bearer },
			),
		);
		expect(res.status).toBe(202);
		const rows = await eventRows();
		expect(rows[0].title).toBe("ZeroDivisionError in worker");
		expect(rows[0].semantic_type).toBe("alert");
	});

	test("ignores non-canonical array indexes in titlePath", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const invalidEmpty = await ingest(
			storedRow({}, { titlePath: "/items/" }),
			delivery({ items: ["first"] }, { headers: bearer }),
		);
		const invalidLeadingZero = await ingest(
			storedRow({}, { titlePath: "/items/01" }),
			delivery({ items: ["first", "second"] }, { headers: bearer }),
		);

		expect(invalidEmpty.status).toBe(202);
		expect(invalidLeadingZero.status).toBe(202);
		const rows = await eventRows();
		expect(rows.map((row) => row.title)).toEqual([null, null]);
	});

	test("a missing titlePath target leaves the title null", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await ingest(
			storedRow({}, { titlePath: "/nope/missing" }),
			delivery({ event: {} }, { headers: bearer }),
		);
		const rows = await eventRows();
		expect(rows[0].title).toBeNull();
	});

	test("searchable:true renders payload_text so the row is embeddable", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await ingest(
			storedRow({}, { semanticType: "alert", searchable: true }),
			delivery(
				{ event: { title: "ZeroDivisionError", level: "error" } },
				{ headers: bearer },
			),
		);
		const rows = await eventRows();
		// Non-empty payload_text is the gate the embed-backfill keys on; the
		// flattened "path: value" projection carries searchable tokens.
		expect(rows[0].payload_text).toContain("event.title: ZeroDivisionError");
		expect(rows[0].payload_text).toContain("event.level: error");
	});

	test("default (searchable off) leaves payload_text null — store-only", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await ingest(
			storedRow({}, { semanticType: "alert" }),
			delivery({ event: { title: "ZeroDivisionError" } }, { headers: bearer }),
		);
		const rows = await eventRows();
		// No payload_text → embed-backfill skips it → never enters semantic
		// memory; the row is still reachable by watcher SQL on connector_key.
		expect(rows[0].payload_text).toBeNull();
	});
});

describe("handleWebhookIngest idempotency", () => {
	test("redelivery of an identical body is a no-op returning the original id", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const first = await ingest(
			storedRow(),
			delivery({ issue: 42 }, { headers: bearer }),
		);
		const second = await ingest(
			storedRow(),
			delivery({ issue: 42 }, { headers: bearer }),
		);
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		const a = await first.json();
		const b = await second.json();
		expect(b.id).toBe(a.id);
		expect(b.duplicate).toBe(true);
		expect((await eventRows()).length).toBe(1);
	});

	test("dedupeHeader takes precedence over the body hash", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const row = storedRow({}, { dedupeHeader: "x-github-delivery" });
		await ingest(
			row,
			delivery(
				{ run: 1 },
				{ headers: { ...bearer, "x-github-delivery": "d-1" } },
			),
		);
		// Different body, same delivery id → duplicate.
		const dup = await ingest(
			row,
			delivery(
				{ run: 2 },
				{ headers: { ...bearer, "x-github-delivery": "d-1" } },
			),
		);
		expect((await dup.json()).duplicate).toBe(true);

		const rows = await eventRows();
		expect(rows.length).toBe(1);
		expect(rows[0].origin_id).toBe("d-1");
		expect(rows[0].metadata.dedupe_source).toBe("header");
	});

	test("a configured-but-absent dedupe header falls back to the body hash", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await ingest(
			storedRow({}, { dedupeHeader: "x-github-delivery" }),
			delivery({ run: 1 }, { headers: bearer }),
		);
		const rows = await eventRows();
		expect(rows[0].metadata.dedupe_source).toBe("body-hash");
	});

	test("concurrent identical deliveries collapse to one row, both acked", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const responses = await Promise.all(
			Array.from({ length: 5 }, () =>
				ingest(storedRow(), delivery({ burst: true }, { headers: bearer })),
			),
		);
		for (const res of responses) {
			expect(res.status).toBe(202);
		}
		expect((await eventRows()).length).toBe(1);
	});

	test("the partial unique index rejects duplicates at the database layer", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { insertEvent } = await import("../../utils/insert-event.js");
		const params = {
			entityIds: [],
			organizationId: ORG,
			originId: "same-origin",
			connectorKey: "webhook:whk1",
			semanticType: "content",
			payloadType: "json_template" as const,
			payloadData: { n: 1 },
		};
		await insertEvent(params);
		let code: string | undefined;
		try {
			await insertEvent({ ...params, payloadData: { n: 2 } });
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe("23505");

		// Non-webhook connector keys stay outside the partial index.
		await insertEvent({
			...params,
			connectorKey: "github",
			payloadData: { n: 3 },
		});
		await insertEvent({
			...params,
			connectorKey: "github",
			payloadData: { n: 4 },
		});
	});
});

describe("handleWebhookIngest rate limiting", () => {
	test("429 once the authenticated per-connection budget is exhausted", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { WEBHOOK_INGEST_RATE_LIMIT } = await import(
			"../connections/webhook-ingest.js"
		);
		let limited: Response | undefined;
		for (let i = 0; i <= WEBHOOK_INGEST_RATE_LIMIT.limit; i++) {
			const res = await ingest(
				storedRow(),
				delivery({ i }, { headers: bearer }),
			);
			if (res.status === 429) {
				limited = res;
				break;
			}
		}
		expect(limited).toBeDefined();
		expect(limited!.headers.get("retry-after")).toBeTruthy();
	});

	test("unauthenticated floods cannot starve the authenticated budget", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { WEBHOOK_INGEST_RATE_LIMIT } = await import(
			"../connections/webhook-ingest.js"
		);
		// The pi-review repro: exhaust the old shared budget with bad tokens,
		// then deliver with the real one. The valid delivery must still land.
		for (let i = 0; i <= WEBHOOK_INGEST_RATE_LIMIT.limit; i++) {
			const res = await ingest(
				storedRow(),
				delivery({ i }, { headers: { authorization: "Bearer wrong" } }),
			);
			expect(res.status).toBe(401);
		}
		const valid = await ingest(
			storedRow(),
			delivery({ legit: true }, { headers: bearer }),
		);
		expect(valid.status).toBe(202);
	});

	test("a flooding source IP exhausts only its own pre-auth bucket", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { WEBHOOK_INGEST_PREAUTH_RATE_LIMIT } = await import(
			"../connections/webhook-ingest.js"
		);
		// Flood past the pre-auth budget from one source address. The source is
		// the socket peer address (getClientIP ignores X-Forwarded-For unless
		// TRUSTED_PROXY is set), so we drive it via the peerAddress arg.
		let flooderLimited = false;
		for (let i = 0; i <= WEBHOOK_INGEST_PREAUTH_RATE_LIMIT.limit; i++) {
			const res = await ingest(
				storedRow(),
				delivery({ i }, { headers: { authorization: "Bearer wrong" } }),
				"203.0.113.7",
			);
			if (res.status === 429) {
				flooderLimited = true;
				break;
			}
		}
		expect(flooderLimited).toBe(true);

		// A different source delivering with the real token is unaffected.
		const valid = await ingest(
			storedRow(),
			delivery({ legit: true }, { headers: bearer }),
			"198.51.100.9",
		);
		expect(valid.status).toBe(202);
	});
});

describe("ChatInstanceManager webhook wiring", () => {
	async function buildManager() {
		const { ChatInstanceManager } = await import(
			"../connections/chat-instance-manager.js"
		);
		const { createPostgresAgentConnectionStore } = await import(
			"../../lobu/stores/postgres-stores.js"
		);
		const { PostgresSecretStore } = await import(
			"../../lobu/stores/postgres-secret-store.js"
		);
		const { SecretStoreRegistry } = await import("../secrets/index.js");

		const connectionStore = createPostgresAgentConnectionStore();
		const postgresSecretStore = new PostgresSecretStore();
		const secretStore = new SecretStoreRegistry(postgresSecretStore, {
			secret: postgresSecretStore,
		});
		const manager = new ChatInstanceManager() as any;
		manager.services = {
			getPublicGatewayUrl: () => "",
			getSecretStore: () => secretStore,
			getConnectionStore: () => connectionStore,
			getChannelBindingService: () => ({ getBindingForConnection: async () => null }),
			getCommandRegistry: () => undefined,
		};
		manager.publicGatewayUrl = "";
		manager.connectionStore = connectionStore;
		return { manager, connectionStore };
	}

	test("addConnection auto-generates a token, secretizes it, starts no instance", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { manager, connectionStore } = await buildManager();

		const created = await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection("webhook", AGENT, { platform: "webhook" }),
		);

		// Returned once in plaintext at create — strong and non-empty.
		expect(typeof created.config.token).toBe("string");
		expect(created.config.token.length).toBeGreaterThanOrEqual(32);
		// Adapterless: nothing hydrated, nothing to stop.
		expect(manager.instances.size).toBe(0);

		const stored = await orgContext.run({ organizationId: ORG }, () =>
			connectionStore.getConnection(created.id),
		);
		expect(stored.status).toBe("active");
		expect(String(stored.config.token).startsWith("secret://")).toBe(true);
	});

	test("handleIngestWebhook round-trips a delivery through the real secret store", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { manager } = await buildManager();

		const created = await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection("webhook", AGENT, {
				platform: "webhook",
				allowQueryAuth: true,
				semanticType: "alert",
				titlePath: "/event/title",
			}),
		);
		const token = created.config.token as string;

		// No ambient org context — the manager must scope to the row's org.
		const res = await manager.handleIngestWebhook(
			created.id,
			new Request(
				`http://gateway.test/api/v1/webhooks/${created.id}?token=${token}`,
				{
					method: "POST",
					body: JSON.stringify({ event: { title: "Sentry issue" } }),
					headers: { "content-type": "application/json" },
				},
			),
		);
		expect(res.status).toBe(202);

		const rows = await eventRows(created.id);
		expect(rows.length).toBe(1);
		expect(rows[0].title).toBe("Sentry issue");
		expect(rows[0].semantic_type).toBe("alert");
		expect(rows[0].organization_id).toBe(ORG);
	});

	test("a stopped webhook connection refuses deliveries with 404", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { manager } = await buildManager();

		const created = await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection("webhook", AGENT, { platform: "webhook" }),
		);
		const token = created.config.token as string;
		await orgContext.run({ organizationId: ORG }, () =>
			manager.stopConnection(created.id),
		);

		const res = await manager.handleIngestWebhook(
			created.id,
			new Request(`http://gateway.test/api/v1/webhooks/${created.id}`, {
				method: "POST",
				body: JSON.stringify({ dropped: true }),
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
			}),
		);
		expect(res.status).toBe(404);
		expect((await eventRows(created.id)).length).toBe(0);
	});

	test("handleIngestWebhook 404s for unknown ids and non-webhook platforms", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { manager, connectionStore } = await buildManager();

		const missing = await manager.handleIngestWebhook(
			"nope",
			new Request("http://gateway.test/api/v1/webhooks/nope", {
				method: "POST",
			}),
		);
		expect(missing.status).toBe(404);

		await orgContext.run({ organizationId: ORG }, () =>
			connectionStore.saveConnection({
				id: "tg1",
				platform: "telegram",
				agentId: AGENT,
				organizationId: ORG,
				config: { platform: "telegram", botToken: "12345:fake" },
				settings: { allowGroups: true },
				metadata: {},
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const wrongPlatform = await manager.handleIngestWebhook(
			"tg1",
			new Request("http://gateway.test/api/v1/webhooks/tg1", {
				method: "POST",
			}),
		);
		expect(wrongPlatform.status).toBe(404);
	});

	// Full wired path: the REAL Hono route → ChatInstanceManager →
	// handleWebhookIngest → real Postgres. This is what an actual provider
	// delivery exercises (vs. the unit tests above that call the handler
	// directly). We hold the signing secret, so we compute a real GitHub-style
	// HMAC — the only thing not covered is the live-OAuth `registerWebhook` call
	// and the provider's own POST, which need real credentials + a public URL.
	async function registeredGithubConnection(connectionStore: any): Promise<string> {
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const id = "whk-gh-e2e";
		// Simulate a connection AFTER registration stamped the scheme + secret.
		await orgContext.run({ organizationId: ORG }, () =>
			connectionStore.saveConnection({
				id,
				platform: "webhook",
				agentId: AGENT,
				organizationId: ORG,
				config: {
					platform: "webhook",
					...githubSigConfig,
					dedupeHeader: "x-github-delivery",
					semanticType: "issue",
				},
				settings: { allowGroups: true },
				metadata: {},
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		return id;
	}

	test("e2e: a signed GitHub delivery routes through the real endpoint and lands", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, connectionStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await registeredGithubConnection(connectionStore);
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({
			action: "opened",
			issue: { number: 11, title: "Prod is down" },
			repository: { full_name: "acme/api" },
		});
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-github-event": "issues",
					"x-github-delivery": "gh-e2e-1",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(202);

		const rows = await eventRows(id);
		expect(rows.length).toBe(1);
		// EL: the raw GitHub payload is what landed — untransformed.
		expect(rows[0].payload_data).toEqual({
			action: "opened",
			issue: { number: 11, title: "Prod is down" },
			repository: { full_name: "acme/api" },
		});
		expect(rows[0].origin_id).toBe("gh-e2e-1");
		expect(rows[0].semantic_type).toBe("issue");
		expect(rows[0].organization_id).toBe(ORG);
	});

	test("e2e: the real endpoint rejects a forged signature with 401", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, connectionStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await registeredGithubConnection(connectionStore);
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({ action: "opened", issue: { number: 12 } });
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-github-event": "issues",
					"x-hub-signature-256": "sha256=forged",
				},
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows(id)).length).toBe(0);
	});
});

/**
 * Two-table bridge: a CONNECTOR webhook (rows in the `connections` table, NOT
 * `agent_connections`). A connector registers a provider webhook at connect
 * time and stamps the verification scheme + a `secret://` signing-secret ref
 * onto its `connections.config`. Deliveries arrive at the SAME public route
 * (`/api/v1/webhooks/:connectionId`), miss the `agent_connections` lookup, and
 * are bridged to `handleWebhookIngest` so all the existing protections (HMAC
 * verify, size cap, rate limit, dedupe, connector_key=webhook:<id> index)
 * apply unchanged.
 */
describe("connector-connection webhook bridge (connections table)", () => {
	async function buildManager() {
		const { ChatInstanceManager } = await import(
			"../connections/chat-instance-manager.js"
		);
		const { createPostgresAgentConnectionStore } = await import(
			"../../lobu/stores/postgres-stores.js"
		);
		const { PostgresSecretStore } = await import(
			"../../lobu/stores/postgres-secret-store.js"
		);
		const { SecretStoreRegistry } = await import("../secrets/index.js");

		const connectionStore = createPostgresAgentConnectionStore();
		const postgresSecretStore = new PostgresSecretStore();
		const secretStore = new SecretStoreRegistry(postgresSecretStore, {
			secret: postgresSecretStore,
		});
		const manager = new ChatInstanceManager() as any;
		manager.services = {
			getPublicGatewayUrl: () => "",
			getSecretStore: () => secretStore,
			getConnectionStore: () => connectionStore,
			getChannelBindingService: () => ({ getBindingForConnection: async () => null }),
			getCommandRegistry: () => undefined,
		};
		manager.publicGatewayUrl = "";
		manager.connectionStore = connectionStore;
		return { manager, secretStore };
	}

	/**
	 * Seed a connector `connections` row that has "registered" a GitHub webhook:
	 * the signing secret is persisted as a real `secret://` ref (under org
	 * context, the same way registerConnectorWebhook does), and the scheme +
	 * ref are stamped onto config under the `webhook_*` keys the bridge reads.
	 * Returns the generated connection id (a bigint, as a string).
	 */
	async function seedRegisteredConnectorConnection(
		secretStore: any,
		overrides: { status?: string; secret?: string | null } = {},
	): Promise<string> {
		const { getDb } = await import("../../db/client.js");
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { persistSecretValue } = await import("../secrets/index.js");

		const secretValue =
			overrides.secret === null ? null : (overrides.secret ?? SIG_SECRET);
		// Insert first to get the generated id, then persist the secret + stamp.
		const inserted = (await getDb()`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, ${"github"}, ${`github-${Date.now()}-${Math.random()}`},
				${overrides.status ?? "active"}, ${getDb().json({})})
			RETURNING id
		`) as Array<{ id: number }>;
		const id = String(inserted[0].id);

		const secretRef = secretValue
			? await orgContext.run({ organizationId: ORG }, () =>
					persistSecretValue(
						secretStore,
						`webhook/${id}/signature-secret`,
						secretValue,
					),
				)
			: undefined;

		const config: Record<string, unknown> = {
			webhook_external_id: "gh-hook-123",
			webhook_signature_header: "x-hub-signature-256",
			webhook_algorithm: "sha256",
			webhook_signature_prefix: "sha256=",
			webhook_dedupe_header: "x-github-delivery",
			semanticType: "issue",
			...(secretRef ? { webhook_signature_secret: secretRef } : {}),
		};
		await getDb()`
			UPDATE connections SET config = ${getDb().json(config)} WHERE id = ${id}
		`;
		return id;
	}

	test("a signed GitHub delivery to a connector connection lands via the bridge", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await seedRegisteredConnectorConnection(secretStore);
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({
			action: "opened",
			issue: { number: 7, title: "Bridge works" },
		});
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-github-event": "issues",
					"x-github-delivery": "gh-bridge-1",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(202);

		const rows = await eventRows(id);
		expect(rows.length).toBe(1);
		// connector_key = webhook:<connId> so the existing dedupe index applies.
		expect(rows[0].connector_key).toBe(`webhook:${id}`);
		expect(rows[0].origin_id).toBe("gh-bridge-1");
		expect(rows[0].semantic_type).toBe("issue");
		expect(rows[0].organization_id).toBe(ORG);
		expect(rows[0].payload_data).toEqual({
			action: "opened",
			issue: { number: 7, title: "Bridge works" },
		});
	});

	test("a forged signature to a connector connection is rejected with 401", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await seedRegisteredConnectorConnection(secretStore);
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({ action: "opened", issue: { number: 8 } });
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-hub-signature-256": "sha256=deadbeef",
				},
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows(id)).length).toBe(0);
	});

	test("a redelivery (same delivery id) dedupes to one event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await seedRegisteredConnectorConnection(secretStore);
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({ action: "edited", issue: { number: 9 } });
		const headers = {
			"content-type": "application/json",
			"x-github-delivery": "gh-dupe-1",
			"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
		};
		const first = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers,
			}),
		);
		const second = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers,
			}),
		);
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect((await eventRows(id)).length).toBe(1);
	});

	test("a connector connection with no registered webhook 404s (no blind accept)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager } = await buildManager();
		const { getDb } = await import("../../db/client.js");
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		// A connector connection that NEVER registered a webhook (no webhook_* keys).
		const inserted = (await getDb()`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, ${"github"}, ${`github-nohook-${Date.now()}`}, ${"active"},
				${getDb().json({ repo_owner: "acme", repo_name: "api" })})
			RETURNING id
		`) as Array<{ id: number }>;
		const id = String(inserted[0].id);
		const app = createConnectionWebhookRoutes(manager);

		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: JSON.stringify({ action: "opened" }),
				headers: { "content-type": "application/json" },
			}),
		);
		expect(res.status).toBe(404);
		expect((await eventRows(id)).length).toBe(0);
	});

	test("a paused connector connection refuses deliveries with 404", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await seedRegisteredConnectorConnection(secretStore, {
			status: "paused",
		});
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({ action: "opened" });
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(404);
		expect((await eventRows(id)).length).toBe(0);
	});
});
