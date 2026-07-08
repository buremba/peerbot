import { describe, expect, test } from "bun:test";
import { extractDeclaredConnectorKey } from "../desired-state.js";
import { locallyDeclaredConnectorKeys } from "../apply-cmd.js";
import type { DesiredState } from "../desired-state.js";

describe("extractDeclaredConnectorKey", () => {
  test("pulls the connector key from a readonly definition literal", () => {
    const src = [
      "export default class LinkedInConnector extends ConnectorRuntime {",
      "  readonly definition: ConnectorDefinition = {",
      `    key: "linkedin",`,
      `    name: "LinkedIn",`,
      "    feeds: {",
      `      home_feed: { key: "home_feed" },`,
      `      connections: { key: "connections" },`,
      "    },",
      "  };",
      "}",
    ].join("\n");
    // Must return the CONNECTOR key, not the first nested feed key.
    expect(extractDeclaredConnectorKey(src)).toBe("linkedin");
  });

  test("handles a dotted key and single quotes", () => {
    const src = `readonly definition = {\n  key: 'linkedin.takeout',\n};`;
    expect(extractDeclaredConnectorKey(src)).toBe("linkedin.takeout");
  });

  test("returns null when no definition block is present", () => {
    expect(extractDeclaredConnectorKey("const x = 1;")).toBeNull();
  });

  test("is not fooled by an earlier unrelated key: property", () => {
    const src = [
      `const other = { key: "not-it" };`,
      "readonly definition: ConnectorDefinition = {",
      `  key: "the-real-key",`,
      "};",
    ].join("\n");
    expect(extractDeclaredConnectorKey(src)).toBe("the-real-key");
  });
});

describe("locallyDeclaredConnectorKeys — includes declaredKeyHint", () => {
  test("a connectorFromFile source (key null) contributes its hint to the skip set", () => {
    const state = {
      connectors: {
        definitions: [
          {
            key: null,
            declaredKeyHint: "linkedin",
            sourcePath: "/abs/linkedin.connector.ts",
            sourceFile: "linkedin.connector.ts",
          },
          { key: "revolut", sourceFile: "revolut.connector.ts" },
        ],
        authProfiles: [],
        connections: [],
      },
    } as unknown as DesiredState;
    const keys = locallyDeclaredConnectorKeys(state);
    expect(keys.has("linkedin")).toBe(true); // from the hint (key is null)
    expect(keys.has("revolut")).toBe(true); // from the resolved key
  });
});
