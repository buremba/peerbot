import { describe, expect, test } from 'bun:test';
import { ipFamily } from '../ip-reachability.js';

/**
 * `ipFamily` replaces `node:net`'s `isIP` so the SDK root stays loadable in a
 * V8 isolate. The expectations below are `net.isIP`'s answers on Node 26 for
 * the same inputs (differentially checked when the port was written); they
 * pin the semantics every egress guard's fail-closed classification rests on.
 */
const CASES: Array<[string, 0 | 4 | 6]> = [
  // IPv4: strict dotted decimal, no leading zeros, no surrounding whitespace.
  ['127.0.0.1', 4],
  ['0.0.0.0', 4],
  ['255.255.255.255', 4],
  ['10.1.2.3', 4],
  ['169.254.169.254', 4],
  ['256.0.0.1', 0],
  ['1.2.3', 0],
  ['1.2.3.4.5', 0],
  ['01.2.3.4', 0],
  ['1.2.3.4 ', 0],
  [' 1.2.3.4', 0],
  ['1.2.3.4\n', 0],
  ['1.2.3.a', 0],
  ['1.2.3.-1', 0],
  ['0x7f.0.0.1', 0],
  ['1.2.3.4:80', 0],
  ['', 0],
  [' ', 0],
  // IPv6: full, compressed, embedded IPv4, zone ids, uppercase.
  ['::1', 6],
  ['::', 6],
  ['fe80::1', 6],
  ['fe80::1%eth0', 6],
  ['fe80::1%25eth0', 6],
  ['2001:db8::ff00:42:8329', 6],
  ['2001:0db8:0000:0000:0000:ff00:0042:8329', 6],
  ['::ffff:127.0.0.1', 6],
  ['::ffff:7f00:1', 6],
  ['::7f00:1', 6],
  ['::a9fe:a9fe', 6],
  ['64:ff9b::192.0.2.33', 6],
  ['FE80::ABCD', 6],
  ['1:2:3:4:5:6:7:8', 6],
  ['1::8', 6],
  ['1:2:3:4:5:6:7::', 6],
  ['::2:3:4:5:6:7:8', 6],
  ['1:2:3:4:5:6:1.2.3.4', 6],
  // IPv6 rejects: brackets, too many groups, empty zone, bad hex, two `::`.
  ['[::1]', 0],
  [':::', 0],
  ['1:2:3:4:5:6:7:8:9', 0],
  ['1:2:3:4:5:6:7', 0],
  ['1:2:3:4:5:6:7:1.2.3.4', 0],
  ['12345::1', 0],
  ['fe80::1%', 0],
  ['g::1', 0],
  ['::ffff:256.0.0.1', 0],
  ['::ffff:1.2.3', 0],
  ['1::2::3', 0],
  ['::1 ', 0],
  // Hostnames are never IP literals.
  ['localhost', 0],
  ['example.com', 0],
];

describe('ipFamily (pure replacement for node:net isIP)', () => {
  for (const [input, expected] of CASES) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(ipFamily(input)).toBe(expected);
    });
  }
});
