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

/**
 * Decode a candidate ENCRYPTION_KEY string into 32 canonical bytes, or
 * return null if it doesn't satisfy the canonical base64 / base64url /
 * hex 32-byte format. Pure (no env, no cache, no throw) so callers like
 * the install-operator bootstrap can fail-fast with a clear message
 * before any side effect.
 */
export function decodeEncryptionKey(key: string): Buffer | null {
  if (!key) return null;

  // Try to decode as base64 first (most common format). `Buffer.from(x,
  // "base64")` silently drops non-base64 chars rather than throwing, so a
  // typo'd key can yield a short/garbled buffer. Require canonical base64 and
  // a clean round-trip before trusting the decoded bytes.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(key) && key.length % 4 === 0) {
    const base64Buffer = Buffer.from(key, "base64");
    if (base64Buffer.length === 32 && base64Buffer.toString("base64") === key) {
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
      return hexBuffer;
    }
  }

  return null;
}

/**
 * Canonical error message for a malformed ENCRYPTION_KEY. Centralised so
 * the install-operator bootstrap and any other upstream validator emit
 * the exact same actionable text the runtime encrypt/decrypt path would.
 */
export const ENCRYPTION_KEY_FORMAT_ERROR =
  "ENCRYPTION_KEY must be a canonical base64 or hex encoded 32-byte key. " +
  "Generate a valid key with: openssl rand -base64 32 (or openssl rand -hex 32)";

/**
 * Validate `process.env.ENCRYPTION_KEY` (or an explicit override) without
 * caching. Throws with an actionable message if the value is missing or
 * not a canonical 32-byte encoding. Use at boot to fail fast instead of
 * letting later encrypt/decrypt calls return 500s.
 */
export function assertEncryptionKey(value?: string): void {
  const key = value ?? process.env.ENCRYPTION_KEY ?? "";
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required for secure operation"
    );
  }
  if (!decodeEncryptionKey(key)) {
    throw new Error(ENCRYPTION_KEY_FORMAT_ERROR);
  }
}

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const key = process.env.ENCRYPTION_KEY || "";
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is required for secure operation"
    );
  }
  const decoded = decodeEncryptionKey(key);
  if (!decoded) {
    throw new Error(ENCRYPTION_KEY_FORMAT_ERROR);
  }
  cachedKey = decoded;
  return decoded;
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

/**
 * Encrypt raw bytes using AES-256-GCM, returning ONE base64 string over
 * `iv || tag || ciphertext`.
 *
 * The string-oriented {@link encrypt} above emits hex (2x) and only accepts
 * utf8, so a binary payload has to be base64'd first — 2.67x expansion for
 * something already compressed. Bulk artifacts (tool-invocation snapshots)
 * use this instead: one encoding, 1.33x, no intermediate string.
 *
 * Base64 rather than a `bytea` column on purpose: the server's postgres.js
 * runs with `fetch_types: false`, so a bytea round-trip comes back as an
 * unparsed `\x…` string rather than a Buffer.
 */
export function encryptBytes(bytes: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/** Inverse of {@link encryptBytes}. Throws on a truncated or tampered payload. */
export function decryptBytes(payload: string): Buffer {
  const raw = Buffer.from(payload, "base64");
  // 12-byte IV + 16-byte GCM tag. EXACTLY that length is the valid encryption
  // of empty input, so only a SHORTER payload is malformed.
  if (raw.length < IV_LENGTH + 16) throw new Error("Invalid encrypted format");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    raw.subarray(0, IV_LENGTH)
  );
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + 16));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_LENGTH + 16)),
    decipher.final(),
  ]);
}

/**
 * Short stable fingerprint of the active ENCRYPTION_KEY.
 *
 * Stored alongside anything encrypted for long-term retention so a read can
 * tell "this predates the current key" (answer: unavailable) apart from "this
 * is corrupt" (answer: error). Without it a key rotation — or a boot under
 * `LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1`, which mints a fresh random key each
 * time — turns every historical row into a 500. A digest of the key is not the
 * key: it leaks nothing usable and never varies for a given install.
 */
export function encryptionKeyFingerprint(): string {
  return crypto
    .createHash("sha256")
    .update(getEncryptionKey())
    .digest("hex")
    .slice(0, 16);
}

/** Test-only: clear the memoized encryption key (e.g. after mutating ENCRYPTION_KEY). */
export function __resetEncryptionKeyCacheForTests(): void {
  cachedKey = undefined;
}
