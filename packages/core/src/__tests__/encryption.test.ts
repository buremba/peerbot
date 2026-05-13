import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  decrypt,
  encrypt,
} from "../utils/encryption";

describe("encryption", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    // 32-byte hex key
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    __resetEncryptionKeyCacheForTests();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
    __resetEncryptionKeyCacheForTests();
  });

  test("encrypt/decrypt round-trip preserves plaintext", () => {
    const plaintext = "hello world";
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  test("encrypt/decrypt works with empty string", () => {
    const encrypted = encrypt("");
    expect(decrypt(encrypted)).toBe("");
  });

  test("encrypt/decrypt works with unicode", () => {
    const text = "こんにちは 🌍 émojis";
    expect(decrypt(encrypt(text))).toBe(text);
  });

  test("encrypt/decrypt works with long text", () => {
    const text = "x".repeat(10_000);
    expect(decrypt(encrypt(text))).toBe(text);
  });

  test("each encryption produces different ciphertext (random IV)", () => {
    const plaintext = "same input";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
    // Both should still decrypt to the same value
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  test("encrypted format is iv:tag:ciphertext (3 hex parts)", () => {
    const encrypted = encrypt("test");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(3);
    // Each part should be valid hex
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  test("decrypt throws on invalid format (wrong number of parts)", () => {
    expect(() => decrypt("only-one-part")).toThrow("Invalid encrypted format");
    expect(() => decrypt("a:b")).toThrow("Invalid encrypted format");
    expect(() => decrypt("a:b:c:d")).toThrow("Invalid encrypted format");
  });

  test("decrypt throws on tampered ciphertext", () => {
    const encrypted = encrypt("secret");
    const parts = encrypted.split(":");
    // Tamper with the ciphertext
    parts[2] = "ff".repeat(parts[2]!.length / 2);
    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  test("throws when ENCRYPTION_KEY is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("test")).toThrow(
      "ENCRYPTION_KEY environment variable is required"
    );
  });

  test("throws when ENCRYPTION_KEY has wrong length", () => {
    process.env.ENCRYPTION_KEY = "too-short";
    expect(() => encrypt("test")).toThrow("base64 or hex encoded 32-byte key");
  });

  test("accepts base64-encoded 32-byte key", () => {
    // 32 bytes → 44 chars in base64
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encrypt("base64 key test");
    expect(decrypt(encrypted)).toBe("base64 key test");
  });

  test("rejects utf8 32-byte key (only base64 and hex accepted)", () => {
    process.env.ENCRYPTION_KEY = "abcdefghijklmnopqrstuvwxyz012345";
    // 32 ASCII chars = 32 bytes in utf8, but utf8 keys are no longer accepted
    expect(() => encrypt("utf8 key test")).toThrow(
      "base64 or hex encoded 32-byte key"
    );
  });
});
