import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Redirect re-validation + body cap need a mocked fetch. `.invalid` hosts are
// RFC-2606 guaranteed-NXDOMAIN, so the initial SSRF/DNS check passes fast and
// deterministically without real network, then our mock drives the behavior.
describe('connector source_url fetch: redirect validation + body cap', () => {
  const prev = process.env.CONNECTOR_SOURCE_ALLOWLIST;
  beforeEach(() => {
    process.env.CONNECTOR_SOURCE_ALLOWLIST = 'host.invalid';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prev === undefined) delete process.env.CONNECTOR_SOURCE_ALLOWLIST;
    else process.env.CONNECTOR_SOURCE_ALLOWLIST = prev;
  });

  it('re-validates redirect hops: a redirect to http:// is rejected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://host.invalid/y.ts' } })
    );
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://host.invalid/x.ts' })
    ).rejects.toThrow(/must use https/i);
  });

  it('re-validates redirect hops: a redirect to an off-allowlist host is rejected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/y.ts' } })
    );
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://host.invalid/x.ts' })
    ).rejects.toThrow(/allowlist/i);
  });

  it('rejects an oversized declared Content-Length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('x', { status: 200, headers: { 'content-length': String(6 * 1024 * 1024) } })
    );
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://host.invalid/x.ts' })
    ).rejects.toThrow(/too large/i);
  });

  it('aborts a streamed body that exceeds the cap (no/lying Content-Length)', async () => {
    const chunk = new Uint8Array(2 * 1024 * 1024); // 2 MiB per chunk; 3rd pushes past 5 MiB
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(stream, { status: 200 }));
    await expect(
      resolveConnectorInstallSource({ sourceUrl: 'https://host.invalid/x.ts' })
    ).rejects.toThrow(/too large/i);
  });
});
