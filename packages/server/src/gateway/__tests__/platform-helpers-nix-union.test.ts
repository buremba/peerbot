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
  test("an enabled skill's nixPackages reach nixConfig even when the agent has none", async () => {
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

    expect(resolved?.packages).toEqual(["ffmpeg"]);
  });

  test("agent packages come first and the union is deduped", async () => {
    const resolved = await resolveNixConfig({
      nixConfig: { packages: ["ripgrep", "ffmpeg"] },
      skillsConfig: {
        skills: [
          {
            repo: "lobu/skills",
            name: "video",
            enabled: true,
            nixPackages: ["ffmpeg", "yt-dlp"],
          },
        ],
      },
    });

    expect(resolved?.packages).toEqual(["ripgrep", "ffmpeg", "yt-dlp"]);
  });

  test("base packages survive when settings only add skill packages", async () => {
    const resolved = await resolveNixConfig(
      {
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
      },
      { packages: ["ripgrep"] },
    );

    expect(resolved?.packages).toEqual(["ripgrep", "ffmpeg"]);
  });

  test("per-request, agent and skill packages are all unioned", async () => {
    // `POST /agents` persists its `nix` on the session and replays it as a base
    // option, so agent settings must not clobber the caller's packages.
    const resolved = await resolveNixConfig(
      {
        nixConfig: { packages: ["agent-pkg"] },
        skillsConfig: {
          skills: [
            {
              repo: "lobu/skills",
              name: "video",
              enabled: true,
              nixPackages: ["skill-pkg"],
            },
          ],
        },
      },
      { packages: ["request-pkg"] },
    );

    expect(resolved?.packages).toEqual([
      "request-pkg",
      "agent-pkg",
      "skill-pkg",
    ]);
  });

  test("a per-request nixConfig survives when the agent declares none", async () => {
    const resolved = await resolveNixConfig({}, { packages: ["request-pkg"] });

    expect(resolved?.packages).toEqual(["request-pkg"]);
  });

  test("disabled skills contribute nothing", async () => {
    const resolved = await resolveNixConfig({
      nixConfig: { packages: ["ripgrep"] },
      skillsConfig: {
        skills: [
          {
            repo: "lobu/skills",
            name: "video",
            enabled: false,
            nixPackages: ["ffmpeg"],
          },
        ],
      },
    });

    expect(resolved?.packages).toEqual(["ripgrep"]);
  });

  test("flakeUrl is preserved when skill packages are unioned in", async () => {
    const resolved = await resolveNixConfig({
      nixConfig: { flakeUrl: "github:org/flake" },
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

    expect(resolved?.flakeUrl).toBe("github:org/flake");
    expect(resolved?.packages).toEqual(["ffmpeg"]);
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
