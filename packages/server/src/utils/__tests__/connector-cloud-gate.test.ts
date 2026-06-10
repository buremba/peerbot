import { afterEach, describe, expect, it } from 'vitest';
import {
  assertConnectorAllowedInCloud,
  CLOUD_RESTRICTED_CONNECTOR_KEYS,
} from '../connector-cloud-gate';

describe('connector-cloud-gate', () => {
  afterEach(() => {
    process.env.LOBU_CLOUD_MODE = undefined;
  });

  it('postgres is in the restricted set', () => {
    expect(CLOUD_RESTRICTED_CONNECTOR_KEYS.has('postgres')).toBe(true);
  });

  it('allows the postgres connector self-hosted (cloud mode off)', () => {
    process.env.LOBU_CLOUD_MODE = undefined;
    expect(() => assertConnectorAllowedInCloud('postgres')).not.toThrow();
  });

  it('blocks the postgres connector under LOBU_CLOUD_MODE', () => {
    process.env.LOBU_CLOUD_MODE = '1';
    expect(() => assertConnectorAllowedInCloud('postgres')).toThrow(/Lobu Cloud/i);
  });

  it('leaves non-restricted connectors (and null) alone under cloud mode', () => {
    process.env.LOBU_CLOUD_MODE = '1';
    expect(() => assertConnectorAllowedInCloud('github')).not.toThrow();
    expect(() => assertConnectorAllowedInCloud(null)).not.toThrow();
    expect(() => assertConnectorAllowedInCloud(undefined)).not.toThrow();
  });
});
