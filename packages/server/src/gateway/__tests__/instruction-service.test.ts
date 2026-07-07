import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { InstructionService } from "../services/instruction-service.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

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

    expect(sessionContext.agentInstructions).toContain(
      "## Agent Configuration Notice"
    );
    expect(sessionContext.agentInstructions).toContain(
      "IDENTITY.md, SOUL.md, USER.md"
    );
    expect(sessionContext.agentInstructions).not.toContain(
      "Do not invent product capabilities"
    );
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
    expect(ctxB.agentInstructions).toContain("I am the ORG-B builder.");
    expect(ctxB.agentInstructions).not.toContain("I am the ORG-A builder.");
  });
});
