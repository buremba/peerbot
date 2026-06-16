import { describe, expect, it } from "bun:test";
import { configsEqual } from "../../gateway/connections/config-equal";

// The agent-config update route uses configsEqual to decide whether a platform
// update is a noop or must restart the adapter. It previously used a SHALLOW
// compare, which compared nested objects by reference — so re-submitting an
// identical config (a fresh object built per request) looked "changed" and
// triggered a spurious adapter restart. configsEqual is deep + key-order
// independent so an unchanged config is correctly a noop.

// The old shallow logic, kept here to prove the regression it caused.
function shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

describe("configsEqual", () => {
  it("regression: identical nested config is equal (no spurious restart)", () => {
    // A freshly-built request body with the same Discord OAuth block + scopes.
    const previous = {
      platform: "discord",
      oauth: { clientId: "abc", clientSecret: "***" },
      scopes: ["bot", "messages.read"],
    };
    const resubmitted = {
      platform: "discord",
      oauth: { clientId: "abc", clientSecret: "***" },
      scopes: ["bot", "messages.read"],
    };

    // The bug: shallow compared the nested oauth/scopes by reference → "changed".
    expect(shallowEqual(resubmitted, previous)).toBe(false);
    // The fix: deep compare sees they are structurally identical → noop.
    expect(configsEqual(resubmitted, previous)).toBe(true);
  });

  it("is independent of object key insertion order", () => {
    expect(
      configsEqual(
        { a: 1, nested: { x: 1, y: 2 } },
        { nested: { y: 2, x: 1 }, a: 1 }
      )
    ).toBe(true);
  });

  it("detects a changed nested field", () => {
    expect(
      configsEqual({ oauth: { clientId: "abc" } }, { oauth: { clientId: "xyz" } })
    ).toBe(false);
  });

  it("treats array order as significant (scope lists)", () => {
    expect(configsEqual({ scopes: ["a", "b"] }, { scopes: ["b", "a"] })).toBe(
      false
    );
  });

  it("detects added or removed keys", () => {
    expect(configsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(configsEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });
});
