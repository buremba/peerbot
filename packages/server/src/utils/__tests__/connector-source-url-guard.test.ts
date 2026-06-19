import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConnectorInstallSource } from '../connector-definition-install';

// These cases all reject BEFORE any network fetch (scheme/allowlist/SSRF on IP
// literals), so they need no mocking and make no outbound request. SSRF cases use
// CONNECTOR_SOURCE_ALLOWLIST='*' to pass the allowlist and reach the SSRF check,
// and IP literals (not hostnames) so the reserved-IP check is deterministic.
describe('connector source_url install guard', () => {
  const prev = process.env.CONNECTOR_SOURCE_ALLOWLIST;
  beforeEach(() => {
    process.env.CONNECTOR_SOURCE_ALLOWLIST = '';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CONNECTOR_SOURCE_ALLOWLIST;
    else process.env.CONNECTOR_SOURCE_ALLOWLIST = prev;
  });

  it('rejects non-https schemes', async () => {
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'http://raw.githubusercontent.com/x/y/z.ts' })
    ).rejects.toThrow(/must use https/i);
  });

  it('rejects hosts not on the allowlist', async () => {
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://evil.example.com/x.ts' })
    ).rejects.toThrow(/allowlist/i);
  });

  it('blocks cloud-metadata / link-local addresses (SSRF) even with wildcard', async () => {
    process.env.CONNECTOR_SOURCE_ALLOWLIST = '*';
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://169.254.169.254/latest/meta-data/' })
    ).rejects.toThrow(/blocked/i);
  });

  it('blocks loopback and private IP literals (SSRF) even with wildcard', async () => {
    process.env.CONNECTOR_SOURCE_ALLOWLIST = '*';
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://127.0.0.1/x.ts' })
    ).rejects.toThrow(/blocked/i);
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://10.0.0.5/x.ts' })
    ).rejects.toThrow(/blocked/i);
  });

  it('blocks IPv4-mapped IPv6 loopback even with wildcard (regression for SSRF bypass)', async () => {
    process.env.CONNECTOR_SOURCE_ALLOWLIST = '*';
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://[::ffff:127.0.0.1]/x.ts' })
    ).rejects.toThrow(/blocked/i);
  });

  it('lets an allowlisted public host past the guard (fails later at fetch, not the guard)', async () => {
    process.env.CONNECTOR_SOURCE_ALLOWLIST = 'connectors.example.com';
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://connectors.example.com/nope.ts' })
    ).rejects.not.toThrow(/allowlist|must use https|blocked/i);
  });
});
