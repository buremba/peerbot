import * as crypto from "node:crypto";

const IV_LENGTH = 12; // 96-bit nonce for AES-GCM

/**
 * Get encryption key from environment with validation
 *
 * IMPORTANT: The ENCRYPTION_KEY must be exactly 32 bytes (256 bits) for AES-256.
 * Generate a secure key using: `openssl rand -base64 32` or `openssl rand -hex 32`
 */
// The encryption key is immutable for the lifetime of the process; derive it
// once and reuse the buffer instead of re-parsing the env var on every
// encrypt/decrypt call (these run on per-request / per-worker-RPC hot paths).
let cachedKey: Buffer | undefined;

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const key = process.env.ENCRYPTION_KEY || "";
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required for secure operation"
    );
  }

  // Try to decode as base64 first (most common format). `Buffer.from(x,
  // "base64")` silently drops non-base64 chars rather than throwing, so a
  // typo'd key can yield a short/garbled buffer. Require canonical base64 and
  // a clean round-trip before trusting the decoded bytes.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(key) && key.length % 4 === 0) {
    const base64Buffer = Buffer.from(key, "base64");
    if (base64Buffer.length === 32 && base64Buffer.toString("base64") === key) {
      cachedKey = base64Buffer;
      return base64Buffer;
    }
  }

  // Try as URL-safe base64 (alphabet [A-Za-z0-9_-], no padding). Historically
  // some keys were generated as `openssl rand -base64 32 | tr +/ -_` and stored
  // in this form; same 32 bytes, just a different alphabet. Apply the same
  // round-trip check so typos still get rejected.
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    const urlsafeBuffer = Buffer.from(key, "base64url");
    if (
      urlsafeBuffer.length === 32 &&
      urlsafeBuffer.toString("base64url") === key
    ) {
      cachedKey = urlsafeBuffer;
      return urlsafeBuffer;
    }
  }

  // Try as hex (must be exactly 64 hex characters for 32 bytes), again
  // verifying the round-trip so partially-valid input is rejected.
  if (/^[0-9a-fA-F]+$/.test(key) && key.length % 2 === 0) {
    const hexBuffer = Buffer.from(key, "hex");
    if (
      hexBuffer.length === 32 &&
      hexBuffer.toString("hex") === key.toLowerCase()
    ) {
      cachedKey = hexBuffer;
      return hexBuffer;
    }
  }

  throw new Error(
    "ENCRYPTION_KEY must be a canonical base64 or hex encoded 32-byte key. " +
      "Generate a valid key with: openssl rand -base64 32 (or openssl rand -hex 32)"
  );
}

/**
 * Encrypt a string using AES-256-GCM
 */
export function encrypt(text: string): string {
  const encryptionKey = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a string encrypted with AES-256-GCM
 */
export function decrypt(text: string): string {
  const encryptionKey = getEncryptionKey();
  const parts = text.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const iv = Buffer.from(parts[0]!, "hex");
  const tag = Buffer.from(parts[1]!, "hex");
  const encryptedText = Buffer.from(parts[2]!, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encryptedText),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Test-only: clear the memoized encryption key (e.g. after mutating ENCRYPTION_KEY). */
export function __resetEncryptionKeyCacheForTests(): void {
  cachedKey = undefined;
}
