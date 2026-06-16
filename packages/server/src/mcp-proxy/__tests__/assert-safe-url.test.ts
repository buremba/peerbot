/**
 * SSRF guard for the MCP proxy's `assertSafeUrl` (F10).
 *
 * The MCP proxy used to carry a hand-rolled regex variant of the SSRF check
 * that missed NAT64 (`64:ff9b::/96`) and hex-form IPv4-mapped IPv6
 * (`::ffff:7f00:1`) — both decode to internal IPv4 targets but slipped past the
 * regex. It now delegates to the shared `isReservedIp` from `ssrf-guard.ts`, so
 * these spellings are caught identically to the gateway egress proxy.
 */

import { describe, expect, it } from 'vitest';
import { assertSafeUrl } from '../client';

describe('assertSafeUrl — shared SSRF guard (F10)', () => {
  it('rejects NAT64-wrapped loopback (the previously-missed bypass)', () => {
    // 64:ff9b::7f00:1 → 127.0.0.1
    expect(() => assertSafeUrl('http://[64:ff9b::7f00:1]/')).toThrow(
      /private\/internal address/i
    );
  });

  it('rejects NAT64-wrapped cloud metadata IP', () => {
    // 64:ff9b::a9fe:a9fe → 169.254.169.254
    expect(() => assertSafeUrl('https://[64:ff9b::a9fe:a9fe]/latest/meta-data')).toThrow(
      /private\/internal address/i
    );
  });

  it('rejects hex-form IPv4-mapped IPv6 loopback', () => {
    // ::ffff:7f00:1 → 127.0.0.1
    expect(() => assertSafeUrl('http://[::ffff:7f00:1]/')).toThrow(
      /private\/internal address/i
    );
  });

  it('rejects dotted IPv4-mapped IPv6 loopback', () => {
    expect(() => assertSafeUrl('http://[::ffff:127.0.0.1]/')).toThrow(
      /private\/internal address/i
    );
  });

  it('still rejects the plain private/loopback ranges it caught before', () => {
    expect(() => assertSafeUrl('http://127.0.0.1/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://10.0.0.1/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://192.168.1.1/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://172.16.0.1/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://169.254.169.254/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://[::1]/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://[fe80::1]/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://100.64.0.1/')).toThrow(/private\/internal/i);
  });

  it('still rejects the non-IP private hostnames', () => {
    expect(() => assertSafeUrl('http://localhost/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://db.internal/')).toThrow(/private\/internal/i);
    expect(() => assertSafeUrl('http://printer.local/')).toThrow(/private\/internal/i);
  });

  it('rejects an IP-shaped literal that does not cleanly parse (fail closed)', () => {
    // A bracketed value that looks like IPv6 but is malformed → reserved/blocked.
    expect(() => assertSafeUrl('http://[64:ff9b::zz]/')).toThrow();
  });

  it('rejects unsupported protocols', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(/Unsupported protocol/i);
    expect(() => assertSafeUrl('ftp://example.com/')).toThrow(/Unsupported protocol/i);
  });

  it('allows ordinary public hostnames', () => {
    expect(() => assertSafeUrl('https://mcp.example.com/rpc')).not.toThrow();
    expect(() => assertSafeUrl('https://api.github.com/')).not.toThrow();
  });
});
