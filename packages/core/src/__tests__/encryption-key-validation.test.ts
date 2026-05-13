import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decrypt, encrypt } from "../utils/encryption";

// Regression coverage for ENCRYPTION_KEY parsing: `Buffer.from(x, "base64")`
// silently drops invalid characters, so a typo'd key could yield a short or
// garbled key. Parsing must round-trip and length-check before trusting it.
describe("ENCRYPTION_KEY validation", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  test("non-base64, non-hex junk key throws", () => {
    process.env.ENCRYPTION_KEY = "this is not a valid key!! @#$%";
    expect(() => encrypt("x")).toThrow("ENCRYPTION_KEY");
  });

  test("base64 string decoding to fewer than 32 bytes throws", () => {
    // 16 bytes → 24-char canonical base64; passes the regex but is too short.
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 9).toString("base64");
    expect(() => encrypt("x")).toThrow("ENCRYPTION_KEY");
  });

  test("non-canonical base64 (chars that get silently dropped) throws", () => {
    // Contains chars outside [A-Za-z0-9+/]; old code would drop them.
    process.env.ENCRYPTION_KEY = `${Buffer.alloc(32, 1).toString("base64")}!!`;
    expect(() => encrypt("x")).toThrow("ENCRYPTION_KEY");
  });

  test("valid 32-byte base64 key round-trips encrypt/decrypt", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
    const enc = encrypt("base64 secret");
    expect(decrypt(enc)).toBe("base64 secret");
  });

  test("valid 64-char hex key round-trips encrypt/decrypt", () => {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const enc = encrypt("hex secret");
    expect(decrypt(enc)).toBe("hex secret");
  });

  test("uppercase 64-char hex key round-trips encrypt/decrypt", () => {
    process.env.ENCRYPTION_KEY =
      "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
    const enc = encrypt("hex upper secret");
    expect(decrypt(enc)).toBe("hex upper secret");
  });
});
