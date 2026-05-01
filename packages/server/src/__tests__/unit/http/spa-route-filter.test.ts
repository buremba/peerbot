import { describe, expect, it } from 'vitest';
import { isExcludedSpaPath } from '../../../http/spa-route-filter';

describe('SPA route filter', () => {
  it('allows frontend OAuth pages through the SPA fallback', () => {
    expect(isExcludedSpaPath('/oauth/device')).toBe(false);
    expect(isExcludedSpaPath('/oauth/device/')).toBe(false);
    expect(isExcludedSpaPath('/oauth/consent')).toBe(false);
  });

  it('keeps OAuth API endpoints excluded from the SPA fallback', () => {
    expect(isExcludedSpaPath('/oauth/authorize')).toBe(true);
    expect(isExcludedSpaPath('/oauth/device_authorization')).toBe(true);
    expect(isExcludedSpaPath('/oauth/device/approve')).toBe(true);
  });

  it('keeps non-OAuth API prefixes excluded', () => {
    expect(isExcludedSpaPath('/api/auth/sign-in')).toBe(true);
    expect(isExcludedSpaPath('/mcp/acme')).toBe(true);
    expect(isExcludedSpaPath('/connect/session')).toBe(true);
  });
});
