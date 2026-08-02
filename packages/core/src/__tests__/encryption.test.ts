import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  decrypt,
  decryptBytes,
  encrypt,
  encryptBytes,
  encryptionKeyFingerprint,
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

  describe("binary payloads (encryptBytes / decryptBytes)", () => {
    test("round-trips arbitrary bytes, including non-utf8", () => {
      const payload = Buffer.from([0x00, 0xff, 0x1f, 0x8b, 0x80, 0xfe, 0x7f]);
      expect(decryptBytes(encryptBytes(payload))).toEqual(payload);
    });

    test("round-trips empty input — IV+tag with no ciphertext is valid", () => {
      // The encryption of zero bytes is exactly IV(12)+tag(16). A `<=` length
      // guard would reject its own output here.
      expect(decryptBytes(encryptBytes(Buffer.alloc(0))).length).toBe(0);
    });

    test("emits one base64 string, not the hex triple `encrypt` uses", () => {
      const out = encryptBytes(Buffer.from("payload"));
      expect(out).not.toContain(":");
      expect(out).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    });

    test("rejects a flipped authentication tag", () => {
      const raw = Buffer.from(encryptBytes(Buffer.from("tamper me")), "base64");
      raw[12] ^= 0xff; // first byte of the GCM tag
      expect(() => decryptBytes(raw.toString("base64"))).toThrow();
    });

    test("rejects a truncated payload", () => {
      expect(() => decryptBytes(Buffer.alloc(27).toString("base64"))).toThrow(
        "Invalid encrypted format"
      );
    });

    test("does not decrypt under a different key", () => {
      const sealed = encryptBytes(Buffer.from("bound to a key"));
      process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
      __resetEncryptionKeyCacheForTests();
      expect(() => decryptBytes(sealed)).toThrow();
    });
  });

  describe("encryptionKeyFingerprint", () => {
    test("is stable for a key and differs across keys", () => {
      const first = encryptionKeyFingerprint();
      expect(encryptionKeyFingerprint()).toBe(first);

      process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
      __resetEncryptionKeyCacheForTests();
      expect(encryptionKeyFingerprint()).not.toBe(first);
    });

    test("is a short digest, never the key material itself", () => {
      const key = process.env.ENCRYPTION_KEY as string;
      const fingerprint = encryptionKeyFingerprint();
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(key).not.toContain(fingerprint);
    });
  });
});
