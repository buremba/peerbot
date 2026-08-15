import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import {
	createNotificationForUsers,
	listNotifications,
} from "../../notifications/service";
import { createConnectorOperationRun } from "../../runs/queue-service";
import { listOrgActivity } from "../../tools/admin/manage_operations/activity-feed";
import { dispatchChromeActionToExtension } from "../../worker-api/dispatch-chrome-action";
import { activatePageRun } from "../../worker-api/page-activation";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";
import { post } from "../setup/test-helpers";

const sql = getTestDb();

async function seed() {
	const user = await createTestUser({
		email: `page-activation-${Date.now()}@test.com`,
	});
	const org = await createTestOrganization({ name: "Page activation" });
	await createTestConnectorDefinition({
		key: "x",
		name: "X",
		organization_id: org.id,
	});
	await sql`
		INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
		VALUES (${`member-${Date.now()}`}, ${org.id}, ${user.id}, 'owner', NOW())
	`;
	const workers = await sql<{ id: string; worker_id: string }>`
		INSERT INTO device_workers (
			user_id, worker_id, platform, capabilities, organization_id, last_seen_at
		) VALUES
			(${user.id}, 'chrome-mini', 'chrome-extension', ${sql.json(["browser.debugger"])}, ${org.id}, NOW()),
			(${user.id}, 'chrome-book', 'chrome-extension', ${sql.json(["browser.debugger"])}, ${org.id}, NOW())
		RETURNING id, worker_id
	`;
	const [connection] = await sql<{ id: number }>`
		INSERT INTO connections (
			organization_id, connector_key, slug, display_name, status,
			created_by, visibility, device_worker_id, created_at, updated_at
		) VALUES (
			${org.id}, 'x', 'x-page-activation', 'X', 'active',
			${user.id}, 'org', ${workers[0]?.id}::uuid, NOW(), NOW()
		)
		RETURNING id
	`;
	const [run] = await sql<{ id: number }>`
		INSERT INTO runs (
			organization_id, run_type, connection_id, connector_key, action_key,
			action_input, approval_status, status, created_at, expires_at,
			activation_kind, activation_target_urls, created_by_user_id
		) VALUES (
			${org.id}, 'action', ${connection.id}, 'x', 'prepare_reply',
			${sql.json({ body: "draft" })}, 'auto', 'pending', NOW(), NOW() + interval '1 day',
			'page_visit', ARRAY['https://x.com/ada/status/123']::text[], ${user.id}
		)
		RETURNING id
	`;
	return { user, org, workers, connection, run };
}

function appFor(userId: string, orgId: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.use("*", async (c, next) => {
		c.set("workerAuthMode", "user");
		c.set("workerUserId", userId);
		c.set("workerOrgIds", [orgId]);
		await next();
	});
	app.post("/activate", activatePageRun);
	return app;
}

function request(
	app: ReturnType<typeof appFor>,
	workerId: string,
	runId: number,
	url: string,
) {
	return app.request("/activate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			worker_id: workerId,
			run_id: runId,
			tab_id: 17,
			url,
		}),
	});
}

describe("page-activated operation runs", () => {
	beforeEach(cleanupTestDatabase);
	afterAll(cleanupTestDatabase);

	it("atomically lets the first matching browser win across devices", async () => {
		const seeded = await seed();
		const app = appFor(seeded.user.id, seeded.org.id);
		const [a, b] = await Promise.all([
			request(
				app,
				"chrome-mini",
				seeded.run.id,
				"https://x.com/ada/status/123?ref=home",
			),
			request(
				app,
				"chrome-book",
				seeded.run.id,
				"https://x.com/ada/status/123#reply",
			),
		]);
		const statuses = await Promise.all([a.json(), b.json()]);
		expect(statuses.map((body) => body.status).sort()).toEqual([
			"activated",
			"unavailable",
		]);
		const [row] = await sql<{
			activated_at: Date | null;
			activated_by_device_worker_id: string | null;
			activation_tab_id: number | null;
		}>`
			SELECT activated_at, activated_by_device_worker_id, activation_tab_id
			FROM runs WHERE id = ${seeded.run.id}
		`;
		expect(row.activated_at).not.toBeNull();
		expect(row.activation_tab_id).toBe(17);
		expect(seeded.workers.map((worker) => worker.id)).toContain(
			row.activated_by_device_worker_id,
		);
	});

	it("does not consume a run for a different page", async () => {
		const seeded = await seed();
		const response = await request(
			appFor(seeded.user.id, seeded.org.id),
			"chrome-mini",
			seeded.run.id,
			"https://x.com/home",
		);
		await expect(response.json()).resolves.toEqual({ status: "unavailable" });
		const [row] = await sql<{ activated_at: Date | null }>`
			SELECT activated_at FROM runs WHERE id = ${seeded.run.id}
		`;
		expect(row.activated_at).toBeNull();
	});

	it("does not reveal or activate another member's page draft", async () => {
		const seeded = await seed();
		const other = await createTestUser({
			email: `page-activation-other-${Date.now()}@test.com`,
		});
		await sql`
			INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
			VALUES (${`member-other-${Date.now()}`}, ${seeded.org.id}, ${other.id}, 'member', NOW())
		`;
		await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, capabilities, organization_id, last_seen_at
			) VALUES (
				${other.id}, 'chrome-other', 'chrome-extension',
				${sql.json(["browser.debugger"])}, ${seeded.org.id}, NOW()
			)
		`;
		const poll = await post("/api/workers/poll", {
			body: {
				worker_id: "chrome-other",
				platform: "chrome-extension",
				app_version: "0.5.6",
				capabilities: { "browser.debugger": true },
			},
		});
		expect(poll.status).toBe(200);
		await expect(poll.json()).resolves.toMatchObject({ page_activations: [] });
		const activation = await request(
			appFor(other.id, seeded.org.id),
			"chrome-other",
			seeded.run.id,
			"https://x.com/ada/status/123",
		);
		await expect(activation.json()).resolves.toEqual({ status: "unavailable" });
	});

	it("returns URL-only hints to Chrome without letting the extension claim the parked run", async () => {
		const seeded = await seed();
		const response = await post("/api/workers/poll", {
			body: {
				worker_id: "chrome-mini",
				platform: "chrome-extension",
				app_version: "0.5.6",
				capabilities: { "browser.debugger": true },
			},
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			page_activations: [
				{
					run_id: seeded.run.id,
					urls: ["https://x.com/ada/status/123"],
				},
			],
		});
		const [row] = await sql<{ status: string; claimed_by: string | null }>`
			SELECT status, claimed_by FROM runs WHERE id = ${seeded.run.id}
		`;
		expect(row).toEqual({ status: "pending", claimed_by: null });
	});

	it("runs the activated parent on the fleet without changing the winning device", async () => {
		const seeded = await seed();
		const activation = await request(
			appFor(seeded.user.id, seeded.org.id),
			"chrome-book",
			seeded.run.id,
			"https://x.com/ada/status/123",
		);
		await expect(activation.json()).resolves.toEqual({ status: "activated" });

		const pinnedBrowserPoll = await post("/api/workers/poll", {
			body: {
				worker_id: "chrome-mini",
				platform: "chrome-extension",
				app_version: "0.5.6",
				capabilities: { "browser.debugger": true },
			},
		});
		expect(pinnedBrowserPoll.status).toBe(200);
		const pinnedBrowserBody = await pinnedBrowserPoll.json();
		expect(pinnedBrowserBody).toMatchObject({
			page_activations: [],
		});
		expect(pinnedBrowserBody).not.toHaveProperty("run_id");
		const fleetPoll = await post("/api/workers/poll", {
			body: {
				worker_id: "fleet-page-activation",
				capabilities: {},
			},
		});
		expect(fleetPoll.status).toBe(200);
		await expect(fleetPoll.json()).resolves.toMatchObject({
			run_id: seeded.run.id,
			run_type: "action",
		});
		const [row] = await sql<{
			status: string;
			claimed_by: string | null;
			activated_by_device_worker_id: string | null;
		}>`
			SELECT status, claimed_by, activated_by_device_worker_id
			FROM runs WHERE id = ${seeded.run.id}
		`;
		expect(row).toMatchObject({
			status: "running",
			claimed_by: "fleet-page-activation",
			activated_by_device_worker_id: seeded.workers[1]?.id,
		});
	});

	it("reuses the activated page without navigating the user-owned tab", async () => {
		const seeded = await seed();
		const mini = seeded.workers.find(
			(worker) => worker.worker_id === "chrome-mini",
		);
		await sql`
			UPDATE runs
			SET status = 'running',
			    activated_at = NOW(),
			    activated_by_device_worker_id = ${mini?.id}::uuid,
			    activation_tab_id = 23
			WHERE id = ${seeded.run.id}
		`;
		const navigation = await dispatchChromeActionToExtension({
			organizationId: seeded.org.id,
			parentRunId: seeded.run.id,
			actionKey: "navigate",
			actionInput: { url: "https://x.com/ada/status/123?ref=timeline" },
		});
		expect(navigation).toEqual({
			status: "completed",
			output: {
				tab_id: 23,
				current_url: "https://x.com/ada/status/123",
				user_owned: true,
			},
		});
		const wrongPage = await dispatchChromeActionToExtension({
			organizationId: seeded.org.id,
			parentRunId: seeded.run.id,
			actionKey: "navigate",
			actionInput: { url: "https://x.com/home" },
		});
		expect(wrongPage).toMatchObject({
			status: "failed",
			error_message: expect.stringContaining("may not navigate"),
		});
	});

	it("rejects a page-required navigate before it can create or mutate a tab", async () => {
		const seeded = await seed();
		const result = await dispatchChromeActionToExtension({
			organizationId: seeded.org.id,
			parentRunId: seeded.run.id,
			actionKey: "navigate",
			actionInput: {
				url: "https://x.com/ada/status/123",
				require_page_activation: true,
				open_in_new_tab: true,
			},
		});
		expect(result).toEqual({
			status: "failed",
			error_message:
				"This browser operation requires an exact user page visit before it can run.",
		});
		const childRuns = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM runs WHERE connector_key = 'chrome'
		`;
		expect(childRuns[0]?.count).toBe(0);
	});

	it("creates a durable parked operation instead of entering inline execution", async () => {
		const seeded = await seed();
		const request = {
			organizationId: seeded.org.id,
			connectionId: seeded.connection.id,
			connectorKey: "x",
			operationKey: "prepare_reply",
			operationInput: {
				tweet_url: "https://x.com/grace/status/456",
				body: "Draft",
			},
			idempotencyKey: "page-activation-replay",
			approvalMode: "inline",
			activation: {
				kind: "page_visit",
				urls: ["https://x.com/grace/status/456"],
				expiresInSeconds: 86_400,
			},
		} as const;
		const created = await createConnectorOperationRun(request);
		expect(created.status).toBe("pending");
		await expect(createConnectorOperationRun(request)).resolves.toMatchObject({
			runId: created.runId,
			created: false,
			status: "pending",
		});
		await expect(
			createConnectorOperationRun({
				...request,
				activation: {
					...request.activation,
					urls: ["https://x.com/grace/status/999"],
				},
			}),
		).rejects.toThrow("already bound to a different request");
		const [row] = await sql<{
			status: string;
			activation_kind: string | null;
			activation_target_urls: string | string[];
		}>`
			SELECT status, activation_kind, activation_target_urls
			FROM runs WHERE id = ${created.runId}
		`;
		expect(row.status).toBe("pending");
		expect(row.activation_kind).toBe("page_visit");
		expect(String(row.activation_target_urls)).toContain(
			"https://x.com/grace/status/456",
		);
	});

	it("refuses to park an operation that must execute on a device", async () => {
		const seeded = await seed();
		await expect(
			createConnectorOperationRun({
				organizationId: seeded.org.id,
				connectionId: seeded.connection.id,
				connectorKey: "x",
				operationKey: "prepare_reply",
				operationInput: { body: "Draft" },
				approvalMode: "device",
				activation: {
					kind: "page_visit",
					urls: ["https://x.com/ada/status/123"],
					expiresInSeconds: 86_400,
				},
			}),
		).rejects.toThrow("Page activation requires inline execution");
	});

	it("carries the browser action URL through notifications and the shared activity feed", async () => {
		const seeded = await seed();
		await createNotificationForUsers([seeded.user.id], {
			organizationId: seeded.org.id,
			type: "agent_message",
			title: "Draft ready for Ada on X",
			body: "Draft: Hello",
			resourceUrl: `/${seeded.org.slug}/memory?content_ids=1`,
			browserUrl: "https://x.com/ada/status/123",
		});
		const listed = await listNotifications({
			organizationId: seeded.org.id,
			userId: seeded.user.id,
		});
		expect(listed.notifications[0]?.browser_url).toBe(
			"https://x.com/ada/status/123",
		);
		const activity = await listOrgActivity({
			organizationId: seeded.org.id,
			userId: seeded.user.id,
			ownerSlug: seeded.org.slug,
			includeRuns: false,
		});
		expect(activity.items[0]?.browser_url).toBe("https://x.com/ada/status/123");
	});

	it("keeps an undismissed browser-handoff draft beyond the recent-window cap", async () => {
		const seeded = await seed();
		// An older undismissed draft that predates 55 newer notifications: the
		// recent-window slice would drop it, but the "stays until Done" contract
		// must keep it in the lens regardless.
		await createNotificationForUsers([seeded.user.id], {
			organizationId: seeded.org.id,
			type: "agent_message",
			title: "Draft ready for Ada on X",
			body: "Draft: Hello",
			resourceUrl: `/${seeded.org.slug}/memory?content_ids=1`,
			browserUrl: "https://x.com/ada/status/123",
		});
		const [draft] = await sql<{ id: number }>`
			SELECT id FROM events ORDER BY id ASC LIMIT 1
		`;
		for (let i = 0; i < 55; i++) {
			await createNotificationForUsers([seeded.user.id], {
				organizationId: seeded.org.id,
				type: "agent_message",
				title: `Newer notification ${i}`,
				body: "noise",
				resourceUrl: `/${seeded.org.slug}/memory?content_ids=99`,
			});
		}
		// Backdate the draft below the recent window (newest 50), still undismissed.
		await sql`
			UPDATE events
			SET created_at = created_at - interval '7 days'
			WHERE id = ${draft.id}
		`;
		const activity = await listOrgActivity({
			organizationId: seeded.org.id,
			userId: seeded.user.id,
			ownerSlug: seeded.org.slug,
			includeRuns: false,
			limit: 50,
		});
		expect(activity.items.some((item) => item.browser_url === "https://x.com/ada/status/123")).toBe(
			true,
		);
		// Respects the declared limit even when the undismissed draft is pinned.
		expect(activity.items.length).toBeLessThanOrEqual(50);
		// Items stay in chronological order (oldest first).
		const ats = activity.items.map((item) => new Date(item.at).getTime());
		expect([...ats].sort((a, b) => a - b)).toEqual(ats);
		// RawCard-only fields never leak to the public shape.
		for (const item of activity.items) {
			expect(item).not.toHaveProperty("atMs");
			expect(item).not.toHaveProperty("collapseKey");
			expect(item).not.toHaveProperty("itemsCollected");
		}
	});

	it("excludes browser-handoff drafts when the kind filter omits notifications", async () => {
		const seeded = await seed();
		await createNotificationForUsers([seeded.user.id], {
			organizationId: seeded.org.id,
			type: "agent_message",
			title: "Draft ready for Ada on X",
			body: "Draft: Hello",
			resourceUrl: `/${seeded.org.slug}/memory?content_ids=1`,
			browserUrl: "https://x.com/ada/status/123",
		});
		const activity = await listOrgActivity({
			organizationId: seeded.org.id,
			userId: seeded.user.id,
			ownerSlug: seeded.org.slug,
			includeRuns: false,
			kinds: ["sync"],
			limit: 50,
		});
		expect(activity.items.some((item) => item.browser_url === "https://x.com/ada/status/123")).toBe(
			false,
		);
	});

	it("pins a draft that sits inside the window but outside the final limit", async () => {
		const seeded = await seed();
		// 30 newer notifications then one draft: with limit 24 the draft is
		// inside the 60-card merge window but outside the final slice, so it
		// must still be pinned and survive.
		for (let i = 0; i < 30; i++) {
			await createNotificationForUsers([seeded.user.id], {
				organizationId: seeded.org.id,
				type: "agent_message",
				title: `Newer notification ${i}`,
				body: "noise",
				resourceUrl: `/${seeded.org.slug}/memory?content_ids=99`,
			});
		}
		await createNotificationForUsers([seeded.user.id], {
			organizationId: seeded.org.id,
			type: "agent_message",
			title: "Draft ready for Ada on X",
			body: "Draft: Hello",
			resourceUrl: `/${seeded.org.slug}/memory?content_ids=1`,
			browserUrl: "https://x.com/ada/status/123",
		});
		const activity = await listOrgActivity({
			organizationId: seeded.org.id,
			userId: seeded.user.id,
			ownerSlug: seeded.org.slug,
			includeRuns: false,
			limit: 24,
		});
		expect(activity.items.some((item) => item.browser_url === "https://x.com/ada/status/123")).toBe(
			true,
		);
		expect(activity.items.length).toBeLessThanOrEqual(24);
	});

	it("caps pinned drafts at the declared limit", async () => {
		const seeded = await seed();
		// More undismissed drafts than the limit: the response must stay bounded.
		for (let i = 0; i < 12; i++) {
			await createNotificationForUsers([seeded.user.id], {
				organizationId: seeded.org.id,
				type: "agent_message",
				title: `Draft ${i}`,
				body: "Draft: Hello",
				resourceUrl: `/${seeded.org.slug}/memory?content_ids=${i}`,
				browserUrl: `https://x.com/ada/status/${1000 + i}`,
			});
		}
		const activity = await listOrgActivity({
			organizationId: seeded.org.id,
			userId: seeded.user.id,
			ownerSlug: seeded.org.slug,
			includeRuns: false,
			limit: 5,
		});
		expect(activity.items.length).toBe(5);
		expect(
			activity.items.filter((item) => item.browser_url != null).length,
		).toBe(5);
	});
});
