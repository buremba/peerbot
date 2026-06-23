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
	createJiraAppWebhookProvider,
	createLinearAppWebhookProvider,
	createSchemaDrivenAppWebhookProvider,
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

/**
 * Build the router with the github provider's `resolveActor` wrapped in a
 * counter, so a test can assert exactly one resolution per landed event.
 */
function buildAppWithActorCounter(): { app: ReturnType<typeof createAppWebhookRoutes>; calls: () => number } {
	const provider = createGithubAppWebhookProvider({ appId: APP_ID });
	const original = provider.resolveActor!.bind(provider);
	let count = 0;
	provider.resolveActor = async (params) => {
		count += 1;
		return original(params);
	};
	const app = createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		secretStore: fakeSecretStore,
		providers: [provider],
		resolveAppWebhookSecret: async () => APP_SECRET,
	});
	return { app, calls: () => count };
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

/**
 * Seed the prerequisites for actor → person resolution in the routed org: an
 * org member (entities.created_by is NOT NULL — resolveOrgCreator reads it) and
 * the `person` entity type the github actor rule auto-creates into.
 */
async function seedPersonResolutionPrereqs(orgId: string): Promise<void> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	const userId = `u-${orgId}`;
	await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Owner', ${`${userId}@example.com`}, true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;
	await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`m-${orgId}`}, ${orgId}, ${userId}, 'owner', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${orgId}, 'person', 'Person', NOW(), NOW())
    ON CONFLICT DO NOTHING
  `;
}

async function personRows(orgId: string): Promise<any[]> {
	const { getDb } = await import("../../db/client.js");
	return getDb()`
    SELECT e.id, e.name, e.metadata
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${orgId} AND et.slug = 'person' AND e.deleted_at IS NULL
    ORDER BY e.id
  `;
}

/**
 * Parse `events.entity_ids` regardless of how the driver hands it back: this
 * gateway (bun:test) harness reads the raw column as a Postgres array literal
 * string (`"{1,2}"` / `"{}"`); other paths return a JS array. Normalize to
 * number[] so the attribution assertion is driver-agnostic.
 */
function parseEntityIds(value: unknown): number[] {
	if (Array.isArray(value)) return value.map((v) => Number(v));
	if (typeof value === "string") {
		const inner = value.replace(/^\{|\}$/g, "").trim();
		if (!inner) return [];
		return inner.split(",").map((s) => Number(s));
	}
	return [];
}

async function identitiesFor(entityId: number): Promise<string[]> {
	const { getDb } = await import("../../db/client.js");
	const rows = await getDb()`
    SELECT namespace, identifier FROM entity_identities
    WHERE entity_id = ${entityId} AND deleted_at IS NULL
    ORDER BY namespace, identifier
  `;
	return rows.map((r: any) => `${r.namespace}:${r.identifier}`);
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

	test("a signed delivery resolves the actor → person and lands NON-EMPTY entity_ids", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
				user: { login: "Octocat", id: 583231 },
			},
			sender: { login: "Octocat", id: 583231 },
			repository: { full_name: "acme/api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-attr-1" }));
		expect(res.status).toBe(202);

		// A person was created for the issue author and the row is attributed.
		const people = await personRows(ORG);
		expect(people.length).toBe(1);
		expect(people[0].name).toBe("Octocat");
		expect(await identitiesFor(Number(people[0].id))).toEqual([
			"github_login:octocat",
			"github_user_id:583231",
		]);

		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		// THE assertion the PR claims: the landed row carries the resolved person.
		expect(parseEntityIds(rows[0].entity_ids)).toEqual([Number(people[0].id)]);
		// Canonical read-time identity slot stamped onto the row.
		expect(rows[0].metadata.github_login).toBe("octocat");
	});

	test("an issue_comment delivery attributes the COMMENT author, not the issue author", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "created",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
				user: { login: "issue-author", id: 1 },
			},
			comment: {
				id: 555,
				body: "Looking into it",
				html_url: "https://github.com/acme/api/issues/11#issuecomment-555",
				user: { login: "Hubot", id: 42 },
			},
			sender: { login: "Hubot", id: 42 },
			repository: { full_name: "acme/api" },
		});
		const res = await app.fetch(
			ghDelivery(raw, { deliveryId: "gh-attr-2", event: "issue_comment" }),
		);
		expect(res.status).toBe(202);

		const people = await personRows(ORG);
		// Only the comment author is resolved by this delivery.
		expect(people.length).toBe(1);
		expect(people[0].name).toBe("Hubot");

		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(parseEntityIds(rows[0].entity_ids)).toEqual([Number(people[0].id)]);
		expect(rows[0].metadata.github_login).toBe("hubot");
	});

	test("an unmapped event (push) lands the row but resolves no actor (empty entity_ids)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			ref: "refs/heads/main",
			installation: { id: Number(INSTALLATION_ID) },
			pusher: { name: "someone" },
			sender: { login: "someone", id: 9 },
		});
		const res = await app.fetch(
			ghDelivery(raw, { deliveryId: "gh-push-1", event: "push" }),
		);
		expect(res.status).toBe(202);
		// Delivery still lands (store-everything), just unattributed.
		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		expect(parseEntityIds(rows[0].entity_ids)).toEqual([]);
		expect(await personRows(ORG)).toHaveLength(0);
	});

	test("a redelivered (deduped) delivery does NOT create a person, bump the graph, or land a second event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
				user: { login: "Octocat", id: 583231 },
			},
			sender: { login: "Octocat", id: 583231 },
			repository: { full_name: "acme/api" },
		});

		// First delivery: persists + resolves the actor → one person.
		const first = await app.fetch(ghDelivery(raw, { deliveryId: "gh-dedupe-attr" }));
		expect(first.status).toBe(202);
		const peopleAfterFirst = await personRows(ORG);
		expect(peopleAfterFirst.length).toBe(1);
		const firstAuthoredAt = peopleAfterFirst[0].metadata.last_authored_at;
		expect(firstAuthoredAt).toBeTruthy();

		// Redelivery of the SAME x-github-delivery: deduped → no new event AND no
		// entity-graph mutation (no second person, last_authored_at unchanged).
		const second = await app.fetch(ghDelivery(raw, { deliveryId: "gh-dedupe-attr" }));
		expect(second.status).toBe(202);
		expect((await second.json()).duplicate).toBe(true);

		const peopleAfterSecond = await personRows(ORG);
		expect(peopleAfterSecond.length).toBe(1);
		// Same person, untouched — resolution never ran on the duplicate.
		expect(peopleAfterSecond[0].id).toBe(peopleAfterFirst[0].id);
		expect(peopleAfterSecond[0].metadata.last_authored_at).toBe(firstAuthoredAt);

		// Exactly one event landed.
		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
	});

	test("TWO concurrent deliveries of the same event resolve the actor exactly once", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		const { app, calls } = buildAppWithActorCounter();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
				user: { login: "Octocat", id: 583231 },
			},
			sender: { login: "Octocat", id: 583231 },
			repository: { full_name: "acme/api" },
		});

		// Fire both deliveries of the SAME x-github-delivery simultaneously. The
		// delivery-unique index picks one winner; the loser's tx rolls back before
		// it ever resolves the actor.
		const [a, b] = await Promise.all([
			app.fetch(ghDelivery(raw, { deliveryId: "gh-concurrent" })),
			app.fetch(ghDelivery(raw, { deliveryId: "gh-concurrent" })),
		]);
		expect([a.status, b.status]).toEqual([202, 202]);

		// Exactly one actor resolution, one event, one person, one last_authored_at.
		expect(calls()).toBe(1);
		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		expect(parseEntityIds(rows[0].entity_ids).length).toBe(1);
		const people = await personRows(ORG);
		expect(people.length).toBe(1);
		expect(people[0].metadata.last_authored_at).toBeTruthy();
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

// ---------------------------------------------------------------------------
// Jira — schema-driven verify (`x-hub-signature: sha256=<hex>`), site-host tenant
// ---------------------------------------------------------------------------

const JIRA_APP_ID = "jira-client-id";
const JIRA_SECRET = "jira-webhook-secret-0123456789abcdef";
const JIRA_SITE = "acme.atlassian.net";

/** Jira signs the raw body with the webhook secret → `sha256=<hex>`. */
function jiraSign(rawBody: string, secret = JIRA_SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function buildJiraApp() {
	return createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		secretStore: fakeSecretStore,
		providers: [createJiraAppWebhookProvider({ appId: JIRA_APP_ID })],
		resolveAppWebhookSecret: async () => JIRA_SECRET,
	});
}

async function seedJiraInstall(): Promise<number> {
	const store = createPostgresAppInstallationStore();
	const row = await store.upsert({
		organizationId: ORG,
		provider: "jira",
		providerInstance: "cloud",
		providerAppId: JIRA_APP_ID,
		externalTenantId: JIRA_SITE,
		status: "active",
	});
	return row.id;
}

function jiraDelivery(
	rawBody: string,
	{ signature = jiraSign(rawBody) }: { signature?: string } = {},
): Request {
	return new Request("http://gateway.test/api/v1/app-webhooks/jira", {
		method: "POST",
		body: rawBody,
		headers: {
			"content-type": "application/json",
			"x-hub-signature": signature,
		},
	});
}

describe("app-webhook router (Jira)", () => {
	test("a signed issue delivery routes to the owning org via its site host", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedJiraInstall();
		const app = buildJiraApp();

		const raw = JSON.stringify({
			webhookEvent: "jira:issue_updated",
			issue: {
				id: "10000",
				key: "ACME-1",
				self: `https://${JIRA_SITE}/rest/api/2/issue/10000`,
			},
		});
		const res = await app.fetch(jiraDelivery(raw));
		expect(res.status).toBe(202);

		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		expect(rows[0].organization_id).toBe(ORG);
		// No delivery-id header → dedupe falls back to a body hash origin_id.
		expect(typeof rows[0].origin_id).toBe("string");
	});

	test("a forged signature is rejected with 401 and lands nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedJiraInstall();
		const app = buildJiraApp();

		const raw = JSON.stringify({
			webhookEvent: "jira:issue_updated",
			issue: { self: `https://${JIRA_SITE}/rest/api/2/issue/1` },
		});
		const res = await app.fetch(jiraDelivery(raw, { signature: "sha256=forged" }));
		expect(res.status).toBe(401);
		expect((await eventRows(`webhook:app_install:${installId}`)).length).toBe(0);
	});

	test("a delivery with no self URL has no tenant → 200 ack, nothing landed", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedJiraInstall();
		const app = buildJiraApp();

		const raw = JSON.stringify({ webhookEvent: "jira:test", timestamp: 1 });
		const res = await app.fetch(jiraDelivery(raw));
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Linear — schema-driven verify (`linear-signature: <hex>`, no prefix),
// organizationId tenant
// ---------------------------------------------------------------------------

const LINEAR_APP_ID = "linear-client-id";
const LINEAR_SECRET = "linear-webhook-secret-0123456789abcdef";
const LINEAR_ORG_ID = "11111111-2222-3333-4444-555555555555";

/** Linear signs the raw body and sends a BARE hex digest (no prefix). */
function linearSign(rawBody: string, secret = LINEAR_SECRET): string {
	return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function buildLinearApp() {
	return createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		secretStore: fakeSecretStore,
		providers: [createLinearAppWebhookProvider({ appId: LINEAR_APP_ID })],
		resolveAppWebhookSecret: async () => LINEAR_SECRET,
	});
}

async function seedLinearInstall(): Promise<number> {
	const store = createPostgresAppInstallationStore();
	const row = await store.upsert({
		organizationId: ORG,
		provider: "linear",
		providerInstance: "cloud",
		providerAppId: LINEAR_APP_ID,
		externalTenantId: LINEAR_ORG_ID,
		status: "active",
	});
	return row.id;
}

function linearDelivery(
	rawBody: string,
	{ signature = linearSign(rawBody) }: { signature?: string } = {},
): Request {
	return new Request("http://gateway.test/api/v1/app-webhooks/linear", {
		method: "POST",
		body: rawBody,
		headers: {
			"content-type": "application/json",
			"linear-signature": signature,
		},
	});
}

describe("app-webhook router (Linear)", () => {
	test("a signed issue delivery routes to the owning org via organizationId", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedLinearInstall();
		const app = buildLinearApp();

		const raw = JSON.stringify({
			action: "create",
			type: "Issue",
			organizationId: LINEAR_ORG_ID,
			data: { id: "abc", title: "Ship it" },
		});
		const res = await app.fetch(linearDelivery(raw));
		expect(res.status).toBe(202);

		const rows = await eventRows(`webhook:app_install:${installId}`);
		expect(rows.length).toBe(1);
		expect(rows[0].organization_id).toBe(ORG);
	});

	test("a bare-hex signature with a `sha256=` prefix is rejected (no prefix expected)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedLinearInstall();
		const app = buildLinearApp();

		const raw = JSON.stringify({ organizationId: LINEAR_ORG_ID, action: "create" });
		// Linear sends NO prefix; a `sha256=`-prefixed value must fail.
		const res = await app.fetch(
			linearDelivery(raw, { signature: `sha256=${linearSign(raw)}` }),
		);
		expect(res.status).toBe(401);
		expect((await eventRows(`webhook:app_install:${installId}`)).length).toBe(0);
	});

	test("a delivery with no organizationId has no tenant → 200 ack", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedLinearInstall();
		const app = buildLinearApp();

		const raw = JSON.stringify({ action: "create", type: "Issue" });
		const res = await app.fetch(linearDelivery(raw));
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Schema-driven verify factory — provider-agnostic HMAC derivation
// ---------------------------------------------------------------------------

describe("createSchemaDrivenAppWebhookProvider", () => {
	test("derives verify from the schema header/algorithm/prefix", () => {
		const provider = createSchemaDrivenAppWebhookProvider({
			provider: "demo",
			webhookSchema: {
				signatureHeader: "x-demo-sig",
				algorithm: "sha256",
				signaturePrefix: "sha256=",
			},
			extractTenant: () => null,
		});
		const raw = new TextEncoder().encode("hello");
		const secret = "s3cret";
		const digest = createHmac("sha256", secret).update(raw).digest("hex");

		const good = new Headers({ "x-demo-sig": `sha256=${digest}` });
		expect(provider.verify(raw, good, secret)).toBe(true);

		const wrongHeader = new Headers({ "x-other": `sha256=${digest}` });
		expect(provider.verify(raw, wrongHeader, secret)).toBe(false);

		const forged = new Headers({ "x-demo-sig": "sha256=deadbeef" });
		expect(provider.verify(raw, forged, secret)).toBe(false);
	});

	test("throws when the schema declares no signatureHeader (must fail closed)", () => {
		expect(() =>
			createSchemaDrivenAppWebhookProvider({
				provider: "unsigned",
				webhookSchema: { algorithm: "sha256" },
				extractTenant: () => null,
			}),
		).toThrow(/signatureHeader/);
	});
});
