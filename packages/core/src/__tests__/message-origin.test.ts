/**
 * MessageOrigin — the trusted, signed authorization-origin enum (PR-D0).
 *
 * The security contract is FAIL-CLOSED: any value that is not one of the three
 * known origins — undefined (a legacy payload/token), a non-string, a typo, or
 * a future/unknown origin — must resolve to `agent` (the most-restrictive), and
 * must NEVER read as `interactive_human`. A missing origin can never authorize a
 * human-gated action (e.g. `!`-shell). These tests pin that, and prove the
 * origin round-trips through the signed worker token.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken, verifyWorkerToken } from "../worker/auth";
import { __resetEncryptionKeyCacheForTests } from "../utils/encryption";
import {
  isAutomationOrigin,
  isInteractiveHumanOrigin,
  resolveMessageOrigin,
} from "../worker/wire";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("resolveMessageOrigin — fail-closed", () => {
  test("passes through the three known origins", () => {
    expect(resolveMessageOrigin("interactive_human")).toBe("interactive_human");
    expect(resolveMessageOrigin("headless")).toBe("headless");
    expect(resolveMessageOrigin("agent")).toBe("agent");
  });

  test("resolves every unknown/absent/non-string value to agent", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "human", // a plausible-but-wrong string must NOT read as human
      "interactive-human", // wrong separator
      "INTERACTIVE_HUMAN", // wrong case
      "user",
      "direct-api", // a legacy source string is NOT an origin
      42,
      {},
      [],
      true,
    ]) {
      expect(resolveMessageOrigin(bad)).toBe("agent");
    }
  });

  test("isInteractiveHumanOrigin is true ONLY for the exact human origin", () => {
    expect(isInteractiveHumanOrigin("interactive_human")).toBe(true);
    for (const bad of ["headless", "agent", undefined, "human", "direct-api"]) {
      expect(isInteractiveHumanOrigin(bad)).toBe(false);
    }
  });

  test("isAutomationOrigin is the inverse — true for everything non-human", () => {
    expect(isAutomationOrigin("interactive_human")).toBe(false);
    for (const nonHuman of ["headless", "agent", undefined, "nonsense", null]) {
      expect(isAutomationOrigin(nonHuman)).toBe(true);
    }
  });
});

describe("origin round-trips through the signed worker token", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
    __resetEncryptionKeyCacheForTests();
  });
  afterEach(() => {
    process.env.ENCRYPTION_KEY = undefined;
    __resetEncryptionKeyCacheForTests();
  });

  test("a signed interactive_human origin verifies back intact", () => {
    const token = generateWorkerToken("u", "c", "deploy", {
      channelId: "ch",
      origin: "interactive_human",
    });
    expect(verifyWorkerToken(token)?.origin).toBe("interactive_human");
  });

  test("a token minted without origin (legacy) reads fail-closed to agent", () => {
    const token = generateWorkerToken("u", "c", "deploy", { channelId: "ch" });
    const data = verifyWorkerToken(token);
    expect(data?.origin).toBeUndefined();
    // The CONSUMER resolves it fail-closed — a legacy token is never a human.
    expect(resolveMessageOrigin(data?.origin)).toBe("agent");
    expect(isInteractiveHumanOrigin(data?.origin)).toBe(false);
  });
});
