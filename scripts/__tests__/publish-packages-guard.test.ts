/**
 * @lobu/worker@14.3.0 shipped to the registry declaring runtime dependencies on
 * five private workspace packages at their `0.0.0` placeholder versions,
 * breaking external installs (issue #2186).
 *
 * The cause was `rewriteWorkspaceRefs` resolving `workspace:*` against whatever
 * version it read off disk without checking the target is published.
 */

import { describe, expect, it } from "bun:test";
import { __testing, rewriteWorkspaceRefs } from "../publish-packages.mjs";

function workerManifest() {
  return {
    name: "@lobu/worker",
    version: "14.3.0",
    dependencies: {
      "@lobu/core": "workspace:*",
      "@lobu/plugin-api": "workspace:*",
      "@lobu/plugin-host": "workspace:*",
      "@lobu/plugin-mcp": "workspace:*",
      "@lobu/plugin-memory": "workspace:*",
    },
  };
}

describe("rewriteWorkspaceRefs publishability guard", () => {
  it("refuses a runtime dependency on a package the script does not publish", () => {
    expect(() => rewriteWorkspaceRefs(workerManifest())).toThrow(
      /@lobu\/plugin-mcp/
    );
  });

  it("names the offending package and both remedies, not just 'failed'", () => {
    let message = "";
    try {
      rewriteWorkspaceRefs(workerManifest());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("@lobu/worker");
    expect(message).toContain("@lobu/plugin-mcp");
    expect(message).toContain("bundling");
    expect(message).toContain("PACKAGES");
  });

  it("guards every runtime dependency section, including explicit versions", () => {
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      expect(() =>
        rewriteWorkspaceRefs({
          name: "@lobu/worker",
          version: "14.3.0",
          [section]: { "@lobu/plugin-mcp": "1.2.3" },
        })
      ).toThrow(/@lobu\/plugin-mcp/);
    }
  });

  it("still rewrites refs when every runtime dependency is published", () => {
    const pkg = rewriteWorkspaceRefs({
      name: "@lobu/cli",
      version: "14.3.0",
      dependencies: { "@lobu/core": "workspace:*" },
    }) as { dependencies: Record<string, string> };
    // Resolved to the real on-disk version, and no longer a workspace: ref.
    expect(pkg.dependencies["@lobu/core"]).not.toContain("workspace:");
    expect(pkg.dependencies["@lobu/core"]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("allows a private workspace package as a devDependency", () => {
    // devDependencies are not installed by consumers, so a private dev-only
    // tool is legitimate and must not trip the guard.
    const pkg = rewriteWorkspaceRefs({
      name: "@lobu/cli",
      version: "14.3.0",
      dependencies: {},
      devDependencies: { "@lobu/plugin-mcp": "workspace:*" },
    }) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["@lobu/plugin-mcp"]).not.toContain("workspace:");
  });

  it("still rejects a workspace ref outside the @lobu scope", () => {
    expect(() =>
      rewriteWorkspaceRefs({
        name: "@lobu/cli",
        version: "14.3.0",
        dependencies: { "some-other-pkg": "workspace:*" },
      })
    ).toThrow(/outside @lobu scope/);
  });
});

describe("blocked-dependency skip ordering", () => {
  it("lists PACKAGES so dependencies precede their dependents", () => {
    // The skip logic relies on seeing a blocked dependency before any package
    // that depends on it. If PACKAGES is ever reordered, dependents would be
    // published against a missing dependency again.
    const order = __testing.PACKAGES.map((p: { dir: string }) => p.dir);
    const indexOf = (dir: string) => order.indexOf(dir);
    for (const { dir } of __testing.PACKAGES) {
      for (const dep of __testing.lobuRuntimeDeps(dir)) {
        const depDir = __testing.PACKAGES.find(
          (p: { dir: string }) => __testing.packageNameFor(p.dir) === dep
        )?.dir;
        if (!depDir) continue; // Unpublished dep — the guard above covers it.
        expect(indexOf(depDir)).toBeLessThan(indexOf(dir));
      }
    }
  });

  it("propagates an unavailable package to transitive dependents", () => {
    const unavailable = new Set(["@lobu/missing"]);
    expect(
      __testing.markUnavailablePackage(
        "@lobu/direct-dependent",
        ["@lobu/missing"],
        unavailable
      )
    ).toEqual({
      name: "@lobu/direct-dependent",
      missingDeps: ["@lobu/missing"],
    });
    expect(
      __testing.markUnavailablePackage(
        "@lobu/transitive-dependent",
        ["@lobu/direct-dependent"],
        unavailable
      )
    ).toEqual({
      name: "@lobu/transitive-dependent",
      missingDeps: ["@lobu/direct-dependent"],
    });
  });
});
