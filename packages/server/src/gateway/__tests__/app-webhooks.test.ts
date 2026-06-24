/**
 * Shared multi-tenant app-webhook router (app-installation design §4.3).
 *
 * Drives the REAL Hono route (`createAppWebhookRoutes`) → provider plugin →
 * real Postgres, the path an actual App delivery exercises (minus the live
 * provider POST). We hold the app webhook secret, so we compute a real HMAC
 * over the raw body.
 *
 * GitHub is poll-canonical: it has a sync mapping, so the canonical record is
 * the poll, not the webhook. Per event type the provider either TRIGGERS (marks
 * the one affected feed due so the poll fetches the complete record — no actor
 * resolution; the poll resolves the person once) or, for event-complete signals
 * (stars), STORES the structured event directly + resolves the actor, keyed on
 * the same origin_id the poll uses. It never stores a raw `events` row. Jira/
 * Linear have no sync mapping, so they still land the raw delivery
 * (connector_key='webhook:app_install:<id>').
 *
 * Under test (GitHub):
 *  1. A signed delivery for a CONFIGURED repo → 200, feeds marked due, NO raw event.
 *  2. A delivery for an UNCONFIGURED repo → 200 triggered:false, nothing stored.
 *  3. The acting user is resolved into a tenant-scoped person (identity graph).
 *  4. Forged/wrong-secret/tampered → 401; unknown tenant / no install → 200 ack.
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
	seedGithubConnectorDef,
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

/** Count every raw app-install event regardless of which install key it landed under. */
async function appInstallEventCount(): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const [row] = await getDb()`
    SELECT count(*)::int AS n FROM events WHERE connector_key LIKE 'webhook:app_install:%'
  `;
	return row.n;
}

/**
 * Seed a github connection bound to `installId` (its config.installation_ref is
 * the app_installations row id, exactly as the install callback writes it) plus
 * one ACTIVE feed for {owner,name} with `next_run_at` NULL. A trigger sets it to
 * now(), so NULL→NOT NULL cleanly proves the webhook marked the feed due.
 */
async function seedGithubFeed(opts: {
	installId: number;
	owner: string;
	name: string;
	feedKey?: string;
}): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	// One github connection per (install, repo), reused across feed types — so
	// seeding e.g. both issues + commits feeds doesn't collide on the slug.
	const slug = `github-${opts.owner}-${opts.name}`;
	let [conn] = await sql`SELECT id FROM connections WHERE organization_id = ${ORG} AND slug = ${slug}`;
	if (!conn) {
		[conn] = await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, config, visibility, created_at, updated_at
      ) VALUES (
        ${ORG}, 'github', ${slug}, 'GitHub', 'active',
        ${sql.json({ installation_ref: opts.installId })}, 'org', NOW(), NOW()
      )
      RETURNING id
    `;
	}
	const [feed] = await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name, status, config, next_run_at
    ) VALUES (
      ${ORG}, ${conn.id}, ${opts.feedKey ?? "issues"}, 'Issues', 'active',
      ${sql.json({ repo_owner: opts.owner, repo_name: opts.name })}, NULL
    )
    RETURNING id
  `;
	return Number(feed.id);
}

/** Current `next_run_at` of a feed (NULL until a trigger marks it due). */
async function feedNextRunAt(feedId: number): Promise<unknown> {
	const { getDb } = await import("../../db/client.js");
	const [row] = await getDb()`SELECT next_run_at FROM feeds WHERE id = ${feedId}`;
	return row?.next_run_at ?? null;
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
	// The github webhook routing + person rule are read from the connector
	// definition (feeds_schema), so every github delivery test needs it seeded.
	const { clearEntityLinkRulesCache } = await import(
		"../../utils/entity-link-upsert.js"
	);
	clearEntityLinkRulesCache();
	await seedGithubConnectorDef(ORG);
}, 30_000);

describe("app-webhook router (GitHub)", () => {
	test("an issues delivery marks ONLY the issues feed due (scoped, no raw event)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		// Two feeds on the same repo. An `issues` delivery must trigger only the
		// issues feed — not re-poll commits.
		const issuesFeed = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const commitsFeed = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			feedKey: "commits",
		});
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
			},
			repository: { owner: { login: "acme" }, name: "api", full_name: "acme/api" },
		});
		const res = await app.fetch(ghDelivery(raw));
		// Trigger path acks 200 (not 202 — nothing was landed as a record).
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);

		// The poll is the canonical record, so the webhook stores no raw event…
		expect(await appInstallEventCount()).toBe(0);
		// …it marks the issues feed due (NULL → now()) and leaves commits untouched.
		expect(await feedNextRunAt(issuesFeed)).not.toBeNull();
		expect(await feedNextRunAt(commitsFeed)).toBeNull();
	});

	test("a delivery for an unconfigured repo acks 200 triggered:false and stores nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		// A feed exists, but for a DIFFERENT repo than the delivery is about.
		const otherFeedId = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "other",
		});
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 1, title: "x" },
			repository: { owner: { login: "acme" }, name: "api", full_name: "acme/api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-unconf-1" }));
		expect(res.status).toBe(200);
		// No matching feed for acme/api → triggered:false, a no-op (not an error).
		expect((await res.json()).triggered).toBe(false);
		expect(await appInstallEventCount()).toBe(0);
		// The unrelated repo's feed was left untouched.
		expect(await feedNextRunAt(otherFeedId)).toBeNull();
	});

	test("a delivery for an active feed on a PAUSED connection is a no-op", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const feedId = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		// Pause the github connection; the feed row stays active.
		const { getDb } = await import("../../db/client.js");
		await getDb()`
			UPDATE connections SET status = 'paused'
			WHERE organization_id = ${ORG} AND connector_key = 'github'
		`;
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 1, title: "x" },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-paused-conn" }));
		expect(res.status).toBe(200);
		// Connection isn't active → no feed woken, even though the feed row is.
		expect((await res.json()).triggered).toBe(false);
		expect(await feedNextRunAt(feedId)).toBeNull();
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

	test("a redelivery just re-stamps next_run_at — idempotent, still no event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const feedId = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const app = buildApp();

		const raw = JSON.stringify({
			action: "edited",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 9 },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const first = await app.fetch(ghDelivery(raw, { deliveryId: "gh-dupe-1" }));
		const second = await app.fetch(ghDelivery(raw, { deliveryId: "gh-dupe-1" }));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect((await second.json()).triggered).toBe(true);
		// Re-stamping next_run_at is idempotent; the poll (not the webhook) dedupes
		// the actual content by stable origin_id, so still nothing landed raw.
		expect(await feedNextRunAt(feedId)).not.toBeNull();
		expect(await appInstallEventCount()).toBe(0);
	});

	test("a star delivery stores a stargazer event + resolves the actor, without triggering a poll", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		// The stargazers feed exists as the scheduled backstop; the store path must
		// NOT mark it due (re-polling the whole list to capture one star is waste).
		const stargazersFeed = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			feedKey: "stargazers",
		});
		const app = buildApp();

		const raw = JSON.stringify({
			action: "created",
			starred_at: "2026-06-20T10:00:00Z",
			installation: { id: Number(INSTALLATION_ID) },
			sender: { login: "Octocat", id: 583231, html_url: "https://github.com/Octocat" },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-star-1", event: "star" }));
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);

		// A structured stargazer event landed under the github connection, keyed on
		// the SAME origin_id the poll uses — so the /stargazers backstop dedupes it.
		const events = await eventRows("github");
		expect(events.length).toBe(1);
		expect(events[0].origin_type).toBe("stargazer");
		expect(events[0].origin_id).toBe("stargazer_acme_api_github_user_id_583231");
		expect(events[0].metadata.action).toBe("starred");

		// The actor was resolved to a person (the poll won't run for this feed)…
		const people = await personRows(ORG);
		expect(people.length).toBe(1);
		expect(people[0].name).toBe("Octocat");
		expect(await identitiesFor(Number(people[0].id))).toEqual([
			"github_login:octocat",
			"github_user_id:583231",
		]);
		// …and the wasteful poll was NOT triggered.
		expect(await feedNextRunAt(stargazersFeed)).toBeNull();
	});

	test("a star for a repo with no stargazers feed configured is a no-op (nothing stored)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		// Routing comes from the seeded connector def (star → store), but there is
		// NO stargazers feed instance for acme/api — so the store path must no-op,
		// mirroring the trigger path's "unconfigured feed → nothing happens".
		await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "created",
			starred_at: "2026-06-20T10:00:00Z",
			installation: { id: Number(INSTALLATION_ID) },
			sender: { login: "Octocat", id: 583231 },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-star-nofeed", event: "star" }));
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(false);
		expect(await eventRows("github")).toHaveLength(0);
		expect(await personRows(ORG)).toHaveLength(0);
	});

	test("a star with different repo casing matches the feed and uses the feed's canonical origin_id", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		// Feed config is lowercase acme/api; the delivery uses display casing.
		await seedGithubFeed({ installId, owner: "acme", name: "api", feedKey: "stargazers" });
		const app = buildApp();

		const raw = JSON.stringify({
			action: "created",
			starred_at: "2026-06-20T10:00:00Z",
			installation: { id: Number(INSTALLATION_ID) },
			sender: { login: "Octocat", id: 583231 },
			repository: { owner: { login: "ACME" }, name: "API" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-star-case", event: "star" }));
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);

		// Matched case-insensitively, and origin_id uses the feed's casing so it
		// consolidates with the poll (which keys off the feed config, not the payload).
		const events = await eventRows("github");
		expect(events.length).toBe(1);
		expect(events[0].origin_id).toBe("stargazer_acme_api_github_user_id_583231");
	});

	test("with storeWebhookEvents off, a star falls back to a poll trigger (nothing stored)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		const stargazersFeed = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			feedKey: "stargazers",
		});
		const app = createAppWebhookRoutes({
			installationStore: createPostgresAppInstallationStore(),
			secretStore: fakeSecretStore,
			providers: [
				createGithubAppWebhookProvider({ appId: APP_ID, storeWebhookEvents: false }),
			],
			resolveAppWebhookSecret: async () => APP_SECRET,
		});

		const raw = JSON.stringify({
			action: "created",
			starred_at: "2026-06-20T10:00:00Z",
			installation: { id: Number(INSTALLATION_ID) },
			sender: { login: "Octocat", id: 583231 },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-star-off", event: "star" }));
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);

		// Flag off → no direct store; the stargazers feed is marked due for the poll
		// instead, and no person is resolved on the trigger path.
		expect(await eventRows("github")).toHaveLength(0);
		expect(await personRows(ORG)).toHaveLength(0);
		expect(await feedNextRunAt(stargazersFeed)).not.toBeNull();
	});

	test("a push delivery triggers the COMMITS feed (not issues) and resolves no actor", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		// push maps to the commits feed; an issues feed on the same repo must stay put.
		const commitsFeed = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			feedKey: "commits",
		});
		const issuesFeed = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const app = buildApp();

		const raw = JSON.stringify({
			ref: "refs/heads/main",
			installation: { id: Number(INSTALLATION_ID) },
			pusher: { name: "someone" },
			sender: { login: "someone", id: 9 },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(
			ghDelivery(raw, { deliveryId: "gh-push-1", event: "push" }),
		);
		expect(res.status).toBe(200);
		// push → commits feed marked due; issues feed untouched.
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(commitsFeed)).not.toBeNull();
		expect(await feedNextRunAt(issuesFeed)).toBeNull();
		// push isn't an authored-content event for the trigger path, and triggers
		// never resolve actors anyway, so no person is created.
		expect(await personRows(ORG)).toHaveLength(0);
		expect(await appInstallEventCount()).toBe(0);
	});

	test("two star deliveries from the same user consolidate to ONE event + ONE person", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedPersonResolutionPrereqs(ORG);
		const installId = await seedActiveInstall();
		await seedGithubFeed({ installId, owner: "acme", name: "api", feedKey: "stargazers" });
		const app = buildApp();

		const raw = JSON.stringify({
			action: "created",
			starred_at: "2026-06-20T10:00:00Z",
			installation: { id: Number(INSTALLATION_ID) },
			sender: { login: "Octocat", id: 583231 },
			repository: { owner: { login: "acme" }, name: "api" },
		});

		const first = await app.fetch(ghDelivery(raw, { deliveryId: "gh-star-a", event: "star" }));
		const second = await app.fetch(ghDelivery(raw, { deliveryId: "gh-star-b", event: "star" }));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);

		// Same actor → same origin_id → the insert upserts: one stargazer event,
		// and the entity-link upsert keeps it to one person.
		expect(await eventRows("github")).toHaveLength(1);
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
