import { describe, expect, it } from 'vitest';
import { deriveJwtSecret } from '../jwt';

describe('deriveJwtSecret', () => {
  it('is deterministic for a given ENCRYPTION_KEY (stable across restarts/replicas)', () => {
    // The whole point: a restart or a sibling replica must derive the SAME
    // signing secret so a window_token signed earlier/elsewhere still verifies.
    const key = 'test-encryption-key-0123456789abcdef';
    expect(deriveJwtSecret(key)).toBe(deriveJwtSecret(key));
  });

  it('differs per ENCRYPTION_KEY and is not the raw key', () => {
    const a = deriveJwtSecret('key-a');
    const b = deriveJwtSecret('key-b');
    expect(a).not.toBe(b);
    expect(a).not.toBe('key-a');
    // HMAC-SHA256 → 32 bytes → 44-char base64.
    expect(a).toHaveLength(44);
  });
});
