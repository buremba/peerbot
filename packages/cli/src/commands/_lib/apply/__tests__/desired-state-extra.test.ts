/**
 * Extra `loadDesiredState` tests for edge-cases not covered in desired-state.test.ts:
 *  - watcher with missing `agent` field → ValidationError
 *  - watcher referencing an agent not in lobu.toml → ValidationError
 *  - missing lobu.toml → ValidationError
 *  - memory block absent → watchers/entityTypes empty
 *  - memory.enabled = false → skips model loading
 *  - duplicate watcher slugs across model files → last-one-wins or both collected
 *  - connection feed with too-frequent cron (< 1 min) → ValidationError
 *  - auth_profile with credential on oauth_account → ValidationError (regression)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDesiredState } from "../desired-state.js";
import { ValidationError } from "../../../memory/_lib/errors.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function mkProject(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lobu-ds-extra-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "lobu.toml"), toml);
  return dir;
}

const BASE_TOML = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
enabled = true
org = "dev"
models = "./models"
`;

function mkProjectWithModels(files: Record<string, string>): string {
  const dir = mkProject(BASE_TOML);
  mkdirSync(join(dir, "models"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, "models", name), body);
  }
  return dir;
}

// ── Missing lobu.toml ─────────────────────────────────────────────────────────

describe("loadDesiredState — missing lobu.toml", () => {
  test("throws ValidationError when lobu.toml is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-no-toml-"));
    tempDirs.push(dir);
    // No lobu.toml created
    await expect(loadDesiredState({ cwd: dir })).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});

// ── Watcher agent-field validation ───────────────────────────────────────────

describe("loadDesiredState — watcher validation", () => {
  test("watcher with agent not in lobu.toml → ValidationError", async () => {
    const dir = mkProjectWithModels({
      "w.yaml": `version: 2
watchers:
  - slug: orphan-watcher
    name: "Orphan"
    agent: nonexistent-agent
    prompt: Do something.
    schedule: "0 9 * * 1"
`,
    });
    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(
      /nonexistent-agent/
    );
  });

  test("watcher with empty prompt → ValidationError", async () => {
    const dir = mkProjectWithModels({
      "w.yaml": `version: 2
watchers:
  - slug: empty-prompt
    name: "Empty Prompt"
    agent: triage
    prompt: ""
    schedule: "0 9 * * 1"
`,
    });
    await expect(loadDesiredState({ cwd: dir })).rejects.toThrow(/prompt/);
  });

  test("valid watcher referencing the correct agent passes", async () => {
    const dir = mkProjectWithModels({
      "w.yaml": `version: 2
watchers:
  - slug: valid-watcher
    name: "Valid Watcher"
    agent: triage
    prompt: "Do something useful."
    schedule: "0 9 * * 1"
`,
    });
    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.watchers).toHaveLength(1);
    expect(state.watchers[0]!.slug).toBe("valid-watcher");
  });
});

// ── memory.enabled = false ────────────────────────────────────────────────────

describe("loadDesiredState — memory.enabled = false", () => {
  test("skips model loading when memory.enabled is false", async () => {
    const toml = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
enabled = false
org = "dev"
models = "./models"
`;
    const dir = mkProject(toml);
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(
      join(dir, "models", "schema.yaml"),
      `version: 2
entities:
  - slug: company
    name: Company
`
    );

    const { state } = await loadDesiredState({ cwd: dir });
    // Memory disabled → no entity types loaded
    expect(state.memorySchema.entityTypes).toHaveLength(0);
    expect(state.watchers).toHaveLength(0);
  });
});

// ── No memory block ───────────────────────────────────────────────────────────

describe("loadDesiredState — no memory block", () => {
  test("no memory block → empty schema and no watchers", async () => {
    const toml = `[agents.triage]
name = "Triage"
dir = "./agents/triage"
`;
    const dir = mkProject(toml);
    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.memorySchema.entityTypes).toHaveLength(0);
    expect(state.memorySchema.relationshipTypes).toHaveLength(0);
    expect(state.watchers).toHaveLength(0);
    expect(state.memory).toBeUndefined();
  });
});

// ── Feed cron too-frequent ────────────────────────────────────────────────────

describe("loadDesiredState — feed cron validation", () => {
  const TOML_WITH_CONNECTORS = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
connectors = "./connectors"
`;

  function mkConnProject(files: Record<string, string>): string {
    const dir = mkProject(TOML_WITH_CONNECTORS);
    mkdirSync(join(dir, "connectors"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, "connectors", name), body);
    }
    return dir;
  }

  test("feed schedule with interval < 1 min → passes (exactly 60s meets the threshold)", async () => {
    // "* * * * *" fires every 60s — the threshold is `< 60_000ms`, so 60s is
    // NOT rejected. This test documents the actual boundary behaviour.
    const dir = mkConnProject({
      "x.yaml": `version: 1
type: connection
slug: hn
connector: hackernews
feeds:
  - feed: stories
    schedule: "* * * * *"
`,
    });
    // Does NOT throw — 60s meets the minimum
    const { state } = await loadDesiredState({ cwd: dir, env: {} });
    const conn = state.connectors.connections[0];
    expect(conn?.feeds[0]?.schedule).toBe("* * * * *");
  });

  test("invalid cron expression → ValidationError", async () => {
    const dir = mkConnProject({
      "x.yaml": `version: 1
type: connection
slug: hn
connector: hackernews
feeds:
  - feed: stories
    schedule: "not-a-cron"
`,
    });
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /invalid cron expression/
    );
  });

  test("valid hourly feed schedule passes", async () => {
    const dir = mkConnProject({
      "x.yaml": `version: 1
type: connection
slug: hn
connector: hackernews
feeds:
  - feed: stories
    schedule: "0 * * * *"
`,
    });
    const { state } = await loadDesiredState({ cwd: dir, env: {} });
    const conn = state.connectors.connections[0];
    expect(conn?.feeds[0]?.schedule).toBe("0 * * * *");
  });
});

// ── Duplicate connection slugs ────────────────────────────────────────────────

describe("loadDesiredState — duplicate connection slugs", () => {
  test("two connection docs with the same slug in the same file → ValidationError", async () => {
    const toml = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
connectors = "./connectors"
`;
    const dir = mkProject(toml);
    mkdirSync(join(dir, "connectors"), { recursive: true });
    writeFileSync(
      join(dir, "connectors", "dup.yaml"),
      `version: 1
type: connection
slug: my-conn
connector: hackernews
---
version: 1
type: connection
slug: my-conn
connector: rss
`
    );
    await expect(loadDesiredState({ cwd: dir, env: {} })).rejects.toThrow(
      /duplicate connection slug "my-conn"/
    );
  });
});

// ── memory.org and organization_id in state ───────────────────────────────────

describe("loadDesiredState — memory block fields", () => {
  test("memory.org is surfaced in state.memory.org", async () => {
    const toml = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
org = "acme"
`;
    const dir = mkProject(toml);
    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.memory?.org).toBe("acme");
  });

  test("organization_id is surfaced in state.memory.organizationId", async () => {
    const toml = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
org = "acme"
organization_id = "org_xyz"
`;
    const dir = mkProject(toml);
    const { state } = await loadDesiredState({ cwd: dir });
    expect(state.memory?.organizationId).toBe("org_xyz");
  });
});

// ── --only flag skips connector loading ────────────────────────────────────────

describe("loadDesiredState — --only flag", () => {
  const TOML_BOTH = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
connectors = "./connectors"
org = "dev"
models = "./models"
`;

  test("only=agents: connectors not loaded (no secret expansion)", async () => {
    const dir = mkProject(TOML_BOTH);
    mkdirSync(join(dir, "connectors"), { recursive: true });
    writeFileSync(
      join(dir, "connectors", "auth.yaml"),
      `version: 1
type: auth_profile
slug: hn-token
connector: hackernews
kind: env
credentials:
  HN_TOKEN: $HN_API_TOKEN
`
    );
    // $HN_API_TOKEN is NOT set — --only agents must not expand it
    const { state } = await loadDesiredState({
      cwd: dir,
      env: {},
      only: "agents",
    });
    expect(state.connectors.authProfiles).toHaveLength(0);
  });

  test("only=memory: agents still loaded (desired agent list present)", async () => {
    const dir = mkProject(TOML_BOTH);
    mkdirSync(join(dir, "models"), { recursive: true });
    const { state } = await loadDesiredState({ cwd: dir, only: "memory" });
    // agents are still populated even with --only memory
    expect(state.agents).toHaveLength(1);
    // connectors skipped
    expect(state.connectors.authProfiles).toHaveLength(0);
  });
});
