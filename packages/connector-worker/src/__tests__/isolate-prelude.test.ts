import { describe, expect, it } from 'bun:test';
import {
  assertIsolateEligible,
  findIsolateIneligibleBuiltins,
  IsolateLaneIneligibleError,
} from '../isolate/eligibility.js';
import { GUEST_PRELUDE, PRELUDE_GLOBALS } from '../isolate/prelude.js';

describe('guest prelude text', () => {
  it('installs every advertised global', () => {
    for (const name of PRELUDE_GLOBALS) {
      const installed = new RegExp(`(^|\\n)\\s*(global\\.${name}\\s*=|var ${name}\\s*=)`).test(GUEST_PRELUDE);
      expect(installed, `${name} is listed in PRELUDE_GLOBALS but never installed`).toBe(true);
    }
  });

  it('captures and removes the host handles so connector code cannot reach them', () => {
    // The two ivm.References are captured once and removed from the global so
    // connector code cannot reach the raw host dispatchers.
    expect(GUEST_PRELUDE).toMatch(/delete global\.__host_sync/);
    expect(GUEST_PRELUDE).toMatch(/delete global\.__host_async/);
    expect(GUEST_PRELUDE).toMatch(/delete global\.__host_env_json/);
  });

  it('parses as JavaScript', () => {
    // Construction alone parses the body; nothing runs.
    expect(() => new Function(GUEST_PRELUDE)).not.toThrow();
  });

  it('provides working crypto and Buffer shims in guest environment', () => {
    const mockGlobal: any = {
      __host_sync: {
        applySync: (_receiver: any, args: any[]) => {
          const name = args[0];
          if (name === 'randomBytes') {
            const len = args[1];
            const out = new Uint8Array(len);
            for (let i = 0; i < len; i++) out[i] = (i * 17 + 3) & 0xff;
            return { __lobu: 1, ok: true, value: out };
          }
          if (name === 'base64Decode') {
            return { __lobu: 1, ok: true, value: Buffer.from(String(args[1]), 'base64').toString('binary') };
          }
          if (name === 'base64Encode') {
            return { __lobu: 1, ok: true, value: Buffer.from(String(args[1]), 'binary').toString('base64') };
          }
          return { __lobu: 1, ok: true, value: null };
        },
      },
      __host_async: {
        applyAsync: () => Promise.resolve({ __lobu: 1, ok: true, value: null }),
      },
      __host_env_json: '{}',
      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
      TextEncoder,
      TextDecoder,
    };
    new Function('globalThis', GUEST_PRELUDE)(mockGlobal);

    // crypto.getRandomValues
    const bytes = new Uint8Array(16);
    mockGlobal.crypto.getRandomValues(bytes);
    expect(bytes[0]).toBe(3);
    expect(bytes[1]).toBe(20);

    // crypto.randomUUID
    const uuid = mockGlobal.crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Buffer.from base64 / base64url decode (used by google_gmail.ts)
    const base64Sample = mockGlobal.btoa('hello world');
    const decoded = mockGlobal.Buffer.from(base64Sample, 'base64').toString('utf8');
    expect(decoded).toBe('hello world');

    // base64url with - and _
    const base64url = 'aGVsbG8td29ybGRfc3Ry'; // "hello-world_str"
    const decodedUrl = mockGlobal.Buffer.from(base64url, 'base64url').toString('utf8');
    expect(decodedUrl).toBe('hello-world_str');
  });
});

describe('findIsolateIneligibleBuiltins', () => {
  it('names surviving Node builtins, node: prefix stripped, deduplicated and sorted', () => {
    const code = [
      'var fs = require("node:fs");',
      "var c = require('os');",
      'var again = __require("fs");',
      'var ky = require("ky");',
      'var path = require( "node:path" );',
    ].join('\n');
    expect(findIsolateIneligibleBuiltins(code)).toEqual(['fs', 'os', 'path']);
  });

  it('ignores non-builtin requires and property accesses that merely end in require', () => {
    expect(findIsolateIneligibleBuiltins('var x = require("ky"); obj.require("fs"); myrequire("os");')).toEqual([]);
  });

  it('assertIsolateEligible throws a typed error naming the builtins', () => {
    expect(() => assertIsolateEligible('module.exports = 1;')).not.toThrow();
    let caught: unknown;
    try {
      assertIsolateEligible('require("node:net"); require("tls");', 'fixture');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IsolateLaneIneligibleError);
    const err = caught as IsolateLaneIneligibleError;
    expect(err.builtins).toEqual(['net', 'tls']);
    expect(err.message).toContain('net');
    expect(err.message).toContain('tls');
    expect(err.message).toContain('process lane');
  });
});
