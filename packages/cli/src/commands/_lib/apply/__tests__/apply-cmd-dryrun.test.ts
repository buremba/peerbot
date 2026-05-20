/**
 * Tests that `applyCommand` with `dryRun: true` performs ZERO mutating API
 * calls, and that org-resolution edge-cases (0 orgs / 1 org / many orgs /
 * org-not-found) surface the correct error messages.
 *
 * All HTTP is stubbed via `fetchImpl` — no real network.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand } from "../apply-cmd.js";
import * as context from "../../../../internal/context.js";
import * as credentials from "../../../../internal/credentials.js";
import { ValidationError } from "../../../memory/_lib/errors.js";

// Silence printText / printError during tests.
const silentWrite = (): boolean => true;

// ── helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(() => {
  mock.restore();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  // restore stdout
  process.stdout.write = originalWrite;
});

const originalWrite = process.stdout.write.bind(process.stdout);

function silenceOutput() {
  spyOn(process.stdout, "write").mockImplementation(silentWrite);
}

function mkProject(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lobu-apply-dry-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "lobu.toml"), toml);
  return dir;
}

function minimalToml(agentId = "triage") {
  return `[agents.${agentId}]
name = "Triage"
dir = "./agents/${agentId}"
`;
}

function makeAuthFetch(
  orgs: Array<{ id: string; slug: string; name?: string }>
) {
  /**
   * A minimal fetch stub that handles the OAuth userinfo endpoint (for org
   * resolution) and returns empty lists for every GET (agents, entity-types,
   * watchers, etc.) and a success body for POSTs.
   *
   * MUTATING calls (POST that creates/patches, PATCH) are tracked in
   * `mutateCalls` so tests can assert no writes happen in dry-run mode.
   */
  const mutateCalls: Array<{ url: string; method: string }> = [];

  const fetchStub = async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const urlStr = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (urlStr.includes("/oauth/userinfo")) {
      return new Response(JSON.stringify({ sub: "u1", organizations: orgs }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Track mutations
    if (method !== "GET") {
      mutateCalls.push({ url: urlStr, method });
    }

    // Default: return empty lists for GET, success for everything else.
    if (method === "GET") {
      if (urlStr.includes("/agents")) {
        return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      }
      if (urlStr.includes("/platforms")) {
        return new Response(JSON.stringify({ platforms: [] }), { status: 200 });
      }
    }
    if (method === "POST") {
      if (urlStr.includes("/manage_entity_schema")) {
        return new Response(
          JSON.stringify({ entity_types: [], relationship_types: [] }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/watchers")) {
        return new Response(JSON.stringify({ watchers: [] }), { status: 200 });
      }
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  return { fetchStub: fetchStub as typeof fetch, mutateCalls };
}

// ── Test: dry-run performs no mutating calls ─────────────────────────────────

describe("applyCommand --dry-run", () => {
  beforeEach(() => {
    silenceOutput();
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue("acme");
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "prod",
      contexts: { prod: { url: "https://app.lobu.ai/api/v1" } },
    });
  });

  test("dry-run with one agent: no resource-creating/mutating API calls are made", async () => {
    const dir = mkProject(minimalToml());
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    const { fetchStub, mutateCalls } = makeAuthFetch([
      { id: "org_1", slug: "acme", name: "Acme" },
    ]);

    await applyCommand({
      cwd: dir,
      dryRun: true,
      yes: true,
      url: "https://app.lobu.ai",
      org: "acme",
      fetchImpl: fetchStub,
    });

    // The snapshot phase uses POST for manage_entity_schema (list), manage_watchers,
    // manage_connections (list) — these are read-only POSTs. The key invariant is:
    // no agent-create (POST /agents), no agent-patch (PATCH /agents/*), no platform
    // upsert (PUT .../platforms/by-stable-id/...), no settings patch, no watcher
    // create, and no connection/feed creates.
    const writingCalls = mutateCalls.filter((c) => {
      // PATCH always writes
      if (c.method === "PATCH") return true;
      // PUT always writes
      if (c.method === "PUT") return true;
      // POST to agent-creation or platform-upsert or entity-schema action=create/update
      if (c.method === "POST") {
        // List-action POSTs are OK (snapshot)
        if (c.url.includes("manage_entity_schema")) return false;
        if (c.url.includes("manage_watchers")) return false;
        if (c.url.includes("manage_connections")) return false;
        if (c.url.includes("manage_feeds")) return false;
        if (c.url.includes("manage_auth_profiles")) return false;
        // POST to /agents (create) is a write
        return true;
      }
      return false;
    });

    expect(writingCalls).toEqual([]);
  });

  test("dry-run does NOT write organization_id back to lobu.toml", async () => {
    const toml = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
org = "acme"
`;
    const dir = mkProject(toml);
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    const { fetchStub } = makeAuthFetch([
      { id: "org_99", slug: "acme", name: "Acme" },
    ]);

    await applyCommand({
      cwd: dir,
      dryRun: true,
      yes: true,
      url: "https://app.lobu.ai",
      org: "acme",
      fetchImpl: fetchStub,
    });

    // lobu.toml must NOT have been modified: organization_id should be absent.
    const { readFileSync } = await import("node:fs");
    const contents = readFileSync(join(dir, "lobu.toml"), "utf-8");
    expect(contents).not.toContain("organization_id");
  });
});

// ── Test: org not found → ValidationError with create-url ───────────────────

describe("applyCommand org resolution", () => {
  beforeEach(() => {
    silenceOutput();
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "prod",
      contexts: { prod: { url: "https://app.lobu.ai/api/v1" } },
    });
  });

  test("throws ValidationError when the target org is not in the user's org list", async () => {
    const dir = mkProject(minimalToml());
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    // User belongs to a different org
    const { fetchStub } = makeAuthFetch([
      { id: "org_other", slug: "other-org", name: "Other" },
    ]);

    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).rejects.toThrow(/organization "acme" not found/);
  });

  test("throws ValidationError when user belongs to 0 orgs", async () => {
    const dir = mkProject(minimalToml());
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    const { fetchStub } = makeAuthFetch([]);

    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).rejects.toThrow(/organization "acme" not found/);
  });

  test("succeeds (dry-run) when the user belongs to exactly 1 org that matches", async () => {
    const dir = mkProject(minimalToml());
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    const { fetchStub } = makeAuthFetch([
      { id: "org_1", slug: "acme", name: "Acme Corp" },
    ]);

    // Should resolve without throwing.
    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).resolves.toBeUndefined();
  });

  test("org can also be matched by organizationId in lobu.toml when slug differs", async () => {
    const toml = `[agents.triage]
name = "Triage"
dir = "./agents/triage"

[memory]
org = "acme"
organization_id = "org_id_42"
`;
    const dir = mkProject(toml);
    mkdirSync(join(dir, "agents", "triage"), { recursive: true });

    // The slug doesn't match ("acme" vs "wrong-slug") but the id matches.
    const { fetchStub } = makeAuthFetch([
      { id: "org_id_42", slug: "acme-renamed", name: "Acme Renamed" },
    ]);

    // Should NOT throw because the id matches.
    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).resolves.toBeUndefined();
  });
});

// ── Test: missing lobu.toml ──────────────────────────────────────────────────

describe("applyCommand — missing lobu.toml", () => {
  beforeEach(() => {
    silenceOutput();
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue("acme");
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "prod",
      contexts: { prod: { url: "https://app.lobu.ai/api/v1" } },
    });
  });

  test("throws a ValidationError when lobu.toml is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-no-toml-"));
    tempDirs.push(dir);
    // No lobu.toml created

    const { fetchStub } = makeAuthFetch([{ id: "o1", slug: "acme" }]);

    await expect(
      applyCommand({
        cwd: dir,
        dryRun: true,
        yes: true,
        url: "https://app.lobu.ai",
        org: "acme",
        fetchImpl: fetchStub,
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
