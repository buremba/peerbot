/**
 * `lobu rollback` snapshot handling: the stored manifest is redacted and
 * byte-free, and sanitization converts every redaction sentinel into
 * "keep current" — a rollback restores intent and structurally cannot push a
 * secret (or the literal sentinel) anywhere.
 */

import { describe, expect, test } from "bun:test";
import { REDACTED_SENTINEL } from "@lobu/core";
import type { DesiredState } from "../desired-state.js";
import { buildDeploymentManifest } from "../deployment.js";
import { sanitizeSnapshotState } from "../rollback-cmd.js";

function stateWithSecrets(): DesiredState {
  return {
    agents: [
      {
        metadata: { agentId: "a1", name: "A1" },
        settings: null,
        platforms: [
          {
            platform: "telegram",
            config: { botToken: "1234:real-token", chatId: "42" },
          },
          { platform: "slack", config: { channel: "#general" } },
        ],
        providerKeys: [{ providerId: "anthropic", value: "sk-ant-real" }],
      },
    ],
    prune: false,
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    watchers: [],
    connectors: {
      definitions: [
        {
          key: "zz.probe",
          sourceFile: "probe.connector.ts",
          sourceCode: "export default class Probe {}",
        },
      ],
      authProfiles: [
        {
          slug: "gh-main",
          connector: "github",
          credentials: { token: "ghp_real" },
        },
      ],
      connections: [
        {
          slug: "pg-main",
          connector: "postgres",
          config: { api_key: "conn-secret", database: "prod" },
        },
        { slug: "hn-main", connector: "hackernews", config: { top: 10 } },
      ],
    },
    providers: [
      { slug: "z-ai", kind: "z-ai", apiKey: "sk-live-1", capabilities: {} },
    ],
    requiredSecrets: [],
  } as unknown as DesiredState;
}

describe("buildDeploymentManifest", () => {
  test("redacts secrets, drops connector source bytes, keeps version pins", () => {
    const manifest = buildDeploymentManifest(stateWithSecrets(), {
      "zz.probe": "1.2.0",
    });
    expect(manifest.version).toBe(1);
    expect(manifest.connector_versions).toEqual({ "zz.probe": "1.2.0" });

    const raw = JSON.stringify(manifest);
    // No secret VALUE and no source byte survives into the stored snapshot.
    expect(raw).not.toContain("sk-ant-real");
    expect(raw).not.toContain("ghp_real");
    expect(raw).not.toContain("sk-live-1");
    expect(raw).not.toContain("1234:real-token");
    expect(raw).not.toContain("export default class Probe");
    // The declaration shape survives for labels.
    expect(raw).toContain("probe.connector.ts");
    // Non-secret platform config survives (rollback restores it).
    expect(raw).toContain("#general");
  });
});

describe("sanitizeSnapshotState", () => {
  function snapshotState() {
    return buildDeploymentManifest(stateWithSecrets(), {}).state;
  }

  test("converts sentinels to keep-current: credentials, provider keys, connector defs", () => {
    const { state } = sanitizeSnapshotState(snapshotState(), new Map());
    // Connector definitions ride the version pins, never the diff.
    expect(state.connectors.definitions).toEqual([]);
    // Credentials undeclared → the diff never re-pushes them.
    expect(
      (state.connectors.authProfiles[0] as { credentials?: unknown })
        .credentials
    ).toBeUndefined();
    // Provider keys: nothing to push.
    expect(state.agents[0]?.providerKeys).toEqual([]);
    // Org provider key empty → keyDeclared=false → no rotate.
    expect(state.providers?.[0]?.apiKey).toBe("");
  });

  test("pins a sentinel-bearing platform to its live remote config, drops it when none", () => {
    const remote = new Map([
      ["a1:telegram", { botToken: "secret://live", chatId: "42" }],
    ]);
    const pinned = sanitizeSnapshotState(snapshotState(), remote);
    const platforms = pinned.state.agents[0]?.platforms as Array<{
      platform: string;
      config?: Record<string, unknown>;
    }>;
    // telegram (sentinel-bearing) pinned to the remote config verbatim…
    expect(platforms.find((p) => p.platform === "telegram")?.config).toEqual({
      botToken: "secret://live",
      chatId: "42",
    });
    // …slack (no secrets) restored from the snapshot untouched.
    expect(platforms.find((p) => p.platform === "slack")?.config).toEqual({
      channel: "#general",
    });
    expect(pinned.notes.some((n) => n.includes("a1:telegram"))).toBe(true);

    // No live platform to pin to → dropped with a note, never pushed.
    const dropped = sanitizeSnapshotState(snapshotState(), new Map());
    const droppedPlatforms = dropped.state.agents[0]?.platforms as Array<{
      platform: string;
    }>;
    expect(droppedPlatforms.map((p) => p.platform)).toEqual(["slack"]);
    expect(dropped.notes.some((n) => n.includes("skipped"))).toBe(true);
    // The sentinel itself never survives sanitization anywhere.
    expect(JSON.stringify(pinned.state)).not.toContain(REDACTED_SENTINEL);
    expect(JSON.stringify(dropped.state)).not.toContain(REDACTED_SENTINEL);
  });

  test("pins a sentinel-bearing connection config to remote, drops it when none", () => {
    const remoteConnections = new Map([
      ["pg-main", { api_key: "***live", database: "prod" }],
    ]);
    const pinned = sanitizeSnapshotState(
      snapshotState(),
      new Map(),
      remoteConnections
    );
    const connections = pinned.state.connectors.connections as Array<{
      slug: string;
      config?: Record<string, unknown>;
    }>;
    // pg-main (denylisted api_key redacted in the snapshot) pinned to live…
    expect(connections.find((c) => c.slug === "pg-main")?.config).toEqual({
      api_key: "***live",
      database: "prod",
    });
    // …hn-main (no secrets) restored from the snapshot untouched.
    expect(connections.find((c) => c.slug === "hn-main")?.config).toEqual({
      top: 10,
    });

    // No live connection to pin to → dropped with a note.
    const dropped = sanitizeSnapshotState(snapshotState(), new Map());
    const droppedSlugs = (
      dropped.state.connectors.connections as Array<{ slug: string }>
    ).map((c) => c.slug);
    expect(droppedSlugs).toEqual(["hn-main"]);
    expect(JSON.stringify(pinned.state)).not.toContain(REDACTED_SENTINEL);
    expect(JSON.stringify(dropped.state)).not.toContain(REDACTED_SENTINEL);
  });
});
