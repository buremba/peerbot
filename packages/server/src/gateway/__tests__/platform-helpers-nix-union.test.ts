import { describe, expect, test } from "bun:test";
import type { AgentSettings, NixConfig } from "@lobu/core";
import { resolveAgentOptions } from "../services/platform-helpers.js";

type NixSettings = Partial<
  Pick<AgentSettings, "nixConfig" | "skillsConfig">
>;

async function resolveNixConfig(
  settings: NixSettings,
  baseNixConfig?: NixConfig,
): Promise<NixConfig | undefined> {
  const settingsStore = {
    getSettings: async () => ({
      models: ["openai/gpt-5"],
      ...settings,
    }),
  };
  const resolved = await resolveAgentOptions(
    "agent-1",
    { nixConfig: baseNixConfig },
    settingsStore as any,
    "org-1",
  );
  return resolved.nixConfig;
}

describe("resolveAgentOptions nix union", () => {
  test("per-request and agent packages are unioned and deduped", async () => {
    const resolved = await resolveNixConfig(
      { nixConfig: { packages: ["agent-pkg", "shared-pkg"] } },
      { packages: ["request-pkg", "shared-pkg"] },
    );

    expect(resolved?.packages).toEqual([
      "request-pkg",
      "shared-pkg",
      "agent-pkg",
    ]);
  });

  test("a per-request nixConfig survives when the agent declares none", async () => {
    const resolved = await resolveNixConfig({}, { packages: ["request-pkg"] });

    expect(resolved?.packages).toEqual(["request-pkg"]);
  });

  // Stored legacy rows can still carry `nixPackages`; they must validate but
  // contribute nothing to provisioning.
  test("a legacy enabled skill's nixPackages entry is ignored", async () => {
    const resolved = await resolveNixConfig({
      nixConfig: { packages: ["ripgrep"] },
      skillsConfig: {
        skills: [
          {
            repo: "lobu/skills",
            name: "video",
            enabled: true,
            nixPackages: ["ffmpeg"],
          },
        ],
      },
    });

    expect(resolved?.packages).toEqual(["ripgrep"]);
  });

  test("a legacy skill nixPackages entry alone leaves nixConfig unset", async () => {
    const resolved = await resolveNixConfig({
      skillsConfig: {
        skills: [
          {
            repo: "lobu/skills",
            name: "video",
            enabled: true,
            nixPackages: ["ffmpeg"],
          },
        ],
      },
    });

    expect(resolved).toBeUndefined();
  });

  test("flakeUrl is preserved when the base supplies packages", async () => {
    const resolved = await resolveNixConfig(
      { nixConfig: { flakeUrl: "github:org/flake" } },
      { packages: ["request-pkg"] },
    );

    expect(resolved?.flakeUrl).toBe("github:org/flake");
    expect(resolved?.packages).toEqual(["request-pkg"]);
  });

  test("no nix anywhere leaves nixConfig unset (absent stays absent)", async () => {
    const resolved = await resolveNixConfig({
      skillsConfig: {
        skills: [
          {
            repo: "lobu/skills",
            name: "prose-only",
            enabled: true,
          },
        ],
      },
    });

    expect(resolved).toBeUndefined();
  });
});
