/**
 * Tests for `lobu export`.
 *
 * Covers the canonical round-trip: server state → YAML + sibling reaction-
 * script `.ts` files that `lobu apply` can read back. Network is stubbed
 * through a fetch impl that returns the canned responses listWatchers /
 * listEntityTypes / etc. would normally produce. The CLI's auth resolution
 * still runs, so we set the right env vars to avoid hitting the keyring.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, parseAllDocuments } from "yaml";
import { exportCommand } from "../export-cmd.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lobu-export-"));
  tempDirs.push(dir);
  return dir;
}

function buildFetch(routes: Record<string, () => unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(handler()), { status: 200 });
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const ORIG_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    "LOBU_API_URL",
    "LOBU_TOKEN",
    "LOBU_ORG",
    "LOBU_CONTEXT_DIR",
  ]) {
    ORIG_ENV[key] = process.env[key];
  }
  process.env.LOBU_API_URL = "https://example.test";
  process.env.LOBU_TOKEN = "test-token";
  process.env.LOBU_ORG = "acme";
});

afterEach(() => {
  for (const [key, val] of Object.entries(ORIG_ENV)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

describe("lobu export", () => {
  test("writes models bundle with entity / relationship / watcher docs", async () => {
    const out = mkTempDir();
    const fetchImpl = buildFetch({
      manage_entity_schema: () => ({
        entity_types: [
          {
            slug: "lead",
            name: "Lead",
            description: "A sales lead",
            required: ["stage"],
            properties: { stage: { type: "string" } },
          },
        ],
        relationship_types: [
          {
            slug: "converted-to",
            name: "Converted To",
            description: "Lead → Pilot",
            rules: [{ source: "lead", target: "pilot" }],
          },
        ],
      }),
      "watchers?watcher_id": () => ({
        watcher: { reaction_script: null, description: null },
      }),
      "watchers?include_details": () => ({
        watchers: [
          {
            slug: "weekly-digest",
            watcher_id: "1",
            name: "Weekly digest",
            agent_id: "triage",
            prompt: "Produce a digest.",
            extraction_schema: { type: "object" },
            schedule: "0 9 * * 1",
            sources: [{ name: "content", query: "SELECT * FROM events" }],
            tags: ["crm"],
            device_worker_id: null,
            notification_priority: "normal",
            notification_channel: "canvas",
            min_cooldown_seconds: 0,
          },
        ],
      }),
      auth_profiles: () => ({ auth_profiles: [] }),
      manage_connections: () => ({ connections: [] }),
    });

    await exportCommand({
      cwd: out,
      out,
      fetchImpl,
      only: "models",
    });

    const bundleRaw = readFileSync(
      join(out, "models", "exported.yaml"),
      "utf-8"
    );
    const bundle = parseYaml(bundleRaw) as {
      version: number;
      entities?: unknown[];
      relationships?: unknown[];
      watchers?: Array<Record<string, unknown>>;
    };
    expect(bundle.version).toBe(2);
    expect(bundle.entities?.length).toBe(1);
    expect(bundle.relationships?.length).toBe(1);
    expect(bundle.watchers?.length).toBe(1);
    const watcher = bundle.watchers?.[0]!;
    expect(watcher.slug).toBe("weekly-digest");
    expect(watcher.agent).toBe("triage");
    expect(watcher.prompt).toBe("Produce a digest.");
    expect(watcher.tags).toEqual(["crm"]);
    // Default scalar values are omitted from the exported YAML so the file
    // stays minimal — assert they don't appear unless overridden.
    expect(watcher.notification_priority).toBeUndefined();
    expect(watcher.notification_channel).toBeUndefined();
    expect(watcher.min_cooldown_seconds).toBeUndefined();
  });

  test("watcher with reaction_script → writes sibling .ts and references it", async () => {
    const out = mkTempDir();
    const fetchImpl = buildFetch({
      manage_entity_schema: () => ({
        entity_types: [],
        relationship_types: [],
      }),
      "watchers?watcher_id": () => ({
        watcher: {
          reaction_script: "export default async (ctx, client) => {};\n",
          description: null,
        },
      }),
      "watchers?include_details": () => ({
        watchers: [
          {
            slug: "with-reaction",
            watcher_id: "42",
            agent_id: "triage",
            prompt: "Work.",
            extraction_schema: { type: "object" },
          },
        ],
      }),
    });

    await exportCommand({
      cwd: out,
      out,
      fetchImpl,
      only: "models",
    });

    const reactionBody = readFileSync(
      join(out, "models", "reactions", "with-reaction.reaction.ts"),
      "utf-8"
    );
    expect(reactionBody).toContain("export default async");

    const bundle = parseYaml(
      readFileSync(join(out, "models", "exported.yaml"), "utf-8")
    ) as { watchers: Array<Record<string, unknown>> };
    expect(bundle.watchers[0]?.reaction_script).toBe(
      "./reactions/with-reaction.reaction.ts"
    );
  });

  test("connections export writes type:connection + type:auth_profile docs (creds redacted)", async () => {
    const out = mkTempDir();
    const fetchImpl = buildFetch({
      manage_entity_schema: () => ({
        entity_types: [],
        relationship_types: [],
      }),
      "watchers?include_details": () => ({ watchers: [] }),
      auth_profiles: () => ({
        auth_profiles: [
          {
            slug: "gh-token",
            display_name: "GitHub Token",
            connector_key: "github",
            profile_kind: "env",
            status: "active",
          },
        ],
      }),
      manage_connections: () => ({
        connections: [
          {
            id: 7,
            slug: "gh-main",
            connector_key: "github",
            display_name: "GitHub main",
            status: "active",
            auth_profile_slug: "gh-token",
            config: { repo: "lobu-ai/lobu" },
            device_worker_id: null,
          },
        ],
      }),
      manage_feeds: () => ({ feeds: [] }),
    });

    await exportCommand({ cwd: out, out, fetchImpl });

    const raw = readFileSync(join(out, "connectors", "exported.yaml"), "utf-8");
    const docs = parseAllDocuments(raw)
      .map((d) => d.toJSON())
      .filter((d) => d !== null);
    expect(docs.length).toBe(2);
    const profileDoc = docs.find((d) => d.type === "auth_profile");
    const connDoc = docs.find((d) => d.type === "connection");
    expect(profileDoc?.slug).toBe("gh-token");
    expect(profileDoc?.kind).toBe("env");
    // Credentials must never appear in the exported doc — the server doesn't
    // expose them, and even if it did the CLI should never emit them.
    expect("credentials" in (profileDoc ?? {})).toBe(false);
    expect(connDoc?.slug).toBe("gh-main");
    expect(connDoc?.connector).toBe("github");
    expect(connDoc?.auth).toBe("gh-token");
    expect(connDoc?.config).toEqual({ repo: "lobu-ai/lobu" });
  });

  test("skips reaction file when it already exists AND omits the YAML reference", async () => {
    // Regression: previously, export would skip overwriting an existing
    // local reaction file but still emit `reaction_script: ./reactions/...`
    // in the YAML — re-applying would then upload whatever stale code was
    // on disk instead of the server's actual script. Now the reference is
    // dropped when we don't overwrite, and a warning is printed.
    const out = mkTempDir();
    await mkdir(join(out, "models", "reactions"), { recursive: true });
    const localScript = "// stale local version\nexport default async () => {};\n";
    writeFileSync(
      join(out, "models", "reactions", "with-reaction.reaction.ts"),
      localScript,
    );

    const fetchImpl = buildFetch({
      manage_entity_schema: () => ({
        entity_types: [],
        relationship_types: [],
      }),
      "watchers?watcher_id": () => ({
        watcher: {
          reaction_script: "export default async () => 'NEW SERVER VERSION';\n",
          description: null,
        },
      }),
      "watchers?include_details": () => ({
        watchers: [
          {
            slug: "with-reaction",
            watcher_id: "42",
            agent_id: "triage",
            prompt: "Work.",
            extraction_schema: { type: "object" },
          },
        ],
      }),
    });

    await exportCommand({ cwd: out, out, fetchImpl, only: "models" });

    // Local script is untouched.
    expect(
      readFileSync(
        join(out, "models", "reactions", "with-reaction.reaction.ts"),
        "utf-8",
      ),
    ).toBe(localScript);

    // YAML does NOT reference reaction_script.
    const bundle = parseYaml(
      readFileSync(join(out, "models", "exported.yaml"), "utf-8"),
    ) as { watchers: Array<Record<string, unknown>> };
    expect(bundle.watchers[0]?.reaction_script).toBeUndefined();
  });

  test("does not clobber existing files unless --force", async () => {
    const out = mkTempDir();
    await mkdir(join(out, "models"), { recursive: true });
    const bundlePath = join(out, "models", "exported.yaml");
    writeFileSync(bundlePath, "pre-existing\n");

    const fetchImpl = buildFetch({
      manage_entity_schema: () => ({
        entity_types: [],
        relationship_types: [],
      }),
      "watchers?include_details": () => ({ watchers: [] }),
    });

    await exportCommand({ cwd: out, out, fetchImpl, only: "models" });
    expect(readFileSync(bundlePath, "utf-8")).toBe("pre-existing\n");

    await exportCommand({
      cwd: out,
      out,
      fetchImpl,
      only: "models",
      force: true,
    });
    expect(readFileSync(bundlePath, "utf-8")).not.toBe("pre-existing\n");
  });
});
