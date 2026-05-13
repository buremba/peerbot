import { describe, expect, it } from "bun:test";
import { OrchestratorError } from "@lobu/core";
import { nixPackageAttrRef } from "../../gateway/orchestration/impl/embedded-deployment";

describe("nixPackageAttrRef", () => {
  it("accepts plain leaf package names", () => {
    expect(nixPackageAttrRef("ripgrep")).toBe("pkgs.ripgrep");
    expect(nixPackageAttrRef("jq")).toBe("pkgs.jq");
    expect(nixPackageAttrRef("python3")).toBe("pkgs.python3");
    expect(nixPackageAttrRef("chromium")).toBe("pkgs.chromium");
  });

  it("accepts leaf package names containing underscores", () => {
    expect(nixPackageAttrRef("poppler_utils")).toBe("pkgs.poppler_utils");
    expect(nixPackageAttrRef("csvtk")).toBe("pkgs.csvtk");
    expect(nixPackageAttrRef("cairo_2")).toBe("pkgs.cairo_2");
  });

  it("accepts known-namespace attr paths", () => {
    expect(nixPackageAttrRef("python3Packages.requests")).toBe(
      "pkgs.python3Packages.requests"
    );
    expect(nixPackageAttrRef("nodePackages.typescript")).toBe(
      "pkgs.nodePackages.typescript"
    );
  });

  it("rejects Nix-expression injection via shell metacharacters", () => {
    expect(() => nixPackageAttrRef("pkgs.x; touch /tmp/pwn")).toThrow(
      OrchestratorError
    );
    expect(() => nixPackageAttrRef("pkgs;builtins.exec")).toThrow(
      OrchestratorError
    );
    expect(() => nixPackageAttrRef("foo_bar;builtins.exec")).toThrow(
      OrchestratorError
    );
  });

  it("rejects boolean/operator expressions", () => {
    expect(() => nixPackageAttrRef("a && b")).toThrow(OrchestratorError);
  });

  it("rejects import expressions", () => {
    expect(() => nixPackageAttrRef("import ./evil.nix")).toThrow(
      OrchestratorError
    );
  });

  it("rejects dotted attr paths outside the known namespace allowlist", () => {
    expect(() => nixPackageAttrRef("pkgs.fetchurl")).toThrow(OrchestratorError);
    expect(() => nixPackageAttrRef("builtins.exec")).toThrow(OrchestratorError);
  });

  it("rejects nested attr paths even within a known namespace", () => {
    expect(() =>
      nixPackageAttrRef("python3Packages.foo.bar")
    ).toThrow(OrchestratorError);
  });

  it("rejects empty and uppercase-only leaf names", () => {
    expect(() => nixPackageAttrRef("")).toThrow(OrchestratorError);
    expect(() => nixPackageAttrRef("RipGrep")).toThrow(OrchestratorError);
  });
});
