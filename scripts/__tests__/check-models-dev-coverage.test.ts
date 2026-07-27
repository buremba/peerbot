/**
 * The coverage guard is only worth having if it fails when the metadata join
 * is missing or stale. Otherwise a provider silently loses the model details
 * that the committed snapshot is meant to supply.
 *
 * These fixtures mutate a scratch copy of the real config, run the guard as a
 * subprocess, and assert the exit code — the same signal `make pre-pr` and CI
 * act on.
 */

import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type {
  ModelsDevSnapshot,
  ProviderConfigEntry,
  ProvidersConfigFile,
} from "@lobu/core";
import { buildSnapshot, sameModelData } from "../gen-models-dev-snapshot";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/check-models-dev-coverage.ts");
const PROVIDERS = join(REPO_ROOT, "config/providers.json");
const BACKUP = join(REPO_ROOT, "config/providers.json.coverage-test-backup");

function runGuard(): { code: number; output: string } {
  const proc = Bun.spawnSync(["bun", GUARD], { cwd: REPO_ROOT });
  return {
    code: proc.exitCode ?? 1,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

/** Mutate the real providers.json (backed up + restored in afterEach). */
function mutateProviders(mutate: (config: ProvidersConfigFile) => void): void {
  copyFileSync(PROVIDERS, BACKUP);
  const config = JSON.parse(
    readFileSync(PROVIDERS, "utf-8")
  ) as ProvidersConfigFile;
  mutate(config);
  writeFileSync(PROVIDERS, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function firstProvider(config: ProvidersConfigFile) {
  const entry = config.providers[0];
  const provider = entry?.providers?.[0];
  if (!entry || !provider) throw new Error("providers.json has no entries");
  return { entry, provider };
}

afterEach(() => {
  try {
    copyFileSync(BACKUP, PROVIDERS);
    rmSync(BACKUP, { force: true });
  } catch {
    // No backup ⇒ the test never mutated the file.
  }
});

describe("check-models-dev-coverage", () => {
  it("passes on the committed config", () => {
    const { code, output } = runGuard();
    expect(output).toContain("clean");
    expect(code).toBe(0);
  });

  it("FAILS when a provider declares no models.dev mapping", () => {
    mutateProviders((config) => {
      const { provider } = firstProvider(config);
      provider.modelsDevId = undefined;
    });
    const { code, output } = runGuard();
    expect(output).toContain("modelsDevId");
    expect(code).toBe(1);
  });

  /**
   * The snapshot is keyed by LOBU id, so an edited mapping still matches the
   * stale entry by that id. An earlier revision of this guard passed clean here
   * for exactly that reason — the recorded `joinedFrom` key is what closes it.
   */
  it("FAILS when the mapping was edited without regenerating the snapshot", () => {
    mutateProviders((config) => {
      const { provider } = firstProvider(config);
      provider.modelsDevId = "definitely-not-a-models-dev-provider";
    });
    const { code, output } = runGuard();
    expect(output).toContain("but the snapshot was generated from");
    expect(code).toBe(1);
  });

  it("FAILS when an entry is both exempt and mapped", () => {
    mutateProviders((config) => {
      const { provider } = firstProvider(config);
      provider.modelsDevExempt = true;
    });
    const { code, output } = runGuard();
    expect(output).toContain("BOTH");
    expect(code).toBe(1);
  });

  it("PASSES when a provider opts out explicitly", () => {
    mutateProviders((config) => {
      const { provider } = firstProvider(config);
      provider.modelsDevId = undefined;
      provider.modelsDevExempt = true;
    });
    const { code, output } = runGuard();
    expect(output).toContain("clean");
    expect(code).toBe(0);
  });
});

function provider(modelsDevId: string): ProviderConfigEntry {
  return {
    displayName: modelsDevId,
    iconUrl: "",
    envVarName: "TEST_API_KEY",
    upstreamBaseUrl: "https://example.com",
    apiKeyInstructions: "",
    apiKeyPlaceholder: "",
    modelsDevId,
  };
}

describe("buildSnapshot", () => {
  it("projects and deterministically sorts a many-to-one provider join", () => {
    const config: ProvidersConfigFile = {
      providers: [
        { id: "first", name: "First", providers: [provider("shared")] },
        { id: "second", name: "Second", providers: [provider("shared")] },
      ],
    };
    const upstream = {
      shared: {
        models: {
          undated: { name: "Undated" },
          older: { release_date: "2025-01-01", tool_call: false },
          latest: {
            release_date: "2026-01-01",
            name: "Latest",
            limit: { context: 1000, output: 200 },
            cost: { input: 1, output: 2 },
            tool_call: true,
            reasoning: true,
          },
        },
      },
    };

    const { snapshot, unresolved } = buildSnapshot(
      config,
      upstream,
      "2026-07-27"
    );

    expect(unresolved).toEqual([]);
    expect(snapshot.joinedFrom).toEqual({
      first: "shared",
      second: "shared",
    });
    expect(snapshot.providers.first?.map((model) => model.id)).toEqual([
      "latest",
      "older",
      "undated",
    ]);
    expect(snapshot.providers.second).toEqual(snapshot.providers.first);
    expect(snapshot.providers.first?.[0]).toEqual({
      id: "latest",
      name: "Latest",
      contextLimit: 1000,
      outputLimit: 200,
      costInput: 1,
      costOutput: 2,
      toolCall: true,
      reasoning: true,
      releaseDate: "2026-01-01",
    });
  });

  it("reports a mapped provider missing upstream", () => {
    const config: ProvidersConfigFile = {
      providers: [
        { id: "missing", name: "Missing", providers: [provider("gone")] },
      ],
    };

    const { snapshot, unresolved } = buildSnapshot(config, {}, "2026-07-27");

    expect(unresolved).toEqual(["missing -> gone"]);
    expect(snapshot.providers).toEqual({});
    expect(snapshot.joinedFrom).toEqual({});
  });
});

/**
 * The weekly refresh workflow opens a PR whenever the snapshot file differs.
 * `generatedAt` moves on every run, so without ignoring it a no-change week
 * would open an empty churn PR every Monday — and a reviewer trained to
 * rubber-stamp those is exactly how a bad upstream merge lands unread.
 */
describe("sameModelData", () => {
  const base: ModelsDevSnapshot = {
    source: "https://models.dev/api.json",
    generatedAt: "2026-07-27",
    providers: { claude: [{ id: "claude-opus-5", name: "Claude Opus 5" }] },
    joinedFrom: { claude: "anthropic" },
  };

  it("ignores a moved generatedAt stamp", () => {
    expect(sameModelData(base, { ...base, generatedAt: "2026-08-03" })).toBe(
      true
    );
  });

  it("detects an added model", () => {
    const next: ModelsDevSnapshot = {
      ...base,
      generatedAt: "2026-08-03",
      providers: {
        claude: [
          { id: "claude-opus-6", name: "Claude Opus 6" },
          ...base.providers.claude,
        ],
      },
    };
    expect(sameModelData(base, next)).toBe(false);
  });

  it("detects a dropped provider", () => {
    expect(sameModelData(base, { ...base, providers: {} })).toBe(false);
  });

  /** A renamed upstream key must not be mistaken for "nothing changed". */
  it("detects a changed join key", () => {
    expect(
      sameModelData(base, { ...base, joinedFrom: { claude: "anthropic-v2" } })
    ).toBe(false);
  });

  it("detects changed model metadata", () => {
    const next: ModelsDevSnapshot = {
      ...base,
      providers: {
        claude: [{ id: "claude-opus-5", name: "Claude Opus 5", costInput: 5 }],
      },
    };
    expect(sameModelData(base, next)).toBe(false);
  });
});
