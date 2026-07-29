/**
 * `toPublicWebOrigin` turns the gateway's configured public base into the origin
 * an agent composes user-openable Lobu links against.
 *
 * The `/lobu` case is not hypothetical: prod runs
 * `PUBLIC_GATEWAY_URL=https://app.lobu.ai/lobu` (see the summaries-prod
 * kustomization). The gateway is mounted under that prefix; the admin routes
 * these links point at are not. Without the strip, every link an agent writes
 * would 404 in production — so that assertion is the point of this file.
 */
import { describe, expect, it } from 'vitest';
import { toPublicWebOrigin } from '../url-builder';

describe('toPublicWebOrigin', () => {
  it('strips the /lobu mount prefix prod actually runs with', () => {
    expect(toPublicWebOrigin('https://app.lobu.ai/lobu')).toBe('https://app.lobu.ai');
  });

  it('tolerates a trailing slash on that same prod value', () => {
    expect(toPublicWebOrigin('https://app.lobu.ai/lobu/')).toBe('https://app.lobu.ai');
  });

  it('passes a bare origin through unchanged', () => {
    expect(toPublicWebOrigin('https://app.lobu.ai')).toBe('https://app.lobu.ai');
  });

  it('keeps a base path that merely starts with "lobu"', () => {
    // Guard the strip from over-reaching onto a legitimate prefix.
    expect(toPublicWebOrigin('https://acme.example/lobu-staging')).toBe(
      'https://acme.example/lobu-staging'
    );
  });

  it('keeps a non-/lobu mount prefix', () => {
    expect(toPublicWebOrigin('https://acme.example/gateway')).toBe(
      'https://acme.example/gateway'
    );
  });

  it('preserves a non-default port', () => {
    expect(toPublicWebOrigin('http://localhost:8787/lobu')).toBe('http://localhost:8787');
  });

  it('yields undefined rather than a mangled origin', () => {
    // The caller omits the link entirely; a broken URL pasted into a reply to a
    // user is worse than no link at all.
    expect(toPublicWebOrigin(undefined)).toBeUndefined();
    expect(toPublicWebOrigin('')).toBeUndefined();
    expect(toPublicWebOrigin('   ')).toBeUndefined();
    expect(toPublicWebOrigin('app.lobu.ai/lobu')).toBeUndefined();
  });
});
