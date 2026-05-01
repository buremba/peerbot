import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { InstructionService } from "../services/instruction-service.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

describe("InstructionService", () => {
  let store: AgentSettingsStore;
  let service: InstructionService;

  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    store = new AgentSettingsStore();
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
});
