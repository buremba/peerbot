import { describe, expect, it } from 'bun:test';
import {
  assertIsolateEligible,
  findIsolateIneligibleBuiltins,
  IsolateLaneIneligibleError,
} from '../isolate/eligibility.js';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { createPreludeHostSync, GUEST_PRELUDE, PRELUDE_GLOBALS } from '../isolate/prelude.js';

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
  const hostSync = createPreludeHostSync();
  const guest: any = {
    __host_sync: {
      applySync: (_receiver: unknown, args: any[]) => {
        const [name, ...rest] = args;
        const fn = hostSync[String(name)];
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

describe('guest Buffer shim — Node semantics connector code relies on', () => {
  it('Buffer.from(Uint8Array) copies rather than aliasing the source', () => {
    const guest = instantiateGuest();
    const source = new Uint8Array([1, 2, 3]);
    const copy = guest.Buffer.from(source);
    copy[0] = 9;
    expect(source[0]).toBe(1);
    expect(Array.from(copy)).toEqual([9, 2, 3]);
  });

  it('Buffer.byteLength honours the encoding and accepts byte sources', () => {
    const guest = instantiateGuest();
    expect(guest.Buffer.byteLength('aGk=', 'base64')).toBe(2);
    expect(guest.Buffer.byteLength('h\u00e9llo')).toBe(6);
    expect(guest.Buffer.byteLength(new Uint8Array(4))).toBe(4);
    expect(guest.Buffer.byteLength(new ArrayBuffer(5))).toBe(5);
  });

  it('Buffer.alloc repeats a string fill instead of zeroing', () => {
    const guest = instantiateGuest();
    expect(Array.from(guest.Buffer.alloc(5, 'ab'))).toEqual([97, 98, 97, 98, 97]);
    expect(Array.from(guest.Buffer.alloc(3, 7))).toEqual([7, 7, 7]);
    expect(Array.from(guest.Buffer.alloc(2))).toEqual([0, 0]);
    expect(Array.from(guest.Buffer.alloc(3, new Uint8Array([5, 6])))).toEqual([5, 6, 5]);
  });
});

/**
 * `TextDecoder.decode(chunk, { stream: true })` is how every SSE consumer
 * (pi-ai's Anthropic provider, the Stainless SDKs) reassembles a body that
 * arrives in chunks. The guest shell has no decoder state of its own: the
 * sequence of streaming decodes runs on one Node `TextDecoder` the host holds
 * open until the flushing decode, so these pin that both halves agree with
 * Node on a multi-byte sequence split across chunks.
 */
describe('guest TextDecoder streaming', () => {
  // 'café €' = 63 61 66 | c3 a9 | 20 | e2 82 ac
  const bytes = new TextEncoder().encode('café €');

  it('holds a split multi-byte sequence across chunks and flushes on the final decode', () => {
    const guest = instantiateGuest();
    const decoder = new guest.TextDecoder();
    expect(decoder.decode(bytes.subarray(0, 4), { stream: true })).toBe('caf');
    expect(decoder.decode(bytes.subarray(4, 8), { stream: true })).toBe('é ');
    expect(decoder.decode(bytes.subarray(8))).toBe('€');
    // Reusable and stateless again after the flush, as the spec resets it.
    expect(decoder.decode(bytes)).toBe('café €');
  });

  it('matches Node chunk for chunk over every split point', () => {
    const guest = instantiateGuest();
    for (let split = 0; split <= bytes.length; split++) {
      const guestDecoder = new guest.TextDecoder();
      const nodeDecoder = new TextDecoder();
      const guestOut =
        guestDecoder.decode(bytes.subarray(0, split), { stream: true }) + guestDecoder.decode(bytes.subarray(split));
      const nodeOut = nodeDecoder.decode(bytes.subarray(0, split), { stream: true }) + nodeDecoder.decode(bytes.subarray(split));
      expect(guestOut, `split at ${split}`).toBe(nodeOut);
      expect(guestOut).toBe('café €');
    }
  });

  it('without the stream flag a chunk boundary inside a sequence is a replacement character, as on Node', () => {
    const guest = instantiateGuest();
    const decoder = new guest.TextDecoder();
    expect(decoder.decode(bytes.subarray(0, 4))).toBe(new TextDecoder().decode(bytes.subarray(0, 4)));
    expect(decoder.decode(bytes.subarray(0, 4))).toBe('caf\uFFFD');
  });

  it('a fatal decoder throws at the flush for a sequence that never completed, and only then', () => {
    const guest = instantiateGuest();
    const decoder = new guest.TextDecoder('utf-8', { fatal: true });
    expect(decoder.decode(bytes.subarray(0, 4), { stream: true })).toBe('caf');
    expect(() => decoder.decode()).toThrow(TypeError);
    // The failed flush released the host decoder: the next decode starts clean.
    expect(decoder.decode(bytes)).toBe('café €');
  });

  it('a flush with no input ends the stream, the way an SSE reader finishes', () => {
    const guest = instantiateGuest();
    const decoder = new guest.TextDecoder();
    expect(decoder.decode(bytes.subarray(0, 4), { stream: true })).toBe('caf');
    expect(decoder.decode()).toBe('\uFFFD');
    expect(decoder.decode(bytes.subarray(4, 6))).toBe('\uFFFD ');
  });

  it('bounds the streaming decoders one guest may leave open', () => {
    const guest = instantiateGuest();
    for (let i = 0; i < 1024; i++) new guest.TextDecoder().decode(bytes.subarray(0, 1), { stream: true });
    expect(() => new guest.TextDecoder().decode(bytes.subarray(0, 1), { stream: true })).toThrow(RangeError);
    // Each host is its own registry: a fresh guest is not affected.
    expect(new (instantiateGuest().TextDecoder)().decode(bytes, { stream: true })).toBe('café €');
  });
});

/**
 * `Response.body` is a `ReadableStream` over the host's `fetchRead`, and a
 * socket's `readable` is one over `socketRead`, so what a reader does after
 * the consumer stops reading decides whether the guest reads from something
 * the host already released. Both sources are pull-only, which these model
 * directly rather than through a fetch.
 */
describe('guest ReadableStream reader', () => {
  /**
   * A source that hands out one chunk per pull and records the cancel. It
   * answers on a later microtask, as `fetchRead` and `socketRead` do across
   * the host boundary, so several reads really are waiting at once.
   */
  function pullSource(chunks: string[]): { source: Record<string, unknown>; pulls: () => number; cancelled: () => boolean } {
    let pulls = 0;
    let cancelled = false;
    return {
      source: {
        pull: (controller: { enqueue: (chunk: string) => void; close: () => void }) => {
          pulls += 1;
          const index = pulls;
          return Promise.resolve().then(() => {
            if (index > chunks.length) controller.close();
            else controller.enqueue(chunks[index - 1]);
          });
        },
        cancel: () => {
          cancelled = true;
        },
      },
      pulls: () => pulls,
      cancelled: () => cancelled,
    };
  }

  it('answers concurrent reads in order, one pull each', async () => {
    const guest = instantiateGuest();
    const probe = pullSource(['a', 'b', 'c']);
    const reader = new guest.ReadableStream(probe.source).getReader();
    const results = await Promise.all([reader.read(), reader.read(), reader.read()]);
    expect(results.map((r: { value: string }) => r.value)).toEqual(['a', 'b', 'c']);
    expect(probe.pulls()).toBe(3);
    expect((await reader.read()).done).toBe(true);
  });

  it('cancelling ends the stream: the source is cancelled once and no later read pulls it again', async () => {
    const guest = instantiateGuest();
    const probe = pullSource(['a', 'b', 'c']);
    const reader = new guest.ReadableStream(probe.source).getReader();
    expect((await reader.read()).value).toBe('a');
    await reader.cancel();
    expect(probe.cancelled()).toBe(true);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(probe.pulls()).toBe(1);
  });

  it('cancelling settles a read already waiting and drops a chunk the source still owed', async () => {
    const guest = instantiateGuest();
    let release: ((value: string) => void) | null = null;
    const reader = new guest.ReadableStream({
      pull: (controller: { enqueue: (chunk: string) => void }) => {
        release = (value: string) => controller.enqueue(value);
      },
    }).getReader();
    const pending = reader.read();
    await reader.cancel();
    expect(await pending).toEqual({ value: undefined, done: true });
    release?.('late');
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  });

  it('marks the stream disturbed on the first read, which is what Response.bodyUsed reports', async () => {
    const guest = instantiateGuest();
    const stream = new guest.ReadableStream(pullSource(['a']).source);
    expect(stream._disturbed).toBe(false);
    await stream.getReader().read();
    expect(stream._disturbed).toBe(true);
  });
});
