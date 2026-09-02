import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { GUIDANCE_SEMANTIC_TYPE } from "../../utils/org-guidance.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { InstructionService } from "../services/instruction-service.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

/** Insert a minimal org-authored guidance event (the shape save_memory writes). */
async function seedGuidanceEvent(
  organizationId: string,
  text: string
): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO events (
      entity_ids, organization_id, origin_id, payload_type, payload_text,
      semantic_type, occurred_at
    ) VALUES (
      NULL, ${organizationId}, ${`uc_${crypto.randomUUID()}`}, 'text', ${text},
      ${GUIDANCE_SEMANTIC_TYPE}, NOW()
    )
    RETURNING id
  `;
  return Number(row.id);
}

describe("InstructionService", () => {
  let store: AgentSettingsStore;
  let service: InstructionService;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    store = new AgentSettingsStore(createPostgresAgentConfigStore());
    service = new InstructionService(undefined, store);
  });

  test("returns stronger fallback guidance when agent instructions are unconfigured", async () => {
    const sessionContext = await service.getSessionContext(
      "telegram",
      {
        agentId: "agent-1",
        userId: "user-1",
        workingDirectory: "/workspace/thread-1",
      } as any,
      { settingsUrl: "http://localhost:8080/api/v1/agents/agent-1/config" }
    );

    expect(sessionContext.agentLayers.unconfiguredNotice).toContain(
      "## Agent Configuration Notice"
    );
    expect(sessionContext.agentLayers.unconfiguredNotice).toContain(
      "IDENTITY.md, SOUL.md, USER.md"
    );
    expect(sessionContext.agentLayers.unconfiguredNotice).not.toContain(
      "Do not invent product capabilities"
    );
  });

  test("keeps identity, soul and user in their own fields (no welded blob)", async () => {
    // Joining here would force prompt assembly to recover boundaries from
    // headings that operators can also use in their own content.
    await seedAgentRow("layered", { organizationId: "org-a" });
    await orgContext.run({ organizationId: "org-a" }, () =>
      store.saveSettings("layered", {
        identityMd: "I am Aria.",
        soulMd: "Always answer in British English.",
        userMd: "Your audience is Acme's support team.",
      } as any)
    );

    const ctx = await service.getSessionContext("telegram", {
      agentId: "layered",
      organizationId: "org-a",
      userId: "user-1",
      workingDirectory: "/workspace/thread-1",
    } as any);

    expect(ctx.agentLayers.identityMd).toBe("I am Aria.");
    expect(ctx.agentLayers.soulMd).toBe("Always answer in British English.");
    expect(ctx.agentLayers.userMd).toBe(
      "Your audience is Acme's support team."
    );
    // Configured agents get no notice, and no layer absorbs another.
    expect(ctx.agentLayers.unconfiguredNotice).toBe("");
    expect(ctx.agentLayers.identityMd).not.toContain("British English");
    expect(ctx.agentLayers.soulMd).not.toContain("Aria");
  });

  test("resolves agent identity scoped to the caller's org (shared agent id across orgs)", async () => {
    // The same agent id lives in two orgs with different identities. The worker
    // path (getSessionContext) has no ambient orgContext, so the instruction
    // reads MUST scope by context.organizationId — otherwise an unscoped read
    // returns an arbitrary org's identity and leaks it into the other tenant's
    // session.
    await seedAgentRow("lobu-builder", { organizationId: "org-a" });
    await seedAgentRow("lobu-builder", { organizationId: "org-b" });

    await orgContext.run({ organizationId: "org-a" }, () =>
      store.saveSettings("lobu-builder", {
        identityMd: "I am the ORG-A builder.",
      } as any)
    );
    await orgContext.run({ organizationId: "org-b" }, () =>
      store.saveSettings("lobu-builder", {
        identityMd: "I am the ORG-B builder.",
      } as any)
    );

    const ctxB = await service.getSessionContext("telegram", {
      agentId: "lobu-builder",
      organizationId: "org-b",
      userId: "user-1",
      workingDirectory: "/workspace/thread-1",
    } as any);

    // org-b's identity resolved — not org-a's (the unscoped-read bug).
    expect(ctxB.agentLayers.identityMd).toContain("I am the ORG-B builder.");
    expect(ctxB.agentLayers.identityMd).not.toContain("I am the ORG-A builder.");
  });

  test("does NOT inject org guidance into the agent layers (delivered through managed-agent MCP instructions, not duplicated)", async () => {
    // Single source of truth: guidance reaches the worker prompt through the
    // lobu-memory MCP server's managed-agent instructions
    // (buildWorkspaceInstructions renders the "Organization Context" section).
    // Injecting it into the agent layers here too would duplicate it in the
    // prompt. Direct MCP clients receive a separate directory-safe audience.
    await seedAgentRow("agent-guided", { organizationId: "org-a" });
    await seedGuidanceEvent("org-a", "Fiscal year starts in February.");

    const ctxA = await service.getSessionContext("telegram", {
      agentId: "agent-guided",
      organizationId: "org-a",
      userId: "user-1",
      workingDirectory: "/workspace/thread-1",
    } as any);

    expect(JSON.stringify(ctxA.agentLayers)).not.toContain(
      "## Organization Context"
    );
    expect(JSON.stringify(ctxA.agentLayers)).not.toContain(
      "Fiscal year starts in February."
    );
  });
});
