import { describe, expect, mock, test } from "bun:test";
import {
  applyPendingConfigRequest,
  buildConfigRequestText,
} from "../interactions/config-request-store";

describe("config-request-store", () => {
  test("applies skills, mcps, nix packages, and grants", async () => {
    const updateSettings = mock(() => Promise.resolve());
    const grant = mock(() => Promise.resolve());
    const agentSettingsStore = {
      getSettings: mock(() =>
        Promise.resolve({
          nixConfig: { packages: ["git"] },
          skillsConfig: {
            skills: [
              {
                repo: "existing-skill",
                name: "Existing Skill",
                description: "Existing",
                enabled: false,
              },
            ],
          },
          mcpServers: {
            existing: { enabled: true, url: "https://existing.example.com" },
          },
        })
      ),
      updateSettings,
    };
    const grantStore = { grant };

    await applyPendingConfigRequest(
      agentSettingsStore as any,
      grantStore as any,
      {
        agentId: "agent-1",
        reason: "Install requested skill",
        skills: [
          {
            repo: "existing-skill",
            name: "Existing Skill",
            description: "Updated",
          },
          {
            repo: "new-skill",
            name: "New Skill",
            description: "New",
          },
        ],
        mcpServers: [
          {
            id: "new-mcp",
            name: "New MCP",
            url: "https://mcp.example.com",
            type: "sse",
          },
        ],
        nixPackages: ["git", "ffmpeg"],
        grants: ["api.example.com"],
      }
    );

    expect(updateSettings).toHaveBeenCalledTimes(1);
    const [, updates] = updateSettings.mock.calls[0]!;
    expect(updates.skillsConfig.skills).toHaveLength(2);
    expect(
      updates.skillsConfig.skills.find(
        (skill: any) => skill.repo === "existing-skill"
      ).enabled
    ).toBe(true);
    expect(
      updates.skillsConfig.skills.find(
        (skill: any) => skill.repo === "new-skill"
      ).name
    ).toBe("New Skill");
    expect(updates.mcpServers["new-mcp"]).toMatchObject({
      enabled: true,
      url: "https://mcp.example.com",
      type: "sse",
    });
    expect(updates.nixConfig.packages).toEqual(["git", "ffmpeg"]);
    expect(grant).toHaveBeenCalledWith("agent-1", "api.example.com", null);
  });

  test("skips settings writes when a request only grants permissions", async () => {
    const updateSettings = mock(() => Promise.resolve());
    const grant = mock(() => Promise.resolve());
    const agentSettingsStore = {
      getSettings: mock(() => Promise.resolve({})),
      updateSettings,
    };
    const grantStore = { grant };

    await applyPendingConfigRequest(
      agentSettingsStore as any,
      grantStore as any,
      {
        agentId: "agent-1",
        reason: "Allow API access",
        grants: ["api.example.com"],
      }
    );

    expect(updateSettings).not.toHaveBeenCalled();
    expect(grant).toHaveBeenCalledWith("agent-1", "api.example.com", null);
  });

  test("builds readable config request text", () => {
    const text = buildConfigRequestText({
      agentId: "agent-1",
      reason: "Install skill",
      message: "Needed for triage",
      skills: [{ repo: "ops-triage", name: "Ops Triage" }],
      nixPackages: ["ffmpeg"],
      grants: ["api.example.com"],
      providers: ["openai"],
    });

    expect(text).toContain("Configuration Change Request");
    expect(text).toContain("Ops Triage");
    expect(text).toContain("ffmpeg");
    expect(text).toContain("api.example.com");
    expect(text).toContain("openai");
  });
});
