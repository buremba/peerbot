import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BUILD_MAC_SCRIPT = join(REPO_ROOT, "scripts/build-owletto-mac.sh");
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github/workflows/mac-release.yml");
const PACKAGE_SMOKE_SCRIPT = join(
  REPO_ROOT,
  "scripts/test-mac-device-daemon-package.sh"
);
const ENTITLEMENTS_FILE = join(
  REPO_ROOT,
  "config/macos/lobu-auth.entitlements"
);

describe("Mac device daemon codesigning entitlements guard", () => {
  it("verifies config/macos/lobu-auth.entitlements provides com.apple.security.cs.allow-jit", () => {
    const entitlements = readFileSync(ENTITLEMENTS_FILE, "utf8");
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("<true/>");
  });

  it("ensures build-owletto-mac.sh passes entitlements when codesigning DAEMON with runtime options", () => {
    const script = readFileSync(BUILD_MAC_SCRIPT, "utf8");
    expect(script).toMatch(
      /codesign\s+"\$\{OPTS\[@\]\}"\s+--entitlements\s+"\$AUTH_ENTITLEMENTS"\s+"\$DAEMON"/
    );
  });

  it("ensures mac-release.yml passes entitlements when codesigning DAEMON with runtime options", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf8");
    expect(workflow).toMatch(
      /codesign\s+"(?:\$\{OPTS\[@\]\}|"[^"]+")"\s+\\\s+--entitlements\s+config\/macos\/lobu-auth\.entitlements\s+\\\s+"\$DAEMON"/
    );
  });

  it("ensures test-mac-device-daemon-package.sh smokes Hardened Runtime with JIT entitlements", () => {
    const smoke = readFileSync(PACKAGE_SMOKE_SCRIPT, "utf8");
    expect(smoke).toContain("--options runtime");
    expect(smoke).toContain("lobu-auth.entitlements");
  });
});
