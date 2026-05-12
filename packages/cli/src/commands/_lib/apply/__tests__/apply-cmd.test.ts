import { describe, expect, test } from "bun:test";
import {
  locallyDeclaredConnectorKeys,
  readBoundedBody,
  validateConnectorState,
} from "../apply-cmd.js";
import type { RemoteConnectorDefinition } from "../client.js";
import type { DesiredState } from "../desired-state.js";

// Minimal DesiredState with just the connectors slice populated.
function stateWith(connectors: DesiredState["connectors"]): DesiredState {
  return {
    agents: [],
    memorySchema: { entityTypes: [], relationshipTypes: [] },
    watchers: [],
    connectors,
    requiredSecrets: [],
  };
}

function makeResponse(body: string): Response {
  // Use the real Web Response so it exposes a streaming `body`.
  return new Response(body, { headers: { "content-type": "text/plain" } });
}

describe("readBoundedBody (#3 — bounded source_url fetch)", () => {
  test("reads a small body in full", async () => {
    const text = await readBoundedBody(
      makeResponse("hello world"),
      1024,
      () => {
        throw new Error("should not overflow");
      }
    );
    expect(text).toBe("hello world");
  });

  test("aborts + throws as soon as the running byte total exceeds the cap", async () => {
    // 4 KiB body, 1 KiB cap.
    const big = "x".repeat(4096);
    let overflowed = false;
    await expect(
      readBoundedBody(makeResponse(big), 1024, () => {
        overflowed = true;
        throw new Error("body exceeds the 1024-byte cap");
      })
    ).rejects.toThrow(/exceeds the 1024-byte cap/);
    expect(overflowed).toBe(true);
  });

  test("counts BYTES, not UTF-16 code units (multi-byte chars)", async () => {
    // 200 "€" chars = 600 UTF-8 bytes but only 200 UTF-16 code units.
    const euros = "€".repeat(200);
    await expect(
      readBoundedBody(makeResponse(euros), 400, () => {
        throw new Error("body exceeds the 400-byte cap");
      })
    ).rejects.toThrow(/exceeds the 400-byte cap/);
    // Same content fits under a 1 KiB cap.
    const ok = await readBoundedBody(makeResponse(euros), 1024, () => {
      throw new Error("should not overflow");
    });
    expect(ok).toBe(euros);
  });
});

describe("validateConnectorState — skip stale schema for locally-declared keys (#2)", () => {
  const localDef = {
    key: "myconn",
    sourcePath: "/proj/connectors/myconn.connector.ts",
    sourceCode: "export default class {}",
    sourceFile: "connectors/myconn.connector.ts",
  };
  const connectors: DesiredState["connectors"] = {
    definitions: [localDef],
    authProfiles: [],
    connections: [
      {
        slug: "c1",
        connector: "myconn",
        // valid only against the *new* schema (string `mode`); the stale remote
        // schema below requires `mode` to be a number.
        config: { mode: "fast" },
        feeds: [],
        sourceFile: "connectors/myconn.yaml",
      },
    ],
  };
  // The "stale" installed catalog: `myconn` exists with an old optionsSchema
  // that would reject `{ mode: "fast" }`.
  const staleCatalog: RemoteConnectorDefinition[] = [
    {
      key: "myconn",
      installed: true,
      installable: false,
      options_schema: {
        type: "object",
        properties: { mode: { type: "number" } },
        required: ["mode"],
        additionalProperties: false,
      },
    },
  ];

  test("does NOT validate config against the stale schema when the key is locally declared", () => {
    expect(() =>
      validateConnectorState(stateWith(connectors), staleCatalog, {
        skipSchemaForConnectorKeys: locallyDeclaredConnectorKeys(
          stateWith(connectors)
        ),
      })
    ).not.toThrow();
  });

  test("WOULD reject the config if the key were not locally declared (sanity check)", () => {
    expect(() =>
      validateConnectorState(stateWith(connectors), staleCatalog)
    ).toThrow(/connection "c1" config/);
  });

  test("structural checks still run for locally-declared connectors (bad auth-profile ref)", () => {
    const bad: DesiredState["connectors"] = {
      definitions: [localDef],
      authProfiles: [],
      connections: [
        {
          slug: "c2",
          connector: "myconn",
          authProfileSlug: "nope", // not declared anywhere
          feeds: [],
          sourceFile: "connectors/myconn.yaml",
        },
      ],
    };
    expect(() =>
      validateConnectorState(stateWith(bad), staleCatalog, {
        skipSchemaForConnectorKeys: locallyDeclaredConnectorKeys(
          stateWith(bad)
        ),
      })
    ).toThrow(/references auth profile "nope"/);
  });

  test("requireInstalled: errors when a referenced connector is not in the fresh catalog", () => {
    const connectors: DesiredState["connectors"] = {
      definitions: [],
      authProfiles: [],
      connections: [
        {
          slug: "c-typo",
          connector: "doesnt-exist",
          feeds: [],
          sourceFile: "connectors/x.yaml",
        },
      ],
    };
    expect(() =>
      validateConnectorState(stateWith(connectors), [], {
        requireInstalled: true,
      })
    ).toThrow(
      /connector "doesnt-exist" referenced by connection "c-typo" is not installed/
    );
  });

  test("requireInstalled: errors when a referenced connector is present but not installed", () => {
    const connectors: DesiredState["connectors"] = {
      definitions: [],
      authProfiles: [],
      connections: [
        {
          slug: "c1",
          connector: "catalog-only",
          feeds: [],
          sourceFile: "connectors/x.yaml",
        },
      ],
    };
    // present in the catalog but installable-not-installed (e.g. a bundled
    // connector that was never installed for the org).
    expect(() =>
      validateConnectorState(
        stateWith(connectors),
        [{ key: "catalog-only", installed: false, installable: true }],
        { requireInstalled: true }
      )
    ).toThrow(
      /connector "catalog-only" referenced by connection "c1" is not installed/
    );
  });

  test("requireInstalled: passes when the referenced connector is installed", () => {
    const connectors: DesiredState["connectors"] = {
      definitions: [],
      authProfiles: [
        {
          slug: "ap",
          connector: "myconn",
          kind: "env",
          credentials: { K: "v" },
          sourceFile: "connectors/x.yaml",
        },
      ],
      connections: [
        {
          slug: "c1",
          connector: "myconn",
          authProfileSlug: "ap",
          feeds: [],
          sourceFile: "connectors/x.yaml",
        },
      ],
    };
    expect(() =>
      validateConnectorState(
        stateWith(connectors),
        [
          {
            key: "myconn",
            installed: true,
            installable: false,
            auth_schema: { methods: [{ type: "env_keys" }] },
          },
        ],
        { requireInstalled: true }
      )
    ).not.toThrow();
  });
});
