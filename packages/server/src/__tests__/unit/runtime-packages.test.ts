import { describe, expect, test } from "bun:test";
import {
  NIX_SUBSTITUTER_DOMAINS,
  nixPackageSetHash,
  sanitizeNixPackages,
} from "../../gateway/runtime/packages.js";

describe("sanitizeNixPackages", () => {
  test("keeps valid nixpkgs attribute references", () => {
    expect(sanitizeNixPackages(["gh", "ripgrep", "python3Packages.requests"])).toEqual([
      "gh",
      "python3Packages.requests",
      "ripgrep",
    ]);
  });

  test("drops names that would be evaluated as Nix or shell", () => {
    // Same payloads the shared `nixPackageAttrRef` suite covers — asserted here
    // too because THIS is the function standing between a signed claim and a
    // command line, and the two must never drift apart silently.
    expect(
      sanitizeNixPackages([
        "gh",
        "x; touch /tmp/pwn",
        "$(id)",
        "a && b",
        "import ./evil.nix",
        "builtins.exec",
        "pkgs.fetchurl",
        "`whoami`",
        "RipGrep",
        "",
      ])
    ).toEqual(["gh"]);
  });

  test("drops non-string entries and non-array inputs", () => {
    expect(sanitizeNixPackages(["gh", 42, null, { name: "gh" }])).toEqual(["gh"]);
    expect(sanitizeNixPackages("gh")).toEqual([]);
    expect(sanitizeNixPackages(undefined)).toEqual([]);
    expect(sanitizeNixPackages({ packages: ["gh"] })).toEqual([]);
  });

  test("deduplicates and sorts so the set is order-independent", () => {
    expect(sanitizeNixPackages(["ripgrep", "gh", "gh"])).toEqual([
      "gh",
      "ripgrep",
    ]);
  });
});

describe("nixPackageSetHash", () => {
  test("is stable across declaration order and duplicates", () => {
    // Connections resolve in row order, so two orgs with the same tools in a
    // different order must not reprovision each other's sandboxes.
    expect(nixPackageSetHash(["gh", "ripgrep"])).toBe(
      nixPackageSetHash(["ripgrep", "gh", "gh"])
    );
  });

  test("changes when the set changes", () => {
    expect(nixPackageSetHash(["gh"])).not.toBe(nixPackageSetHash(["gh", "jq"]));
    expect(nixPackageSetHash(["gh"])).not.toBe(nixPackageSetHash([]));
  });

  test("ignores names the sanitizer drops", () => {
    // Otherwise an invalid name would change the marker on every turn and
    // force a reinstall of a set that is in fact identical.
    expect(nixPackageSetHash(["gh", "x; rm -rf /"])).toBe(
      nixPackageSetHash(["gh"])
    );
  });
});

describe("NIX_SUBSTITUTER_DOMAINS", () => {
  test("matches the hosts the local nix path already grants", () => {
    // Kept in lockstep with NIX_CACHE_DOMAINS in the deployment manager: the
    // same declaration must resolve on every backend, so a host the local path
    // needs is a host the remote path needs too.
    expect(NIX_SUBSTITUTER_DOMAINS).toEqual([
      "cache.nixos.org",
      "channels.nixos.org",
      "releases.nixos.org",
    ]);
  });
});
