/**
 * Guest prelude for the connector isolate lane.
 *
 * A bare `isolated-vm` context has ECMAScript plus an inert `console`: no
 * timers, no `URL`, no text codecs, no `fetch`. This prelude installs exactly
 * the web-platform surface the SDK root and the bundled isolate-eligible
 * connectors touch (measured by loading and running them, not by emulating a
 * browser):
 *
 *  - CJS shell (`module`/`exports`) and a `require` that fails closed.
 *  - `console.*` to the host `log` capability (the host redacts).
 *  - Timers, `setImmediate` and `queueMicrotask` over the host `sleep`
 *    capability; a callback that throws ends the run through `fatal`, as an
 *    uncaught exception ends the process lane's child.
 *  - `process = { env }` from the job env.
 *  - `TextEncoder`/`TextDecoder` (UTF-8), `atob`/`btoa`.
 *  - `URL` over the host `urlParse`/`urlSet` capabilities: the host runs Node's
 *    own URL, so both lanes agree on every input by construction.
 *    `URLSearchParams` is guest-side and writes back through `search`.
 *  - `AbortController`/`AbortSignal`.
 *  - `Headers`, `Response` and `fetch` over the host `fetch` capability. The
 *    host performs the network call and returns status, headers and a bounded
 *    body; there are no streams on this lane (`Response.body` is null).
 *
 * The guest talks to the host through two `ivm.Reference`s captured at the
 * top of the prelude and removed from the global: `__host_sync(name, ...args)`
 * and `__host_async(name, ...args)`. Every reply is an envelope
 * `{ __lobu: 1, ok, value | error }`; the host never throws across the
 * boundary because an async rejection also surfaces as an unhandled rejection
 * in the host process.
 *
 * Deliberately absent (no bundled isolate-eligible connector or SDK root path
 * uses them): `Request`, `crypto`, `structuredClone`, `Buffer`, streams,
 * `FormData`, `Blob`. Add one only with a real connector that needs it.
 *
 * Written as sloppy-mode ES2020 with no template literals so the string can
 * live in this module verbatim. `String.raw` keeps the regex escapes intact.
 */

/** Names the prelude defines on the guest global. */
export const PRELUDE_GLOBALS = [
  'module',
  'exports',
  'require',
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'process',
  'TextEncoder',
  'TextDecoder',
  'atob',
  'btoa',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'Headers',
  'Response',
  'fetch',
] as const;

/** What the guest `URL` holds: the components Node's URL reports. */
interface GuestUrlRecord {
  href: string;
  origin: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
}

const URL_SETTABLE = new Set(['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']);

function guestUrlRecord(url: URL): GuestUrlRecord {
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  };
}

/**
 * Host halves of prelude globals that delegate to Node. `IsolateHost` installs
 * them under every run, so they are part of the guest's standard library
 * rather than a capability a particular executor grants. Parsing only: no
 * network, no filesystem.
 */
export const PRELUDE_HOST_SYNC: Record<string, (...args: unknown[]) => unknown> = {
  urlParse: (input: unknown, base: unknown): GuestUrlRecord =>
    guestUrlRecord(base === undefined || base === null ? new URL(String(input)) : new URL(String(input), String(base))),
  urlSet: (href: unknown, name: unknown, value: unknown): GuestUrlRecord => {
    if (typeof name !== 'string' || !URL_SETTABLE.has(name)) {
      throw new TypeError(`URL has no settable property '${String(name)}'`);
    }
    const url = new URL(String(href));
    (url as unknown as Record<string, string>)[name] = String(value);
    return guestUrlRecord(url);
  },
};

export const GUEST_PRELUDE = String.raw`
var module = { exports: {} };
var exports = module.exports;
(function (global) {
  var hostSyncRef = global.__host_sync;
  var hostAsyncRef = global.__host_async;
  var envJson = global.__host_env_json;
  delete global.__host_sync;
  delete global.__host_async;
  delete global.__host_env_json;

  // ---------------------------------------------------------------------------
  // Host bridge
  // ---------------------------------------------------------------------------

  var STANDARD_ERRORS = { TypeError: TypeError, RangeError: RangeError, SyntaxError: SyntaxError, ReferenceError: ReferenceError };

  function makeError(desc) {
    var Ctor = STANDARD_ERRORS[desc && desc.name] || Error;
    var err = new Ctor(desc && desc.message ? String(desc.message) : 'host call failed');
    if (Ctor === Error && desc && desc.name) err.name = String(desc.name);
    if (desc && desc.code !== undefined) err.code = desc.code;
    if (desc && typeof desc.httpStatus === 'number') err.status = desc.httpStatus;
    return err;
  }

  function unwrap(envelope) {
    if (!envelope || envelope.__lobu !== 1) throw new Error('InvalidHostEnvelope: host capability returned a malformed reply');
    if (envelope.ok) return envelope.value;
    throw makeError(envelope.error);
  }

  function hostSync(name) {
    var args = Array.prototype.slice.call(arguments);
    return unwrap(hostSyncRef.applySync(undefined, args, { arguments: { copy: true }, result: { copy: true } }));
  }

  function hostAsync(name) {
    var args = Array.prototype.slice.call(arguments);
    return hostAsyncRef
      .apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } })
      .then(unwrap);
  }

  function describeError(error) {
    if (error instanceof Error) {
      var desc = { name: String(error.name || 'Error'), message: String(error.message), stack: typeof error.stack === 'string' ? error.stack : undefined };
      if (typeof error.status === 'number' && error.status >= 100 && error.status < 600) desc.httpStatus = error.status;
      return desc;
    }
    var text;
    try { text = typeof error === 'string' ? error : JSON.stringify(error); } catch (e) { text = String(error); }
    return { name: 'Error', message: text === undefined ? String(error) : text };
  }

  // An exception escaping a timer callback has no catcher in the guest. The
  // process lane's child treats the same case as uncaughtException and ends the
  // run with that error; do the same through the host.
  function reportFatal(error) {
    try { hostSync('fatal', describeError(error)); } catch (e) {}
  }

  global.__lobuHost = Object.freeze({ sync: hostSync, async: hostAsync, describeError: describeError });

  // ---------------------------------------------------------------------------
  // require: fail closed
  // ---------------------------------------------------------------------------

  global.require = function require(specifier) {
    var err = new Error(
      "Module '" + specifier + "' is not available on the isolate lane: Node builtins and runtime-provided packages need the process lane."
    );
    err.name = 'IsolateLaneIneligible';
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };

  // ---------------------------------------------------------------------------
  // console
  // ---------------------------------------------------------------------------

  function formatArg(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return typeof value.stack === 'string' && value.stack ? value.stack : value.name + ': ' + value.message;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (typeof value === 'bigint') return String(value) + 'n';
    if (value === undefined) return 'undefined';
    try {
      var json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (e) {
      return String(value);
    }
  }

  function emitConsole(level, args) {
    var text = Array.prototype.map.call(args, formatArg).join(' ');
    try { hostSync('log', level, text); } catch (e) {}
  }

  function noop() {}
  var consoleObject = {
    log: function () { emitConsole('log', arguments); },
    info: function () { emitConsole('info', arguments); },
    debug: function () { emitConsole('debug', arguments); },
    warn: function () { emitConsole('warn', arguments); },
    error: function () { emitConsole('error', arguments); },
    trace: function () { emitConsole('error', arguments); },
    dir: function (value) { emitConsole('log', [value]); },
    table: function (value) { emitConsole('log', [value]); },
    assert: function (condition) {
      if (!condition) emitConsole('error', ['Assertion failed'].concat(Array.prototype.slice.call(arguments, 1)));
    },
    group: noop, groupCollapsed: noop, groupEnd: noop, time: noop, timeEnd: noop, timeLog: noop, count: noop, countReset: noop
  };
  global.console = consoleObject;

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  var timerSeq = 0;
  var timers = new Map();

  function normalizeDelay(ms) {
    ms = Number(ms);
    if (!Number.isFinite(ms) || ms < 0) return 0;
    if (ms > 2147483647) return 1;
    return Math.floor(ms);
  }

  function makeTimer(fn, ms, args, interval) {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    var id = ++timerSeq;
    var handle = {
      id: id,
      ref: function () { return this; },
      unref: function () { return this; },
      hasRef: function () { return true; },
      refresh: function () { return this; },
      valueOf: function () { return id; }
    };
    handle[Symbol.toPrimitive] = function () { return id; };
    var entry = { id: id, fn: fn, args: args, ms: normalizeDelay(ms), interval: interval, cancelled: false, handle: handle };
    timers.set(id, entry);
    schedule(entry);
    return handle;
  }

  function schedule(entry) {
    hostAsync('sleep', entry.ms).then(
      function () {
        var live = timers.get(entry.id);
        if (!live || live.cancelled) return;
        if (!live.interval) timers.delete(live.id);
        try {
          live.fn.apply(undefined, live.args);
        } catch (err) {
          reportFatal(err);
          return;
        }
        if (live.interval && !live.cancelled) schedule(live);
      },
      function () {
        timers.delete(entry.id);
      }
    );
  }

  function cancelTimer(handle) {
    if (handle == null) return;
    var id = typeof handle === 'object' ? handle.id : Number(handle);
    var entry = timers.get(id);
    if (!entry) return;
    entry.cancelled = true;
    timers.delete(id);
  }

  global.setTimeout = function setTimeout(fn, ms) { return makeTimer(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  global.setInterval = function setInterval(fn, ms) { return makeTimer(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  global.setImmediate = function setImmediate(fn) { return makeTimer(fn, 0, Array.prototype.slice.call(arguments, 1), false); };
  global.clearTimeout = cancelTimer;
  global.clearInterval = cancelTimer;
  global.clearImmediate = cancelTimer;
  global.queueMicrotask = function queueMicrotask(fn) {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    Promise.resolve().then(function () {
      try { fn(); } catch (err) { reportFatal(err); }
    });
  };

  // ---------------------------------------------------------------------------
  // process
  // ---------------------------------------------------------------------------

  var env = {};
  try {
    var parsedEnv = envJson ? JSON.parse(envJson) : null;
    if (parsedEnv && typeof parsedEnv === 'object') {
      for (var envKey in parsedEnv) {
        if (parsedEnv[envKey] !== undefined && parsedEnv[envKey] !== null) env[envKey] = String(parsedEnv[envKey]);
      }
    }
  } catch (e) {}
  global.process = { env: env };

  // ---------------------------------------------------------------------------
  // UTF-8 codecs
  // ---------------------------------------------------------------------------

  function utf8Encode(input) {
    var str = String(input);
    var out = new Uint8Array(str.length * 3);
    var o = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
          i++;
        } else {
          c = 0xfffd;
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        c = 0xfffd;
      }
      if (c < 0x80) {
        out[o++] = c;
      } else if (c < 0x800) {
        out[o++] = 0xc0 | (c >> 6);
        out[o++] = 0x80 | (c & 63);
      } else if (c < 0x10000) {
        out[o++] = 0xe0 | (c >> 12);
        out[o++] = 0x80 | ((c >> 6) & 63);
        out[o++] = 0x80 | (c & 63);
      } else {
        out[o++] = 0xf0 | (c >> 18);
        out[o++] = 0x80 | ((c >> 12) & 63);
        out[o++] = 0x80 | ((c >> 6) & 63);
        out[o++] = 0x80 | (c & 63);
      }
    }
    return out.slice(0, o);
  }

  function codePointsToString(points) {
    var parts = [];
    for (var i = 0; i < points.length; i += 8192) {
      parts.push(String.fromCodePoint.apply(null, points.slice(i, i + 8192)));
    }
    return parts.join('');
  }

  // WHATWG Encoding Standard UTF-8 decoder: maximal-subpart replacement.
  function utf8Decode(bytes, fatal, ignoreBOM) {
    var codePoint = 0, bytesSeen = 0, bytesNeeded = 0, lower = 0x80, upper = 0xbf;
    var out = [];
    var start = 0;
    if (!ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
    for (var i = start; i < bytes.length; i++) {
      var b = bytes[i];
      if (bytesNeeded === 0) {
        if (b <= 0x7f) {
          out.push(b);
        } else if (b >= 0xc2 && b <= 0xdf) {
          bytesNeeded = 1;
          codePoint = b & 0x1f;
        } else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) lower = 0xa0;
          if (b === 0xed) upper = 0x9f;
          bytesNeeded = 2;
          codePoint = b & 0xf;
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) lower = 0x90;
          if (b === 0xf4) upper = 0x8f;
          bytesNeeded = 3;
          codePoint = b & 0x7;
        } else {
          if (fatal) throw new TypeError('The encoded data was not valid for encoding utf-8');
          out.push(0xfffd);
        }
        continue;
      }
      if (b < lower || b > upper) {
        codePoint = 0; bytesNeeded = 0; bytesSeen = 0; lower = 0x80; upper = 0xbf;
        if (fatal) throw new TypeError('The encoded data was not valid for encoding utf-8');
        out.push(0xfffd);
        i--; // reprocess this byte as a lead byte
        continue;
      }
      lower = 0x80; upper = 0xbf;
      codePoint = (codePoint << 6) | (b & 0x3f);
      bytesSeen++;
      if (bytesSeen === bytesNeeded) {
        out.push(codePoint);
        codePoint = 0; bytesNeeded = 0; bytesSeen = 0;
      }
    }
    if (bytesNeeded !== 0) {
      if (fatal) throw new TypeError('The encoded data was not valid for encoding utf-8');
      out.push(0xfffd);
    }
    return codePointsToString(out);
  }

  function toBytes(input, what) {
    if (input === undefined) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError(what + ': argument must be an ArrayBuffer or ArrayBufferView');
  }

  var UTF8_LABELS = { 'utf-8': true, 'utf8': true, 'unicode-1-1-utf-8': true, 'unicode11utf8': true, 'unicode20utf8': true, 'x-unicode20utf8': true };

  function TextEncoder() {
    if (!(this instanceof TextEncoder)) throw new TypeError("Class constructor TextEncoder cannot be invoked without 'new'");
  }
  Object.defineProperty(TextEncoder.prototype, 'encoding', { get: function () { return 'utf-8'; }, enumerable: true });
  TextEncoder.prototype.encode = function encode(input) {
    return utf8Encode(input === undefined ? '' : input);
  };
  TextEncoder.prototype.encodeInto = function encodeInto(source, destination) {
    var bytes = utf8Encode(source);
    var written = Math.min(bytes.length, destination.length);
    // Never split a code point: back off to the last complete sequence.
    while (written > 0 && written < bytes.length && (bytes[written] & 0xc0) === 0x80) written--;
    destination.set(bytes.subarray(0, written));
    var read = utf8Decode(bytes.subarray(0, written), false, true).length;
    return { read: read, written: written };
  };

  function TextDecoder(label, options) {
    if (!(this instanceof TextDecoder)) throw new TypeError("Class constructor TextDecoder cannot be invoked without 'new'");
    var name = label === undefined ? 'utf-8' : String(label).trim().toLowerCase();
    if (!UTF8_LABELS[name]) throw new RangeError('The "' + name + '" encoding is not supported on the isolate lane (utf-8 only)');
    this._fatal = !!(options && options.fatal);
    this._ignoreBOM = !!(options && options.ignoreBOM);
  }
  Object.defineProperty(TextDecoder.prototype, 'encoding', { get: function () { return 'utf-8'; }, enumerable: true });
  Object.defineProperty(TextDecoder.prototype, 'fatal', { get: function () { return this._fatal; }, enumerable: true });
  Object.defineProperty(TextDecoder.prototype, 'ignoreBOM', { get: function () { return this._ignoreBOM; }, enumerable: true });
  TextDecoder.prototype.decode = function decode(input) {
    return utf8Decode(toBytes(input, 'TextDecoder.decode'), this._fatal, this._ignoreBOM);
  };

  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;

  // ---------------------------------------------------------------------------
  // base64 (forgiving-base64 per the Infra Standard)
  // ---------------------------------------------------------------------------

  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_LOOKUP = new Int16Array(256).fill(-1);
  for (var bi = 0; bi < B64_CHARS.length; bi++) B64_LOOKUP[B64_CHARS.charCodeAt(bi)] = bi;

  function invalidCharacterError() {
    var err = new Error('Invalid character');
    err.name = 'InvalidCharacterError';
    err.code = 5;
    return err;
  }

  function bytesToBase64(bytes) {
    var out = '';
    var i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64_CHARS[n >> 18] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
    }
    if (i < bytes.length) {
      var rest = bytes[i] << 16;
      if (i + 1 < bytes.length) rest |= bytes[i + 1] << 8;
      out += B64_CHARS[rest >> 18] + B64_CHARS[(rest >> 12) & 63];
      out += i + 1 < bytes.length ? B64_CHARS[(rest >> 6) & 63] : '=';
      out += '=';
    }
    return out;
  }

  function base64ToBytes(input) {
    var s = String(input).replace(/[\t\n\f\r ]/g, '');
    if (s.length % 4 === 0) s = s.replace(/={1,2}$/, '');
    if (s.length % 4 === 1) throw invalidCharacterError();
    var out = new Uint8Array(Math.floor((s.length * 3) / 4));
    var o = 0, acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64_LOOKUP[s.charCodeAt(i) & 0xff];
      if (v < 0 || s.charCodeAt(i) > 0xff) throw invalidCharacterError();
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (acc >> bits) & 0xff;
      }
    }
    return out.subarray(0, o);
  }

  global.btoa = function btoa(data) {
    if (arguments.length === 0) throw new TypeError('1 argument required, but only 0 present');
    var s = String(data);
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 0xff) throw invalidCharacterError();
      bytes[i] = c;
    }
    return bytesToBase64(bytes);
  };

  global.atob = function atob(data) {
    if (arguments.length === 0) throw new TypeError('1 argument required, but only 0 present');
    var bytes = base64ToBytes(data);
    var out = '';
    for (var i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return out;
  };

  // ---------------------------------------------------------------------------
  // application/x-www-form-urlencoded percent-encoding (URLSearchParams only;
  // URL itself is parsed by the host, see below)
  // ---------------------------------------------------------------------------

  // The form-urlencoded percent-encode set: only ASCII alphanumerics and
  // * - . _ stay literal; space becomes '+'.
  function inFormUrlencodedSet(b) {
    return !((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f);
  }

  var HEX = '0123456789ABCDEF';
  function percentEncodeBytes(bytes, inSet, spaceAsPlus) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (spaceAsPlus && b === 0x20) out += '+';
      else if (inSet(b)) out += '%' + HEX[b >> 4] + HEX[b & 15];
      else out += String.fromCharCode(b);
    }
    return out;
  }
  function percentEncodeString(str, inSet, spaceAsPlus) {
    return percentEncodeBytes(utf8Encode(str), inSet, !!spaceAsPlus);
  }

  function isHexDigit(c) { return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66); }
  function percentDecodeBytes(bytes) {
    var out = new Uint8Array(bytes.length);
    var o = 0;
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b === 0x25 && i + 2 < bytes.length && isHexDigit(bytes[i + 1]) && isHexDigit(bytes[i + 2])) {
        out[o++] = parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16);
        i += 2;
      } else {
        out[o++] = b;
      }
    }
    return out.subarray(0, o);
  }

  // ---------------------------------------------------------------------------
  // URLSearchParams
  // ---------------------------------------------------------------------------

  function parseFormUrlencoded(input) {
    var out = [];
    var bytes = utf8Encode(input);
    var start = 0;
    for (var i = 0; i <= bytes.length; i++) {
      if (i === bytes.length || bytes[i] === 0x26) {
        if (i > start) {
          var seq = bytes.subarray(start, i);
          var eq = -1;
          for (var j = 0; j < seq.length; j++) if (seq[j] === 0x3d) { eq = j; break; }
          var nameBytes = eq === -1 ? seq : seq.subarray(0, eq);
          var valueBytes = eq === -1 ? new Uint8Array(0) : seq.subarray(eq + 1);
          out.push([decodeFormComponent(nameBytes), decodeFormComponent(valueBytes)]);
        }
        start = i + 1;
      }
    }
    return out;
  }
  function decodeFormComponent(bytes) {
    var plusToSpace = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) plusToSpace[i] = bytes[i] === 0x2b ? 0x20 : bytes[i];
    return utf8Decode(percentDecodeBytes(plusToSpace), false, true);
  }
  function serializeFormUrlencoded(list) {
    var out = '';
    for (var i = 0; i < list.length; i++) {
      if (i > 0) out += '&';
      out += percentEncodeString(list[i][0], inFormUrlencodedSet, true) + '=' + percentEncodeString(list[i][1], inFormUrlencodedSet, true);
    }
    return out;
  }

  function URLSearchParams(init) {
    if (!(this instanceof URLSearchParams)) throw new TypeError("Class constructor URLSearchParams cannot be invoked without 'new'");
    this._list = [];
    this._url = null;
    if (init === undefined || init === null) return;
    if (typeof init === 'object') {
      if (init instanceof URLSearchParams) {
        this._list = init._list.map(function (p) { return [p[0], p[1]]; });
      } else if (typeof init[Symbol.iterator] === 'function') {
        for (var pair of init) {
          if (pair === null || typeof pair !== 'object' || typeof pair[Symbol.iterator] !== 'function') throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          var items = Array.from(pair);
          if (items.length !== 2) throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          this._list.push([String(items[0]), String(items[1])]);
        }
      } else {
        var keys = Object.keys(init);
        for (var i = 0; i < keys.length; i++) this._list.push([keys[i], String(init[keys[i]])]);
      }
      return;
    }
    var str = String(init);
    if (str.length > 0 && str[0] === '?') str = str.slice(1);
    this._list = parseFormUrlencoded(str);
  }
  URLSearchParams.prototype._update = function () {
    // The spec's update steps: serialize the list and set the URL's query
    // (empty list = no query). The host's URL setter does the rest.
    if (!this._url) return;
    this._url._record = hostSync('urlSet', this._url._record.href, 'search', serializeFormUrlencoded(this._list));
  };
  Object.defineProperty(URLSearchParams.prototype, 'size', { get: function () { return this._list.length; }, enumerable: true });
  URLSearchParams.prototype.append = function (name, value) {
    if (arguments.length < 2) throw new TypeError('2 arguments required, but only ' + arguments.length + ' present');
    this._list.push([String(name), String(value)]);
    this._update();
  };
  URLSearchParams.prototype.delete = function (name, value) {
    name = String(name);
    var hasValue = arguments.length > 1 && value !== undefined;
    if (hasValue) value = String(value);
    this._list = this._list.filter(function (p) { return !(p[0] === name && (!hasValue || p[1] === value)); });
    this._update();
  };
  URLSearchParams.prototype.get = function (name) {
    name = String(name);
    for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === name) return this._list[i][1];
    return null;
  };
  URLSearchParams.prototype.getAll = function (name) {
    name = String(name);
    return this._list.filter(function (p) { return p[0] === name; }).map(function (p) { return p[1]; });
  };
  URLSearchParams.prototype.has = function (name, value) {
    name = String(name);
    var hasValue = arguments.length > 1 && value !== undefined;
    if (hasValue) value = String(value);
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i][0] === name && (!hasValue || this._list[i][1] === value)) return true;
    }
    return false;
  };
  URLSearchParams.prototype.set = function (name, value) {
    if (arguments.length < 2) throw new TypeError('2 arguments required, but only ' + arguments.length + ' present');
    name = String(name);
    value = String(value);
    var replaced = false;
    var next = [];
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i][0] === name) {
        if (!replaced) {
          next.push([name, value]);
          replaced = true;
        }
      } else {
        next.push(this._list[i]);
      }
    }
    if (!replaced) next.push([name, value]);
    this._list = next;
    this._update();
  };
  URLSearchParams.prototype.sort = function () {
    // Stable sort by name, comparing UTF-16 code units.
    this._list = this._list
      .map(function (p, i) { return { p: p, i: i }; })
      .sort(function (a, b) { return a.p[0] < b.p[0] ? -1 : a.p[0] > b.p[0] ? 1 : a.i - b.i; })
      .map(function (e) { return e.p; });
    this._update();
  };
  URLSearchParams.prototype.forEach = function (callback, thisArg) {
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    for (var i = 0; i < this._list.length; i++) callback.call(thisArg, this._list[i][1], this._list[i][0], this);
  };
  URLSearchParams.prototype.entries = function () { return this._list.map(function (p) { return [p[0], p[1]]; })[Symbol.iterator](); };
  URLSearchParams.prototype.keys = function () { return this._list.map(function (p) { return p[0]; })[Symbol.iterator](); };
  URLSearchParams.prototype.values = function () { return this._list.map(function (p) { return p[1]; })[Symbol.iterator](); };
  URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
  URLSearchParams.prototype.toString = function () { return serializeFormUrlencoded(this._list); };
  Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, { value: 'URLSearchParams', configurable: true });

  // ---------------------------------------------------------------------------
  // URL: parsed by the host
  // ---------------------------------------------------------------------------

  // The guest holds a plain record of the components. Every parse and every
  // setter is one synchronous host call into Node's own URL, so the isolate
  // and process lanes agree on every input by construction, IDNA hosts and
  // the percent-encode sets included (those have drifted between Node lines).

  var URL_SETTABLE = ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];

  function stripQuestion(search) { return search.length > 0 && search[0] === '?' ? search.slice(1) : search; }

  function URL(input, base) {
    if (!(this instanceof URL)) throw new TypeError("Class constructor URL cannot be invoked without 'new'");
    if (arguments.length === 0) throw new TypeError('The "url" argument must be specified');
    this._record = hostSync('urlParse', String(input), base === undefined ? undefined : String(base));
    this._searchParams = new URLSearchParams(stripQuestion(this._record.search));
    this._searchParams._url = this;
  }
  URL.canParse = function canParse(input, base) {
    try {
      new URL(input, base);
      return true;
    } catch (e) {
      return false;
    }
  };
  URL.parse = function parse(input, base) {
    try {
      return new URL(input, base);
    } catch (e) {
      return null;
    }
  };
  URL_SETTABLE.forEach(function (name) {
    Object.defineProperty(URL.prototype, name, {
      get: function () { return this._record[name]; },
      set: function (value) {
        this._record = hostSync('urlSet', this._record.href, name, String(value));
        // Node re-parses searchParams whenever the URL is re-serialized.
        this._searchParams._list = parseFormUrlencoded(stripQuestion(this._record.search));
      },
      enumerable: true,
      configurable: true
    });
  });
  Object.defineProperty(URL.prototype, 'origin', { get: function () { return this._record.origin; }, enumerable: true, configurable: true });
  Object.defineProperty(URL.prototype, 'searchParams', { get: function () { return this._searchParams; }, enumerable: true, configurable: true });
  URL.prototype.toString = function () { return this._record.href; };
  URL.prototype.toJSON = function () { return this._record.href; };
  Object.defineProperty(URL.prototype, Symbol.toStringTag, { value: 'URL', configurable: true });

  global.URL = URL;
  global.URLSearchParams = URLSearchParams;

  // ---------------------------------------------------------------------------
  // AbortController / AbortSignal
  // ---------------------------------------------------------------------------

  function abortError(message) {
    var err = new Error(message || 'This operation was aborted');
    err.name = 'AbortError';
    err.code = 20;
    return err;
  }
  function timeoutError() {
    var err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    err.code = 23;
    return err;
  }

  function AbortSignal() {
    if (!(this instanceof AbortSignal)) throw new TypeError("Class constructor AbortSignal cannot be invoked without 'new'");
    this._aborted = false;
    this._reason = undefined;
    this._listeners = [];
    this.onabort = null;
  }
  Object.defineProperty(AbortSignal.prototype, 'aborted', { get: function () { return this._aborted; }, enumerable: true });
  Object.defineProperty(AbortSignal.prototype, 'reason', { get: function () { return this._reason; }, enumerable: true });
  AbortSignal.prototype.throwIfAborted = function () {
    if (this._aborted) throw this._reason;
  };
  AbortSignal.prototype.addEventListener = function (type, listener, options) {
    if (type !== 'abort' || (typeof listener !== 'function' && !(listener && typeof listener.handleEvent === 'function'))) return;
    var once = !!(options && typeof options === 'object' && options.once);
    for (var i = 0; i < this._listeners.length; i++) if (this._listeners[i].listener === listener) return;
    this._listeners.push({ listener: listener, once: once });
    if (options && typeof options === 'object' && options.signal && typeof options.signal.addEventListener === 'function') {
      var self = this;
      options.signal.addEventListener('abort', function () { self.removeEventListener('abort', listener); }, { once: true });
    }
  };
  AbortSignal.prototype.removeEventListener = function (type, listener) {
    if (type !== 'abort') return;
    this._listeners = this._listeners.filter(function (l) { return l.listener !== listener; });
  };
  AbortSignal.prototype.dispatchEvent = function (event) {
    if (!event || event.type !== 'abort') return true;
    fireAbort(this, event);
    return true;
  };
  function fireAbort(signal, event) {
    event = event || { type: 'abort' };
    try { event.target = signal; event.currentTarget = signal; } catch (e) {}
    var listeners = signal._listeners.slice();
    signal._listeners = signal._listeners.filter(function (l) { return !l.once; });
    if (typeof signal.onabort === 'function') {
      try { signal.onabort.call(signal, event); } catch (err) { reportFatal(err); }
    }
    for (var i = 0; i < listeners.length; i++) {
      var l = listeners[i].listener;
      try {
        if (typeof l === 'function') l.call(signal, event);
        else l.handleEvent(event);
      } catch (err) {
        reportFatal(err);
      }
    }
  }
  function signalAbort(signal, reason) {
    if (signal._aborted) return;
    signal._aborted = true;
    signal._reason = reason === undefined ? abortError() : reason;
    fireAbort(signal, { type: 'abort' });
    if (signal._dependents) {
      var deps = signal._dependents;
      signal._dependents = null;
      for (var i = 0; i < deps.length; i++) signalAbort(deps[i], signal._reason);
    }
  }
  AbortSignal.abort = function (reason) {
    var signal = new AbortSignal();
    signalAbort(signal, reason === undefined ? abortError() : reason);
    return signal;
  };
  AbortSignal.timeout = function (ms) {
    var signal = new AbortSignal();
    global.setTimeout(function () { signalAbort(signal, timeoutError()); }, ms);
    return signal;
  };
  AbortSignal.any = function (signals) {
    var result = new AbortSignal();
    var list = Array.from(signals);
    for (var i = 0; i < list.length; i++) {
      if (list[i]._aborted) {
        signalAbort(result, list[i]._reason);
        return result;
      }
    }
    for (var j = 0; j < list.length; j++) {
      if (!list[j]._dependents) list[j]._dependents = [];
      list[j]._dependents.push(result);
    }
    return result;
  };
  Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true });

  function AbortController() {
    if (!(this instanceof AbortController)) throw new TypeError("Class constructor AbortController cannot be invoked without 'new'");
    this.signal = new AbortSignal();
  }
  AbortController.prototype.abort = function (reason) {
    signalAbort(this.signal, reason === undefined ? abortError() : reason);
  };
  Object.defineProperty(AbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true });

  global.AbortSignal = AbortSignal;
  global.AbortController = AbortController;

  // ---------------------------------------------------------------------------
  // Headers
  // ---------------------------------------------------------------------------

  var HEADER_NAME_RE = /^[!#$%&'*+\-.^_` + '`' + String.raw`|~0-9A-Za-z]+$/;
  function normalizeHeaderName(name) {
    name = String(name);
    if (!HEADER_NAME_RE.test(name)) throw new TypeError('Header name must be a valid HTTP token ["' + name + '"]');
    return name.toLowerCase();
  }
  function normalizeHeaderValue(name, value) {
    value = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (/[\0\n\r]/.test(value)) throw new TypeError('Invalid character in header value ["' + name + '"]');
    return value;
  }

  function Headers(init) {
    if (!(this instanceof Headers)) throw new TypeError("Class constructor Headers cannot be invoked without 'new'");
    this._map = new Map();
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      var self = this;
      init._map.forEach(function (values, key) { self._map.set(key, values.slice()); });
      return;
    }
    if (typeof init === 'object' && typeof init[Symbol.iterator] === 'function') {
      for (var pair of init) {
        var items = Array.from(pair);
        if (items.length !== 2) throw new TypeError('Headers constructor: expected name/value pair to be length 2, found ' + items.length);
        this.append(items[0], items[1]);
      }
      return;
    }
    if (typeof init === 'object') {
      var keys = Object.keys(init);
      for (var i = 0; i < keys.length; i++) this.append(keys[i], init[keys[i]]);
      return;
    }
    throw new TypeError('Headers constructor: init must be an object or iterable');
  }
  Headers.prototype.append = function (name, value) {
    var key = normalizeHeaderName(name);
    var v = normalizeHeaderValue(key, value);
    var existing = this._map.get(key);
    if (existing) existing.push(v);
    else this._map.set(key, [v]);
  };
  Headers.prototype.set = function (name, value) {
    var key = normalizeHeaderName(name);
    this._map.set(key, [normalizeHeaderValue(key, value)]);
  };
  Headers.prototype.get = function (name) {
    var values = this._map.get(normalizeHeaderName(name));
    if (!values) return null;
    return values.join(', ');
  };
  Headers.prototype.getSetCookie = function () {
    var values = this._map.get('set-cookie');
    return values ? values.slice() : [];
  };
  Headers.prototype.has = function (name) { return this._map.has(normalizeHeaderName(name)); };
  Headers.prototype.delete = function (name) { this._map.delete(normalizeHeaderName(name)); };
  Headers.prototype._sortedEntries = function () {
    var out = [];
    var keys = Array.from(this._map.keys()).sort();
    for (var i = 0; i < keys.length; i++) {
      var values = this._map.get(keys[i]);
      if (keys[i] === 'set-cookie') {
        for (var j = 0; j < values.length; j++) out.push([keys[i], values[j]]);
      } else {
        out.push([keys[i], values.join(', ')]);
      }
    }
    return out;
  };
  Headers.prototype.forEach = function (callback, thisArg) {
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    var entries = this._sortedEntries();
    for (var i = 0; i < entries.length; i++) callback.call(thisArg, entries[i][1], entries[i][0], this);
  };
  Headers.prototype.entries = function () { return this._sortedEntries()[Symbol.iterator](); };
  Headers.prototype.keys = function () { return this._sortedEntries().map(function (e) { return e[0]; })[Symbol.iterator](); };
  Headers.prototype.values = function () { return this._sortedEntries().map(function (e) { return e[1]; })[Symbol.iterator](); };
  Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
  Object.defineProperty(Headers.prototype, Symbol.toStringTag, { value: 'Headers', configurable: true });
  global.Headers = Headers;

  // ---------------------------------------------------------------------------
  // Response / fetch
  // ---------------------------------------------------------------------------

  var STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

  // Returns { bytes: Uint8Array | null, contentType: string | null }.
  function extractBody(body) {
    if (body === undefined || body === null) return { bytes: null, contentType: null };
    if (typeof body === 'string') return { bytes: utf8Encode(body), contentType: 'text/plain;charset=UTF-8' };
    if (body instanceof URLSearchParams) return { bytes: utf8Encode(body.toString()), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
    if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body.slice(0)), contentType: null };
    if (ArrayBuffer.isView(body)) return { bytes: new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)), contentType: null };
    throw new TypeError('Unsupported body type on the isolate lane: pass a string, URLSearchParams, ArrayBuffer or ArrayBufferView');
  }

  function Response(body, init) {
    if (!(this instanceof Response)) throw new TypeError("Class constructor Response cannot be invoked without 'new'");
    init = init || {};
    var status = init.status === undefined ? 200 : Number(init.status);
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new RangeError('init["status"] must be in the range of 200 to 599, inclusive.');
    var extracted = extractBody(body);
    this._bytes = extracted.bytes;
    this._bodyUsed = false;
    this.status = status;
    this.statusText = init.statusText === undefined ? (STATUS_TEXT[status] || '') : String(init.statusText);
    this.headers = new Headers(init.headers);
    if (extracted.contentType && !this.headers.has('content-type')) this.headers.set('content-type', extracted.contentType);
    this.url = init.url === undefined ? '' : String(init.url);
    this.redirected = !!init.redirected;
    this.type = 'basic';
    // Streams are not available on this lane; the body is always buffered.
    this.body = null;
  }
  Object.defineProperty(Response.prototype, 'ok', { get: function () { return this.status >= 200 && this.status <= 299; }, enumerable: true });
  Object.defineProperty(Response.prototype, 'bodyUsed', { get: function () { return this._bodyUsed; }, enumerable: true });
  Response.prototype._consume = function () {
    if (this._bodyUsed) return Promise.reject(new TypeError('Body is unusable: Body has already been read'));
    this._bodyUsed = true;
    return Promise.resolve(this._bytes || new Uint8Array(0));
  };
  Response.prototype.arrayBuffer = function () {
    return this._consume().then(function (bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); });
  };
  Response.prototype.bytes = function () {
    return this._consume().then(function (bytes) { return new Uint8Array(bytes); });
  };
  Response.prototype.text = function () {
    return this._consume().then(function (bytes) { return utf8Decode(bytes, false, false); });
  };
  Response.prototype.json = function () {
    return this.text().then(function (text) { return JSON.parse(text); });
  };
  Response.prototype.clone = function () {
    if (this._bodyUsed) throw new TypeError('Response.clone: Body has already been consumed.');
    return new Response(this._bytes ? new Uint8Array(this._bytes) : null, {
      status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, redirected: this.redirected
    });
  };
  Response.error = function () {
    var r = new Response(null, { status: 200 });
    r.status = 0;
    r.statusText = '';
    r.type = 'error';
    return r;
  };
  Response.json = function (data, init) {
    init = init || {};
    var headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), { status: init.status, statusText: init.statusText, headers: headers });
  };
  Object.defineProperty(Response.prototype, Symbol.toStringTag, { value: 'Response', configurable: true });
  global.Response = Response;

  var fetchSeq = 0;

  function fetch(input, init) {
    return new Promise(function (resolve) { resolve(); }).then(function () {
      init = init || {};
      var requestLike = input !== null && typeof input === 'object' && !(input instanceof URL) ? input : null;
      var rawUrl = requestLike ? requestLike.url : input;
      var parsed;
      try {
        parsed = new URL(String(rawUrl));
      } catch (e) {
        var bad = new TypeError('Failed to parse URL from ' + String(rawUrl));
        bad.cause = e;
        throw bad;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new TypeError('fetch failed: only http: and https: URLs are supported on the isolate lane');
      }
      var method = String(init.method || (requestLike && requestLike.method) || 'GET').toUpperCase();
      var headers = new Headers(init.headers !== undefined ? init.headers : (requestLike ? requestLike.headers : undefined));
      var signal = init.signal || (requestLike ? requestLike.signal : null) || null;
      if (signal && signal.aborted) throw signal.reason === undefined ? abortError() : signal.reason;
      var extracted = extractBody(init.body !== undefined ? init.body : (requestLike ? requestLike.body : undefined));
      if (extracted.bytes && (method === 'GET' || method === 'HEAD')) throw new TypeError('Request with GET/HEAD method cannot have body.');
      if (extracted.contentType && !headers.has('content-type')) headers.set('content-type', extracted.contentType);
      var redirect = init.redirect === undefined ? 'follow' : String(init.redirect);
      if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') throw new TypeError('Invalid redirect mode: ' + redirect);
      var id = ++fetchSeq;
      var onAbort = null;
      if (signal) {
        onAbort = function () { try { hostSync('fetchAbort', id); } catch (e) {} };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      var request = { id: id, url: parsed.href, method: method, headers: headers._sortedEntries(), redirect: redirect };
      return hostAsync('fetch', request, extracted.bytes === null ? undefined : extracted.bytes).then(
        function (reply) {
          if (onAbort) signal.removeEventListener('abort', onAbort);
          return new Response(reply.body, {
            status: reply.status, statusText: reply.statusText, headers: reply.headers, url: reply.url, redirected: reply.redirected
          });
        },
        function (err) {
          if (onAbort) signal.removeEventListener('abort', onAbort);
          if (signal && signal.aborted) throw signal.reason === undefined ? abortError() : signal.reason;
          throw err;
        }
      );
    });
  }
  global.fetch = fetch;
})(globalThis);
`;
