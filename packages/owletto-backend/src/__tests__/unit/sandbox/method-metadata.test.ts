import { describe, expect, it } from "bun:test";
import {
  BANNED_PATHS,
  METHOD_METADATA,
  type MethodAccess,
} from "../../../sandbox/method-metadata";

/**
 * Static surface description of every namespace method. Hand-maintained — when
 * a namespace adds a method, this list must add it too, and a metadata entry
 * must exist. The coverage test below enforces the latter.
 */
const NAMESPACE_METHODS: Record<string, readonly string[]> = {
  entities: [
    "list",
    "get",
    "create",
    "update",
    "delete",
    "link",
    "unlink",
    "updateLink",
    "listLinks",
    "search",
  ],
  entitySchema: [
    "listTypes",
    "getType",
    "createType",
    "updateType",
    "deleteType",
    "auditType",
    "listRelTypes",
    "getRelType",
    "createRelType",
    "updateRelType",
    "deleteRelType",
    "addRule",
    "removeRule",
    "listRules",
  ],
  connections: [
    "list",
    "listConnectorDefinitions",
    "get",
    "create",
    "connect",
    "update",
    "delete",
    "test",
    "installConnector",
    "uninstallConnector",
    "toggleConnectorLogin",
    "updateConnectorAuth",
  ],
  feeds: ["list", "get", "create", "update", "delete", "trigger"],
  authProfiles: ["list", "get", "test", "create", "update", "delete"],
  operations: [
    "listAvailable",
    "execute",
    "listRuns",
    "getRun",
    "approve",
    "reject",
  ],
  watchers: [
    "list",
    "get",
    "create",
    "update",
    "delete",
    "setReactionScript",
    "completeWindow",
  ],
  classifiers: [
    "list",
    "create",
    "createVersion",
    "getVersions",
    "setCurrentVersion",
    "generateEmbeddings",
    "delete",
    "classify",
  ],
  viewTemplates: ["get", "set", "rollback", "removeTab"],
  knowledge: ["search", "save", "read"],
  organizations: ["list", "current"],
};

/** Top-level SDK methods that aren't inside a namespace. */
const TOP_LEVEL_METHODS = ["query", "log", "org"] as const;

describe("method-metadata", () => {
  it("has at least one entry per namespace method", () => {
    const missing: string[] = [];
    for (const [ns, methods] of Object.entries(NAMESPACE_METHODS)) {
      for (const m of methods) {
        const key = `${ns}.${m}`;
        if (!(key in METHOD_METADATA)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has entries for top-level methods", () => {
    for (const m of TOP_LEVEL_METHODS) {
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
