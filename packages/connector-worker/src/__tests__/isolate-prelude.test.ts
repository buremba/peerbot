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
});

describe('findIsolateIneligibleBuiltins', () => {
  it('names surviving Node builtins, node: prefix stripped, deduplicated and sorted', () => {
    const code = [
      'var fs = require("node:fs");',
      "var c = require('crypto');",
      'var again = __require("fs");',
      'var ky = require("ky");',
      'var path = require( "node:path" );',
    ].join('\n');
    expect(findIsolateIneligibleBuiltins(code)).toEqual(['crypto', 'fs', 'path']);
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
