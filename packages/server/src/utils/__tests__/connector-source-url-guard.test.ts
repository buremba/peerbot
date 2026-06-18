import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConnectorInstallSource } from '../connector-definition-install';

// These cases all reject BEFORE any network fetch (scheme/SSRF/allowlist checks),
// so they need no mocking and make no outbound request.
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

  it('blocks cloud-metadata / link-local addresses (SSRF)', async () => {
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://169.254.169.254/latest/meta-data/' })
    ).rejects.toThrow(/blocked/i);
  });

  it('blocks loopback and private hosts (SSRF)', async () => {
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://localhost/x.ts' })
    ).rejects.toThrow(/blocked/i);
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://10.0.0.5/x.ts' })
    ).rejects.toThrow(/blocked/i);
  });

  it('rejects hosts not on the allowlist', async () => {
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://evil.example.com/x.ts' })
    ).rejects.toThrow(/allowlist/i);
  });

  it('allows hosts added via CONNECTOR_SOURCE_ALLOWLIST past the guard', async () => {
    process.env.CONNECTOR_SOURCE_ALLOWLIST = 'evil.example.com';
    // Passes the guard, then fails at the (unmocked) fetch — proving the guard let it through.
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://evil.example.com/does-not-exist.ts' })
    ).rejects.not.toThrow(/allowlist|must use https|blocked/i);
  });
});
