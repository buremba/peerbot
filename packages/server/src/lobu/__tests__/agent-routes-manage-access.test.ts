/**
 * Agent management-mutation access: only org owner/admin (web session) — or a
 * PAT/OAuth token carrying `mcp:admin` — may PATCH/DELETE an agent or rewrite
 * its config. A plain org MEMBER must get 403 on all three surfaces.
 *
 * Regression for the decision-brief finding: `requireSessionOrAdminPat` alone
 * lets any member rewrite/delete another member's agent (and change its
 * soulMd/guardrails/tool surface) via the REST routes.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import {
  authStash,
  coreServicesStash,
  installRouteTestMocks,
} from "./helpers/route-test-mocks";

installRouteTestMocks();

const ORG = "org-manage-access";
const AGENT = "manage-access-agent";

async function seedOrgAndAgent(): Promise<void> {
  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG}) ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${AGENT}, ${ORG}, 'Manage Access Agent')
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
}

async function importAgentRoutes() {
  const mod = await import("../agent-routes.js");
  return mod.agentRoutes;
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
  await seedOrgAndAgent();
  authStash.user = {
    id: "u1",
    name: "Test",
    email: "u1@test",
    emailVerified: true,
  };
  authStash.organizationId = ORG;
  authStash.authSource = "session";
  authStash.mcpAuthInfo = null;
  authStash.memberRole = "member";
  coreServicesStash.services = null;
}, 30_000);

describe("agent management mutations — role gate", () => {
  test("member: PATCH /config is denied", async () => {
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ soulMd: "override" }),
    });
    expect(res.status).toBe(403);
  });

  test("member: PATCH /:agentId (metadata) is denied", async () => {
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(403);
  });

  test("member: DELETE /:agentId is denied", async () => {
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}`, { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("owner: PATCH /config passes the gate (reaches handler validation)", async () => {
    authStash.memberRole = "owner";
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel: "openai/gpt-5" }),
    });
    // 400 (legacy field rejected by the handler) proves it cleared the gate;
    // a 403 would mean the role check wrongly blocked the owner.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "legacy_model_field"
    );
  });

  test("owner: PATCH /:agentId (metadata) succeeds", async () => {
    authStash.memberRole = "owner";
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
  });

  test("member + PAT with mcp:admin keeps the admin delegation", async () => {
    authStash.memberRole = "member";
    authStash.authSource = "pat";
    authStash.mcpAuthInfo = { scopes: ["mcp:admin"] };
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel: "openai/gpt-5" }),
    });
    // Same 400-legacy-field marker: the mcp:admin token passes the gate.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "legacy_model_field"
    );
  });

  test("member: GET config stays readable (read is org-wide by decision)", async () => {
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`);
    expect(res.status).toBe(200);
  });
});
