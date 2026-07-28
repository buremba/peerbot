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

  test("accepts a packages-only declaration", () => {
    expect(parseAgentTooling({ nix: { packages: ["jq"] } })).toEqual({
      nix: { packages: ["jq"] },
    });
  });

  test("accepts the placeholder credential tier", () => {
    expect(
      parseAgentTooling({ env: [{ name: "API_KEY", credential: "placeholder" }] })
    ).toEqual({ env: [{ name: "API_KEY", credential: "placeholder" }] });
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
          { name: "BAD-NAME", credential: "placeholder" },
        ],
        domains: ["github.com", 7, ""],
      })
    ).toEqual({
      nix: { packages: ["gh"] },
      env: [{ name: "GOOD_TOKEN", credential: "lease" }],
      domains: ["github.com"],
    });
  });

  test("drops an env entry with an unrecognized credential tier", () => {
    // Guessing a tier is unsafe in both directions: defaulting to 'placeholder'
    // would route a lease var through the secret store, and defaulting to
    // 'lease' would try to mint for a provider that cannot derive tokens.
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
