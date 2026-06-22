/**
 * Shared multi-tenant app-webhook router (app-installation design §4.3).
 *
 * Drives the REAL Hono route (`createAppWebhookRoutes`) → GitHub provider
 * plugin → `handleWebhookIngest` → real Postgres, the path an actual GitHub App
 * delivery exercises (minus the live provider POST). We hold the app webhook
 * secret, so we compute a real `x-hub-signature-256` HMAC over the raw body.
 *
 * Under test:
 *  1. A signed `issues` delivery with a seeded ACTIVE install routes to the
 *     owning org and lands an `events` row (connector_key='webhook:app_install:<id>').
 *  2. A forged signature → 401, nothing landed.
 *  3. An unknown tenant (no active install) → 200 ack, nothing landed (the
 *     delivery-before-install-callback case must NOT 500).
 *  4. Redelivery (same x-github-delivery) dedupes to one event.
 */

import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	createAppWebhookRoutes,
	createGithubAppWebhookProvider,
} from "../routes/public/app-webhooks.js";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import {
	ensureDbForGatewayTests,
	ensureEncryptionKey,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "org-app-webhook";
const AGENT = "agent-app-webhook";
const APP_ID = "654321";
const APP_SECRET = "ghapp-webhook-secret-0123456789abcdef";
const INSTALLATION_ID = "987654";

/** GitHub signs the raw body with the App webhook secret → `sha256=<hex>`. */
function ghSign(rawBody: string, secret = APP_SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** A plaintext-only fake; the app secret is provided via the resolver. */
const fakeSecretStore = { get: async () => null };

/** Build the router with the GitHub plugin and a fixed app-secret resolver. */
function buildApp() {
	return createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		secretStore: fakeSecretStore,
		providers: [createGithubAppWebhookProvider({ appId: APP_ID })],
		resolveAppWebhookSecret: async () => APP_SECRET,
	});
}

/** Seed an ACTIVE github installation for the routed tenant tuple. */
async function seedActiveInstall(): Promise<number> {
	const store = createPostgresAppInstallationStore();
	const row = await store.upsert({
		organizationId: ORG,
		provider: "github",
		providerInstance: "cloud",
		providerAppId: APP_ID,
		externalTenantId: INSTALLATION_ID,
		status: "active",
		metadata: { account: "acme" },
	});
	return row.id;
}

function ghDelivery(
	rawBody: string,
	{
		signature = ghSign(rawBody),
		deliveryId = "gh-app-1",
		event = "issues",
	}: { signature?: string; deliveryId?: string; event?: string } = {},
): Request {
	return new Request("http://gateway.test/api/v1/app-webhooks/github", {
		method: "POST",
		body: rawBody,
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-github-delivery": deliveryId,
			"x-hub-signature-256": signature,
		},
	});
}

async function eventRows(connectorKey: string): Promise<any[]> {
	const { getDb } = await import("../../db/client.js");
	return getDb()`
    SELECT * FROM events
    WHERE connector_key = ${connectorKey}
    ORDER BY id
  `;
}

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

describe("app-webhook router (GitHub)", () => {
	test("a signed issues delivery routes to the owning org and lands an event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
			},
			repository: { full_name: "acme/api" },
		});
		const res = await app.fetch(ghDelivery(raw));
		expect(res.status).toBe(202);

		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		// EL: the raw GitHub payload is what landed — untransformed.
		expect(rows[0].payload_data).toEqual({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
			},
			repository: { full_name: "acme/api" },
		});
		// Routed into the install's owning org, deduped on the delivery id.
		expect(rows[0].organization_id).toBe(ORG);
		expect(rows[0].origin_id).toBe("gh-app-1");
		// Title + source_url projected from the issue (not left empty).
		expect(rows[0].title).toBe("Prod is down");
		expect(rows[0].source_url).toBe("https://github.com/acme/api/issues/11");
	});

	test("an issue_comment delivery lands the parent issue title + comment url", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "created",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
			},
			comment: {
				id: 555,
				body: "Looking into it",
				html_url: "https://github.com/acme/api/issues/11#issuecomment-555",
			},
			repository: { full_name: "acme/api" },
		});
		const res = await app.fetch(
			ghDelivery(raw, { deliveryId: "gh-comment-1", event: "issue_comment" }),
		);
		expect(res.status).toBe(202);

		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		// Title is the PARENT issue's; url deep-links the comment itself.
		expect(rows[0].title).toBe("Prod is down");
		expect(rows[0].source_url).toBe(
			"https://github.com/acme/api/issues/11#issuecomment-555",
		);
	});

	test("a pull_request delivery lands the PR title + html_url", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			pull_request: {
				number: 42,
				title: "Add app_installation auth method",
				html_url: "https://github.com/acme/api/pull/42",
			},
			repository: { full_name: "acme/api" },
		});
		const res = await app.fetch(
			ghDelivery(raw, { deliveryId: "gh-pr-1", event: "pull_request" }),
		);
		expect(res.status).toBe(202);

		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		expect(rows[0].title).toBe("Add app_installation auth method");
		expect(rows[0].source_url).toBe("https://github.com/acme/api/pull/42");
	});

	test("a forged signature is rejected with 401 and lands nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 12 },
		});
		const res = await app.fetch(
			ghDelivery(raw, { signature: "sha256=forged" }),
		);
		expect(res.status).toBe(401);
		expect((await eventRows(`webhook:app_install:${installId}`)).length).toBe(0);
	});

	test("a delivery signed with the wrong secret is rejected with 401", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
		});
		const res = await app.fetch(
			ghDelivery(raw, { signature: ghSign(raw, "the-wrong-secret") }),
		);
		expect(res.status).toBe(401);
		expect((await eventRows(`webhook:app_install:${installId}`)).length).toBe(0);
	});

	test("a tampered body (signature over different bytes) is rejected", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const app = buildApp();

		const signedOver = JSON.stringify({
			installation: { id: Number(INSTALLATION_ID) },
			issue: 1,
		});
		const tampered = JSON.stringify({
			installation: { id: Number(INSTALLATION_ID) },
			issue: 999,
		});
		const res = await app.fetch(
			ghDelivery(tampered, { signature: ghSign(signedOver) }),
		);
		expect(res.status).toBe(401);
		expect((await eventRows(`webhook:app_install:${installId}`)).length).toBe(0);
	});

	test("an unknown tenant (no active install) acks 200 without landing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		// No install seeded — delivery arrives before the install callback.
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: 111222 },
			issue: { number: 1 },
		});
		const res = await app.fetch(ghDelivery(raw));
		// Ack, NOT 500 — the provider must not retry-storm; reconcile on callback.
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
		// Nothing landed for any install key.
		const { getDb } = await import("../../db/client.js");
		const all = await getDb()`
      SELECT count(*)::int AS n FROM events WHERE connector_key LIKE 'webhook:app_install:%'
    `;
		expect(all[0].n).toBe(0);
	});

	test("a suspended install does not route (transfer demoted it) → 200 ack", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const store = createPostgresAppInstallationStore();
		// Activate then suspend (e.g. ownership transferred away). resolveActive
		// must miss, so the delivery acks without landing.
		const row = await store.upsert({
			organizationId: ORG,
			provider: "github",
			providerInstance: "cloud",
			providerAppId: APP_ID,
			externalTenantId: INSTALLATION_ID,
			status: "active",
		});
		await store.setStatus(row.id, "suspended");
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
		});
		const res = await app.fetch(ghDelivery(raw));
		expect(res.status).toBe(200);
		expect((await eventRows(`webhook:app_install:${row.id}`)).length).toBe(0);
	});

	test("a delivery with no installation in the body acks 200 (no tenant)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({ action: "ping", zen: "Keep it logically awesome." });
		const res = await app.fetch(ghDelivery(raw));
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
	});

	test("redelivery of the same x-github-delivery dedupes to one event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "edited",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 9 },
		});
		const first = await app.fetch(ghDelivery(raw, { deliveryId: "gh-dupe-1" }));
		const second = await app.fetch(ghDelivery(raw, { deliveryId: "gh-dupe-1" }));
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect((await second.json()).duplicate).toBe(true);
		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		expect(rows[0].origin_id).toBe("gh-dupe-1");
	});

	test("an unknown provider path returns 404", async () => {
		const app = buildApp();
		const res = await app.fetch(
			new Request("http://gateway.test/api/v1/app-webhooks/slack", {
				method: "POST",
				body: JSON.stringify({ team_id: "T1" }),
				headers: { "content-type": "application/json" },
			}),
		);
		expect(res.status).toBe(404);
	});

	test("fails closed with 401 when no app webhook secret is configured", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const app = createAppWebhookRoutes({
			installationStore: createPostgresAppInstallationStore(),
			secretStore: fakeSecretStore,
			providers: [createGithubAppWebhookProvider({ appId: APP_ID })],
			resolveAppWebhookSecret: async () => undefined,
		});

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
		});
		const res = await app.fetch(ghDelivery(raw));
		expect(res.status).toBe(401);
		expect((await eventRows(`webhook:app_install:${installId}`)).length).toBe(0);
	});
});
