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
			getChannelBindingService: () => ({ getBinding: async () => null }),
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
});
