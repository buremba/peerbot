import { afterEach, describe, expect, it } from 'vitest';
import { ensureEmbeddedGatewaySecrets } from '../../../lobu/gateway';

const ORIGINAL_ENV = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  OWLETTO_ALLOW_EPHEMERAL_ENCRYPTION_KEY: process.env.OWLETTO_ALLOW_EPHEMERAL_ENCRYPTION_KEY,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('ensureEmbeddedGatewaySecrets', () => {
  it('throws when REDIS-backed embedded mode has no stable encryption key', () => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.OWLETTO_ALLOW_EPHEMERAL_ENCRYPTION_KEY;

    expect(() => ensureEmbeddedGatewaySecrets()).toThrow(/ENCRYPTION_KEY is required/);
  });

  it('allows explicitly ephemeral encryption keys', () => {
    delete process.env.ENCRYPTION_KEY;
    process.env.OWLETTO_ALLOW_EPHEMERAL_ENCRYPTION_KEY = '1';

    ensureEmbeddedGatewaySecrets();

    expect(process.env.ENCRYPTION_KEY).toBeTruthy();
  });
});
