/**
 * Unit test for buildActionConfig — the config an inline connector action sees.
 *
 * Regression guard: a connector action (e.g. the office-bot Deliveroo
 * connector's search_restaurants) must receive its connection's own config
 * (e.g. `restaurants_url`). Before the fix the inline path merged only
 * env + credentials and dropped connection.config entirely, so the action
 * threw "No restaurants list URL".
 */

import { describe, expect, it } from 'vitest';
import { buildActionConfig } from '../manage_operations';

describe('buildActionConfig', () => {
  it('includes the connection config so actions can read it (the bug we fixed)', () => {
    const config = buildActionConfig(
      {},
      {},
      { restaurants_url: 'https://deliveroo.co.uk/restaurants/london/the-city' }
    );
    expect(config.restaurants_url).toBe(
      'https://deliveroo.co.uk/restaurants/london/the-city'
    );
  });

  it('merges env, credentials, and connection config together', () => {
    const config = buildActionConfig(
      { LOG_LEVEL: 'info' },
      { api_token: 'secret' },
      { restaurants_url: 'https://x' }
    );
    expect(config).toEqual({
      LOG_LEVEL: 'info',
      api_token: 'secret',
      restaurants_url: 'https://x',
    });
  });

  it('makes connection config authoritative (last) — matches sync feedConfig precedence', () => {
    const config = buildActionConfig(
      { shared: 'from-env' },
      { shared: 'from-creds' },
      { shared: 'from-config' }
    );
    expect(config.shared).toBe('from-config');
  });

  it('lets credentials override env when config does not set the key', () => {
    const config = buildActionConfig(
      { shared: 'from-env' },
      { shared: 'from-creds' },
      {}
    );
    expect(config.shared).toBe('from-creds');
  });

  it('handles null/undefined connection config (non-actions connectors)', () => {
    expect(buildActionConfig({ a: '1' }, { b: 2 }, null)).toEqual({
      a: '1',
      b: 2,
    });
    expect(buildActionConfig({ a: '1' }, { b: 2 }, undefined)).toEqual({
      a: '1',
      b: 2,
    });
  });
});
