/**
 * Install-flow org resolution — the connection lands in the org the user was
 * VIEWING (threaded as `?org=<slug>`), authorized by membership, NOT the
 * session's ambient active org.
 *
 * Regression: the connectors UI showed org A while the session's active org was
 * B, so `resolveInstallOrgId` (session-only) bound the install to B and the
 * connection was created in the wrong tenant. These tests prove the explicit
 * `?org=` target wins over the ambient session org, that a non-member request is
 * rejected (no silent fallback), and that completion authorization is by
 * membership (`verifyInstallOrgAccess`).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
	resolveInstallOrgId,
	verifyInstallOrgAccess,
} from "../../../gateway/routes/public/install-org";
import { initWorkspaceProvider } from "../../../workspace";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

/**
 * Build a tiny app that runs the REAL install-org resolvers under a stubbed auth
 * context — `user` + session `organizationId` mimic what `createLobuAuthBridge`
 * stamps. `GET /resolve?org=…&verify=…` returns `{ org, access }` so a single
 * request exercises both `resolveInstallOrgId` and `verifyInstallOrgAccess`
 * against the real DB.
 */
function buildApp(session: { userId: string | null; activeOrg: string | null }) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user" as never, session.userId ? { id: session.userId } : null);
		if (session.activeOrg) c.set("organizationId" as never, session.activeOrg);
		await next();
	});
	app.get("/resolve", async (c) => {
		const org = await resolveInstallOrgId(c);
		const verifyTarget = c.req.query("verify");
		const access = verifyTarget
			? await verifyInstallOrgAccess(c, verifyTarget)
			: null;
		return c.json({ org, access });
	});
	return app;
}

beforeAll(async () => {
	await initWorkspaceProvider();
});

describe("install-flow org resolution (?org= explicit target)", () => {
	it("honors ?org=<slug> over the ambient session org when the user is a member", async () => {
		const viewedOrg = await createTestOrganization({ name: "Viewed Org" });
		const ambientOrg = await createTestOrganization({
			name: "Ambient Session Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, viewedOrg.id);
		await addUserToOrganization(user.id, ambientOrg.id);

		// Session's active org is the AMBIENT org (the bug: it drifts from the UI).
		const app = buildApp({ userId: user.id, activeOrg: ambientOrg.id });
		const res = await app.request(`/resolve?org=${viewedOrg.slug}`);
		const body = (await res.json()) as { org: string | null };

		// Explicit ?org= wins — the connection lands in the VIEWED org, not ambient.
		expect(body.org).toBe(viewedOrg.id);
	});

	it("rejects ?org=<slug> when the user is NOT a member (no silent fallback)", async () => {
		const foreignOrg = await createTestOrganization({ name: "Foreign Org" });
		const homeOrg = await createTestOrganization({ name: "Home Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, homeOrg.id);

		const app = buildApp({ userId: user.id, activeOrg: homeOrg.id });
		const res = await app.request(`/resolve?org=${foreignOrg.slug}`);
		const body = (await res.json()) as { org: string | null };

		// Not a member of the requested org → null (the route rejects). It must NOT
		// silently retarget to the session's home org.
		expect(body.org).toBeNull();
	});

	it("falls back to the session org when no ?org= is provided", async () => {
		const org = await createTestOrganization({ name: "Session Only Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id);

		const app = buildApp({ userId: user.id, activeOrg: org.id });
		const res = await app.request(`/resolve`);
		const body = (await res.json()) as { org: string | null };

		expect(body.org).toBe(org.id);
	});

	it("verifyInstallOrgAccess is true for a member and false for a non-member", async () => {
		const org = await createTestOrganization({ name: "Access Org" });
		const member = await createTestUser();
		const outsider = await createTestUser();
		await addUserToOrganization(member.id, org.id);

		const memberApp = buildApp({ userId: member.id, activeOrg: org.id });
		const memberRes = await memberApp.request(`/resolve?verify=${org.id}`);
		expect(((await memberRes.json()) as { access: boolean }).access).toBe(true);

		const outsiderApp = buildApp({ userId: outsider.id, activeOrg: null });
		const outsiderRes = await outsiderApp.request(`/resolve?verify=${org.id}`);
		expect(((await outsiderRes.json()) as { access: boolean }).access).toBe(
			false,
		);
	});
});
