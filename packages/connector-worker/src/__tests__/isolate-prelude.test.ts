import { describe, expect, it } from 'bun:test';
import {
  assertIsolateEligible,
  findIsolateIneligibleBuiltins,
  IsolateLaneIneligibleError,
} from '../isolate/eligibility.js';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { GUEST_PRELUDE, PRELUDE_GLOBALS, PRELUDE_HOST_SYNC } from '../isolate/prelude.js';

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

/**
 * A guest whose `__host_sync` dispatches into the REAL host halves, so these
 * assertions cover both sides of the bridge rather than a stub's idea of them.
 */
function instantiateGuest(): any {
  const guest: any = {
    __host_sync: {
      applySync: (_receiver: unknown, args: any[]) => {
        const [name, ...rest] = args;
        const fn = PRELUDE_HOST_SYNC[String(name)];
        if (!fn) return { __lobu: 1, ok: true, value: null };
        try {
          return { __lobu: 1, ok: true, value: fn(...rest) };
        } catch (error) {
          const err = error as Error;
          return { __lobu: 1, ok: false, error: { name: err.name, message: err.message } };
        }
      },
    },
    __host_async: { applyAsync: () => Promise.resolve({ __lobu: 1, ok: true, value: null }) },
    __host_env_json: '{}',
    atob: (x: string) => Buffer.from(x, 'base64').toString('binary'),
    btoa: (x: string) => Buffer.from(x, 'binary').toString('base64'),
    TextEncoder,
    TextDecoder,
  };
  new Function('globalThis', GUEST_PRELUDE)(guest);
  return guest;
}

/**
 * Enumerated as OPERATIONS, not as one connector: a database driver on this
 * lane answers its authentication challenge entirely through `crypto.subtle`,
 * and a guest that is merely missing one of these does not fail loudly. The
 * rejection is swallowed inside the driver's async auth handler and the
 * connection stalls until its own connect timeout, which reads as a network
 * fault rather than a missing shim. Every case below pins the guest's answer
 * to Node's for the same input.
 */
describe('guest crypto.subtle', () => {
  const enc = new TextEncoder();

  it('digests SHA-256 and md5 exactly as Node does', async () => {
    const guest = instantiateGuest();
    for (const [label, nodeName] of [
      ['SHA-256', 'sha256'],
      ['SHA-1', 'sha1'],
      // Not a WebCrypto algorithm. A driver answering an md5 password
      // challenge asks for it by this name, and the host has it.
      ['md5', 'md5'],
    ] as const) {
      const digest = Buffer.from(await guest.crypto.subtle.digest(label, enc.encode('lobu')));
      expect(digest.toString('hex')).toBe(createHash(nodeName).update('lobu').digest('hex'));
    }
  });

  it('signs HMAC-SHA-256 over a raw imported key', async () => {
    const guest = instantiateGuest();
    const key = await guest.crypto.subtle.importKey(
      'raw',
      enc.encode('salted password'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = Buffer.from(await guest.crypto.subtle.sign('HMAC', key, enc.encode('Client Key')));
    expect(mac.toString('hex')).toBe(
      createHmac('sha256', 'salted password').update('Client Key').digest('hex')
    );
  });

  it('derives PBKDF2-SHA-256 bits, the SCRAM salted password', async () => {
    const guest = instantiateGuest();
    const key = await guest.crypto.subtle.importKey('raw', enc.encode('pw'), 'PBKDF2', false, ['deriveBits']);
    const bits = Buffer.from(
      await guest.crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('salt'), iterations: 4096 },
        key,
        32 * 8
      )
    );
    expect(bits.toString('hex')).toBe(pbkdf2Sync('pw', 'salt', 4096, 32, 'sha256').toString('hex'));
  });

  it('rejects rather than throws synchronously, so a guest await sees the failure', async () => {
    const guest = instantiateGuest();
    // A synchronous throw here is swallowed by an async auth handler and the
    // caller hangs; the rejection is what surfaces the fault.
    await expect(guest.crypto.subtle.digest('SHA-3', enc.encode('x'))).rejects.toThrow(/unsupported algorithm/);
    await expect(guest.crypto.subtle.importKey('jwk', enc.encode('k'), 'PBKDF2', false, [])).rejects.toThrow(/raw/);
    await expect(guest.crypto.subtle.sign('RSASSA-PKCS1-v1_5', {}, enc.encode('x'))).rejects.toThrow(/only HMAC/);
  });

  it('bounds PBKDF2 rounds, which run synchronously on the host event loop', async () => {
    const guest = instantiateGuest();
    const key = await guest.crypto.subtle.importKey('raw', enc.encode('pw'), 'PBKDF2', false, ['deriveBits']);
    await expect(
      guest.crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('salt'), iterations: 1_000_000_000 },
        key,
        256
      )
    ).rejects.toThrow(/iterations/);
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
    expect(err.message).toContain('the isolate does not provide');
  });
});

/**
 * `node:crypto` is a PROVIDED builtin, so a bundle that imports it passes
 * eligibility and loads — which is exactly why the module the guest hands back
 * has to be Node's, not WebCrypto's. It used to be WebCrypto's, so
 * `createHash('sha256')` died at the call site as "is not a function" with the
 * bundle already running. github, jira and linear each mint a webhook secret
 * with `randomBytes(32).toString('hex')`, and every scraping connector hashes
 * content for change detection.
 */
describe('guest node:crypto', () => {
  it('createHash matches Node for every digest encoding', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('node:crypto');
    for (const algorithm of ['sha256', 'sha1', 'md5'] as const) {
      for (const encoding of ['hex', 'base64'] as const) {
        expect(nodeCrypto.createHash(algorithm).update('lobu').digest(encoding)).toBe(
          createHash(algorithm).update('lobu').digest(encoding)
        );
      }
    }
  });

  it('createHash accumulates chained updates the way a stream would', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('crypto');
    const hash = nodeCrypto.createHash('sha256');
    expect(hash.update('lo')).toBe(hash);
    hash.update('bu');
    expect(hash.digest('hex')).toBe(createHash('sha256').update('lobu').digest('hex'));
  });

  it('createHmac matches Node, keyed by string or bytes', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('node:crypto');
    expect(nodeCrypto.createHmac('sha256', 'k').update('lobu').digest('hex')).toBe(
      createHmac('sha256', 'k').update('lobu').digest('hex')
    );
    const key = new Uint8Array([1, 2, 3]);
    expect(nodeCrypto.createHmac('sha256', key).update('lobu').digest('hex')).toBe(
      createHmac('sha256', Buffer.from(key)).update('lobu').digest('hex')
    );
  });

  it('randomBytes returns hex-encodable bytes of the requested length', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('node:crypto');
    const bytes = nodeCrypto.randomBytes(32);
    expect(bytes.length).toBe(32);
    // The call site every bundled connector makes.
    expect(nodeCrypto.randomBytes(32).toString('hex')).toMatch(/^[0-9a-f]{64}$/);
    expect(nodeCrypto.randomBytes(0).length).toBe(0);
    expect(() => nodeCrypto.randomBytes(-1)).toThrow(TypeError);
  });

  it('still carries the WebCrypto surface for callers that want it', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('node:crypto');
    expect(typeof nodeCrypto.randomUUID()).toBe('string');
    expect(nodeCrypto.subtle).toBe(guest.crypto.subtle);
    expect(nodeCrypto.webcrypto).toBe(guest.crypto);
  });
});
