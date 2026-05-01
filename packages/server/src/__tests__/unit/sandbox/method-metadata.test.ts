import { describe, expect, it } from "bun:test";
import {
  BANNED_PATHS,
  METHOD_METADATA,
  type MethodAccess,
} from "../../../sandbox/method-metadata";
import { buildClientSDK } from "../../../sandbox/client-sdk";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";

const testEnv: Env = { ENVIRONMENT: "test" } as Env;
const testCtx: ToolContext = {
  organizationId: "test-org",
  userId: "test-user",
  memberRole: "owner",
  isAuthenticated: true,
  tokenType: "oauth",
  scopedToOrg: false,
  allowCrossOrg: true,
};

function enumerateSdkMethods(): { namespaceMethods: string[]; topLevelMethods: string[] } {
  const sdk = buildClientSDK(testCtx, testEnv);
  const namespaceMethods: string[] = [];
  const topLevelMethods: string[] = [];

  for (const [name, value] of Object.entries(sdk)) {
    if (typeof value === "function") {
      topLevelMethods.push(name);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const method of Object.keys(value)) {
      namespaceMethods.push(`${name}.${method}`);
    }
  }

  return { namespaceMethods, topLevelMethods };
}

describe("method-metadata", () => {
  it("has metadata for every namespace method", () => {
    const { namespaceMethods } = enumerateSdkMethods();
    const missing = namespaceMethods.filter((path) => !(path in METHOD_METADATA));
    expect(missing).toEqual([]);
  });

  it("has entries for top-level methods", () => {
    const { topLevelMethods } = enumerateSdkMethods();
    for (const m of topLevelMethods) {
      expect(METHOD_METADATA).toHaveProperty(m);
    }
  });

  it("has valid access levels on every entry", () => {
    const valid: MethodAccess[] = ["read", "write", "external"];
    for (const [path, meta] of Object.entries(METHOD_METADATA)) {
      expect(valid).toContain(meta.access);
      expect(meta.summary.length).toBeGreaterThan(0);
      if (meta.example) {
        expect(meta.example).toContain("client.");
      }
      void path;
    }
  });

  it("uses dotted path keys", () => {
    for (const path of Object.keys(METHOD_METADATA)) {
      expect(path).toMatch(/^[a-zA-Z]+(\.[a-zA-Z]+)?$/);
    }
  });

  it("never exposes banned paths", () => {
    for (const banned of BANNED_PATHS) {
      expect(METHOD_METADATA).not.toHaveProperty(banned);
    }
  });

  it("classifies external side-effects correctly for known methods", () => {
    expect(METHOD_METADATA["operations.execute"].access).toBe("external");
    expect(METHOD_METADATA["feeds.trigger"].access).toBe("external");
    expect(METHOD_METADATA["watchers.trigger"].access).toBe("external");
    expect(METHOD_METADATA["connections.test"].access).toBe("external");
    expect(METHOD_METADATA["authProfiles.test"].access).toBe("external");
  });

  it("classifies reads correctly for known methods", () => {
    expect(METHOD_METADATA["entities.list"].access).toBe("read");
    expect(METHOD_METADATA["watchers.list"].access).toBe("read");
    expect(METHOD_METADATA["organizations.list"].access).toBe("read");
  });

  it("does not claim SQL positional parameters in the query example", () => {
    const example = METHOD_METADATA.query.example ?? "";
    expect(example).not.toMatch(/\$\d+/);
  });
});
