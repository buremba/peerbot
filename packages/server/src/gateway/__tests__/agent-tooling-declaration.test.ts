/**
 * `agent_tooling` is a jsonb column written by the connector install path, so
 * the resolver reads it as untrusted structure. A malformed declaration must
 * contribute NOTHING rather than push a non-string into the worker environment
 * or onto the nix command line.
 */

import { describe, expect, test } from "bun:test";
import { parseAgentTooling } from "../agent-tooling/resolver.js";

describe("parseAgentTooling", () => {
  test("accepts a full declaration", () => {
    expect(
      parseAgentTooling({
        nix: { packages: ["gh"] },
        env: [{ name: "GH_TOKEN", credential: "lease" }],
        domains: ["api.github.com", "github.com"],
      })
    ).toEqual({
      nix: { packages: ["gh"] },
      env: [{ name: "GH_TOKEN", credential: "lease" }],
      domains: ["api.github.com", "github.com"],
    });
  });

  test("drops reserved worker env names, in any casing", () => {
    // The deployment manager merges the contribution OVER an already-built base
    // env, so a contributed WORKER_TOKEN would replace the signed gateway
    // credential (and inherit the lease exemption from placeholder injection).
    // Proxy vars are honored by curl/git in lowercase too, hence the casing mix.
    expect(
      parseAgentTooling({
        env: [
          { name: "WORKER_TOKEN", credential: "lease" },
          { name: "PATH", credential: "lease" },
          { name: "HOME", credential: "lease" },
          { name: "DISPATCHER_URL", credential: "lease" },
          { name: "WORKSPACE_DIR", credential: "lease" },
          { name: "http_proxy", credential: "lease" },
          { name: "NODE_OPTIONS", credential: "lease" },
          { name: "LD_PRELOAD", credential: "lease" },
          { name: "NIX_PATH", credential: "lease" },
          { name: "GH_TOKEN", credential: "lease" },
        ],
      })
    ).toEqual({ env: [{ name: "GH_TOKEN", credential: "lease" }] });
  });

  test("a reserved-only declaration contributes nothing", () => {
    expect(
      parseAgentTooling({ env: [{ name: "WORKER_TOKEN", credential: "lease" }] })
    ).toBeNull();
  });

  test("accepts a packages-only declaration", () => {
    expect(parseAgentTooling({ nix: { packages: ["jq"] } })).toEqual({
      nix: { packages: ["jq"] },
    });
  });

  test("drops the retired placeholder credential tier", () => {
    // 'placeholder' was removed before ship: the egress proxy raw-tunnels
    // HTTPS CONNECT, so a placeholder in a CLI env var would reach the
    // provider verbatim. A persisted declaration using it contributes nothing.
    expect(
      parseAgentTooling({ env: [{ name: "API_KEY", credential: "placeholder" }] })
    ).toBeNull();
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "gh"],
    ["an array", [{ nix: { packages: ["gh"] } }]],
    ["an empty object", {}],
    ["a declaration with only empty arrays", { nix: { packages: [] }, domains: [] }],
  ])("contributes nothing for %s", (_label, value) => {
    expect(parseAgentTooling(value)).toBeNull();
  });

  test("drops invalid packages, env names, and non-string domains", () => {
    expect(
      parseAgentTooling({
        nix: {
          packages: ["gh", 42, null, "", { evil: true }, "pkgs;builtins.exec"],
        },
        env: [
          { name: "GOOD_TOKEN", credential: "lease" },
          { name: "__proto__", credential: "lease" },
          { name: "BAD-NAME", credential: "lease" },
        ],
        domains: ["github.com", 7, ""],
      })
    ).toEqual({
      nix: { packages: ["gh"] },
      env: [{ name: "GOOD_TOKEN", credential: "lease" }],
      domains: ["github.com"],
    });
  });

  test("drops domains that would widen egress beyond a hostname", () => {
    // These reach the worker's deny-by-default allowlist verbatim, so a
    // malformed entry must contribute nothing rather than everything.
    expect(
      parseAgentTooling({
        domains: [
          "api.github.com",
          "*.github.com",
          "*",
          "*.com",
          "localhost",
          "https://evil.com/x",
          "github.com/evil",
          "github.com:443",
          "a.com, b.com",
          "  spaced.com  ",
        ],
      })
    ).toEqual({ domains: ["api.github.com", "*.github.com", "spaced.com"] });
  });

  test("drops an env entry with an unrecognized credential tier", () => {
    // Defaulting an unknown tier to 'lease' would try to mint for a provider
    // that cannot derive tokens; dropping it keeps the failure visible (the
    // CLI reports unauthenticated) instead of guessing.
    expect(
      parseAgentTooling({
        env: [
          { name: "GOOD", credential: "lease" },
          { name: "BAD", credential: "raw" },
          { name: "ALSO_BAD" },
          { credential: "lease" },
          "nope",
        ],
      })
    ).toEqual({ env: [{ name: "GOOD", credential: "lease" }] });
  });

  test("a declaration whose only env entry is malformed contributes nothing", () => {
    expect(parseAgentTooling({ env: [{ name: "X", credential: "raw" }] })).toBeNull();
  });
});
