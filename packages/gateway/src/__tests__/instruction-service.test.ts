import { beforeEach, describe, expect, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store";
import { InstructionService } from "../services/instruction-service";

describe("InstructionService", () => {
  let store: AgentSettingsStore;
  let service: InstructionService;

  beforeEach(() => {
    store = new AgentSettingsStore(new MockRedisClient() as any);
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
      { settingsUrl: "http://localhost:8080/agents/agent-1" }
    );

    expect(sessionContext.agentInstructions).toContain(
      "## Agent Configuration Notice"
    );
    expect(sessionContext.agentInstructions).toContain(
      "IDENTITY.md, SOUL.md, USER.md"
    );
    expect(sessionContext.agentInstructions).not.toContain("ScheduleReminder");
    expect(sessionContext.agentInstructions).not.toContain(
      "Do not invent product capabilities"
    );
  });
});
