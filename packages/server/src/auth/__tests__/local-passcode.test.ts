/**
 * Local-passcode unit tests — the boot passcode generation + the
 * constant-time verification used by POST /api/local-passcode. No DB needed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  generateLocalPasscode,
  getLocalPasscode,
  verifyLocalPasscode,
} from "../local-passcode";

const dataDir = mkdtempSync(join(tmpdir(), "lobu-passcode-"));

describe("generateLocalPasscode", () => {
  beforeEach(() => {
    generateLocalPasscode(dataDir);
  });

  test("produces a high-entropy url-safe string and caches it", () => {
    const code = getLocalPasscode();
    expect(code).toBeTruthy();
    expect(code!.length).toBeGreaterThanOrEqual(32);
    expect(code!).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  });

  test("regenerates a different passcode each call", () => {
    const first = getLocalPasscode();
    generateLocalPasscode(dataDir);
    expect(getLocalPasscode()).not.toBe(first);
  });
});

describe("verifyLocalPasscode", () => {
  beforeEach(() => {
    generateLocalPasscode(dataDir);
  });

  test("accepts the exact current passcode", () => {
    expect(verifyLocalPasscode(getLocalPasscode()!)).toBe(true);
  });

  test("rejects a wrong passcode of equal length", () => {
    const code = getLocalPasscode()!;
    const wrong = `${code.slice(0, -1)}${code.at(-1) === "A" ? "B" : "A"}`;
    expect(wrong).toHaveLength(code.length);
    expect(verifyLocalPasscode(wrong)).toBe(false);
  });

  test("rejects a length mismatch without throwing (timingSafeEqual guard)", () => {
    expect(verifyLocalPasscode(`${getLocalPasscode()}extra`)).toBe(false);
    expect(verifyLocalPasscode("short")).toBe(false);
  });

  test("rejects an empty submission", () => {
    expect(verifyLocalPasscode("")).toBe(false);
  });
});
