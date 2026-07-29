import { describe, expect, it } from 'vitest';
import { toPublicWebOrigin } from '../url-builder';

describe('toPublicWebOrigin', () => {
  it('strips the /lobu mount prefix prod actually runs with', () => {
    // PUBLIC_GATEWAY_URL carries this gateway mount in prod, while frontend
    // routes live at the origin.
    expect(toPublicWebOrigin('https://app.lobu.ai/lobu')).toBe('https://app.lobu.ai');
  });

  it('tolerates a trailing slash on that same prod value', () => {
    expect(toPublicWebOrigin('https://app.lobu.ai/lobu/')).toBe('https://app.lobu.ai');
  });

  it('passes a bare origin through unchanged', () => {
    expect(toPublicWebOrigin('https://app.lobu.ai')).toBe('https://app.lobu.ai');
  });

  it('preserves a non-/lobu mount path, matching buildAgentSettingsUrl', () => {
    // Deliberately NOT `parsed.origin`. The server-side builders strip only
    // `/lobu`, so dropping every path here would make the agent's links and the
    // server's disagree on any other mount. Consistency wins; change both or
    // neither.
    expect(toPublicWebOrigin('https://acme.example/gateway')).toBe(
      'https://acme.example/gateway'
    );
  });

  it('does not over-reach onto a prefix that merely starts with "lobu"', () => {
    expect(toPublicWebOrigin('https://acme.example/lobu-staging')).toBe(
      'https://acme.example/lobu-staging'
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
    expect(toPublicWebOrigin('javascript:alert(1)')).toBeUndefined();
    expect(toPublicWebOrigin('ftp://app.lobu.ai/lobu')).toBeUndefined();
  });
});
