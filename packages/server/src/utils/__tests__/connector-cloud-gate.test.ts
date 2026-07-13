import { afterEach, describe, expect, it } from 'vitest';
import {
  assertConnectorAllowedInCloud,
  CLOUD_RESTRICTED_CONNECTOR_KEYS,
} from '../connector-cloud-gate';

describe('connector-cloud-gate', () => {
  afterEach(() => {
    process.env.LOBU_CLOUD_MODE = undefined;
  });

  it('postgres graduated out of the restricted set (egress hardening shipped)', () => {
    expect(CLOUD_RESTRICTED_CONNECTOR_KEYS.has('postgres')).toBe(false);
  });

  it('the kill-switch set is empty until a future warehouse connector needs it', () => {
    expect(CLOUD_RESTRICTED_CONNECTOR_KEYS.size).toBe(0);
  });

  it('allows the postgres connector under LOBU_CLOUD_MODE (gate open)', () => {
    process.env.LOBU_CLOUD_MODE = '1';
    expect(() => assertConnectorAllowedInCloud('postgres')).not.toThrow();
  });

  it('allows the postgres connector self-hosted (cloud mode off)', () => {
    process.env.LOBU_CLOUD_MODE = undefined;
    expect(() => assertConnectorAllowedInCloud('postgres')).not.toThrow();
  });

  it('leaves non-restricted connectors (and null) alone under cloud mode', () => {
    process.env.LOBU_CLOUD_MODE = '1';
    expect(() => assertConnectorAllowedInCloud('github')).not.toThrow();
    expect(() => assertConnectorAllowedInCloud(null)).not.toThrow();
    expect(() => assertConnectorAllowedInCloud(undefined)).not.toThrow();
  });
});
