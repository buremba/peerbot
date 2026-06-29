import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import * as crypto from "node:crypto";
import type { LookupAddress } from "node:dns";
import * as http from "node:http";
import * as net from "node:net";
import { generateWorkerToken, verifyWorkerToken } from "@lobu/core";
import type { RevokedTokenStore } from "../auth/revoked-token-store.js";
import {
  __testOnly,
  type ResolvedNetworkConfig,
  resolveNetworkConfig,
  setProxyRevokedTokenStore,
  startHttpProxy,
  stopHttpProxy,
} from "../proxy/http-proxy.js";

// Generate a stable 32-byte encryption key for tests
const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

// Single proxy server shared across all test suites
let proxyPort: number;
let proxyServer: http.Server;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  // Unrestricted for the auth + unrestricted-mode tests. `startHttpProxy`
  // snapshots this env into the server's immutable config, so every request in
  // this file sees "*" regardless of what a sibling test file left in the shared
  // module/env — no ordering dependence, no reset needed.
  process.env.WORKER_ALLOWED_DOMAINS = "*";

  proxyPort = 10000 + Math.floor(Math.random() * 50000);
  proxyServer = await startHttpProxy(proxyPort, "127.0.0.1");
});

afterAll(async () => {
  await stopHttpProxy(proxyServer);
  delete process.env.ENCRYPTION_KEY;
  delete process.env.WORKER_ALLOWED_DOMAINS;
});

function makeBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * Send a raw HTTP proxy request via TCP socket to avoid Bun's HTTP client
 * retrying on 407 responses.
 */
function rawProxyRequest(
  targetUrl: string,
  options: { proxyAuth?: string } = {}
): Promise<{ statusCode: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.connect(proxyPort, "127.0.0.1", () => {
      let req = `GET ${targetUrl} HTTP/1.1\r\nHost: ${new URL(targetUrl).host}\r\n`;
      if (options.proxyAuth) {
        req += `Proxy-Authorization: ${options.proxyAuth}\r\n`;
      }
      req += "Connection: close\r\n\r\n";
      socket.write(req);
    });

    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });

    socket.on("end", () => {
      // Parse status code from first line: "HTTP/1.1 407 ..."
      const firstLineEnd = data.indexOf("\r\n");
      const statusLine = data.substring(0, firstLineEnd);
      const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;

      const headerEnd = data.indexOf("\r\n\r\n");
      const headers = data.substring(0, headerEnd);
      const body = headerEnd !== -1 ? data.substring(headerEnd + 4) : "";

      resolve({ statusCode, headers, body });
    });

    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

/**
 * Send a CONNECT request through the proxy and return the raw response line.
 */
function connectRequest(
  host: string,
  port: number,
  options: { proxyAuth?: string } = {}
): Promise<{ statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.connect(proxyPort, "127.0.0.1", () => {
      let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (options.proxyAuth) {
        req += `Proxy-Authorization: ${options.proxyAuth}\r\n`;
      }
      req += "\r\n";
      socket.write(req);
    });

    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      const lineEnd = data.indexOf("\r\n");
      if (lineEnd !== -1) {
        socket.destroy();
        resolve({ statusLine: data.substring(0, lineEnd) });
      }
    });

    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("CONNECT request timed out"));
    });
  });
}

function createValidToken(deploymentName: string): string {
  return generateWorkerToken("test-user", "test-conv", deploymentName, {
    channelId: "test-channel",
    platform: "test",
  });
}

// ─── Auth tests ──────────────────────────────────────────────────────────────

describe("HTTP Proxy Authentication", () => {
  describe("HTTP requests", () => {
    test("rejects request with no auth (407)", async () => {
      const res = await rawProxyRequest("http://example.com/test");
      expect(res.statusCode).toBe(407);
      expect(res.headers.toLowerCase()).toContain("proxy-authenticate");
    });

    test("rejects request with invalid token (407)", async () => {
      const res = await rawProxyRequest("http://example.com/test", {
        proxyAuth: makeBasicAuth("my-deployment", "not-a-valid-token"),
      });
      expect(res.statusCode).toBe(407);
    });

    test("rejects request with deployment name mismatch (407)", async () => {
      const token = createValidToken("real-deployment");
      const res = await rawProxyRequest("http://example.com/test", {
        proxyAuth: makeBasicAuth("fake-deployment", token),
      });
      expect(res.statusCode).toBe(407);
    });

    test("rejects request with empty password (407)", async () => {
      const res = await rawProxyRequest("http://example.com/test", {
        proxyAuth: makeBasicAuth("my-deployment", ""),
      });
      expect(res.statusCode).toBe(407);
    });

    test("accepts request with valid token", async () => {
      const deploymentName = "test-worker-http";
      const token = createValidToken(deploymentName);
      const res = await rawProxyRequest("http://example.com/", {
        proxyAuth: makeBasicAuth(deploymentName, token),
      });
      // Should pass auth — either upstream response or 502 (network error)
      expect(res.statusCode).not.toBe(407);
    });
  });

  // ─── F1: cross-replica revocation ───────────────────────────────────────────
  // A worker token revoked on pod A is invisible to pod B's in-memory cache.
  // The proxy auth path must consult the DB-backed `isRevoked()` on a cache
  // miss, not the cache-only `isRevokedCached()`. We model "revoked on another
  // pod" with a store whose cache (`isRevokedCached`) reports the jti as
  // unknown but whose authoritative `isRevoked()` (DB) reports it revoked.
  describe("revoked worker token (multi-replica)", () => {
    // A jti already known-revoked in THIS pod's cache (revoked locally, or
    // pulled in by a prior background refresh). The hot path denies it.
    function makeCachedRevokedStore(revokedJti: string): RevokedTokenStore {
      return {
        async isRevoked(jti: string): Promise<boolean> {
          return jti === revokedJti;
        },
        isRevokedCached(jti: string): boolean {
          return jti === revokedJti;
        },
      } as unknown as RevokedTokenStore;
    }

    afterEach(() => {
      setProxyRevokedTokenStore(null);
    });

    test("denies an HTTP request whose jti is revoked in this pod's cache (407)", async () => {
      const deploymentName = "revoked-http-worker";
      const token = createValidToken(deploymentName);
      const jti = verifyWorkerToken(token)?.jti;
      expect(jti).toBeTruthy();

      setProxyRevokedTokenStore(makeCachedRevokedStore(jti!));

      const res = await rawProxyRequest("http://example.com/", {
        proxyAuth: makeBasicAuth(deploymentName, token),
      });
      expect(res.statusCode).toBe(407);
    });

    test("denies a CONNECT tunnel whose jti is revoked in this pod's cache (407)", async () => {
      const deploymentName = "revoked-connect-worker";
      const token = createValidToken(deploymentName);
      const jti = verifyWorkerToken(token)?.jti;
      expect(jti).toBeTruthy();

      setProxyRevokedTokenStore(makeCachedRevokedStore(jti!));

      const res = await connectRequest("example.com", 443, {
        proxyAuth: makeBasicAuth(deploymentName, token),
      });
      expect(res.statusLine).toContain("407");
    });

    test("a DIFFERENT (non-revoked) token still passes auth under the same store", async () => {
      const deploymentName = "live-worker";
      const token = createValidToken(deploymentName);
      // Revoke some OTHER jti — this token must remain valid.
      setProxyRevokedTokenStore(makeCachedRevokedStore("some-other-jti"));

      const res = await rawProxyRequest("http://example.com/", {
        proxyAuth: makeBasicAuth(deploymentName, token),
      });
      expect(res.statusCode).not.toBe(407);
    });

    test("a cross-replica revoke not yet cached is allowed once, then refreshed into the cache via a background DB lookup", async () => {
      const deploymentName = "cross-replica-worker";
      const token = createValidToken(deploymentName);
      const jti = verifyWorkerToken(token)?.jti;
      expect(jti).toBeTruthy();

      let isRevokedCalls = 0;
      // The shared DB sees the cross-pod revoke; this pod's cache hasn't yet.
      const store = {
        async isRevoked(j: string): Promise<boolean> {
          isRevokedCalls += 1;
          return j === jti;
        },
        isRevokedCached(_j: string): boolean {
          return false;
        },
      } as unknown as RevokedTokenStore;
      setProxyRevokedTokenStore(store);

      // First request: cache miss → allowed (egress is never blocked on the DB),
      // but the proxy must fire a background refresh so a later request is denied.
      const res = await rawProxyRequest("http://example.com/", {
        proxyAuth: makeBasicAuth(deploymentName, token),
      });
      expect(res.statusCode).not.toBe(407);

      await new Promise((r) => setTimeout(r, 50));
      expect(isRevokedCalls).toBeGreaterThan(0);
    });
  });

  describe("CONNECT requests", () => {
    test("rejects CONNECT with no auth (407)", async () => {
      const res = await connectRequest("example.com", 443);
      expect(res.statusLine).toContain("407");
    });

    test("rejects CONNECT with invalid token (407)", async () => {
      const res = await connectRequest("example.com", 443, {
        proxyAuth: makeBasicAuth("my-deployment", "garbage-token"),
      });
      expect(res.statusLine).toContain("407");
    });

    test("rejects CONNECT with deployment mismatch (407)", async () => {
      const token = createValidToken("actual-deployment");
      const res = await connectRequest("example.com", 443, {
        proxyAuth: makeBasicAuth("wrong-deployment", token),
      });
      expect(res.statusLine).toContain("407");
    });

    test("accepts CONNECT with valid token (200)", async () => {
      const deploymentName = "test-worker-connect";
      const token = createValidToken(deploymentName);
      const res = await connectRequest("example.com", 443, {
        proxyAuth: makeBasicAuth(deploymentName, token),
      });
      expect(res.statusLine).toContain("200");
    });
  });
});

// ─── Startup tests ───────────────────────────────────────────────────────────

describe("HTTP Proxy Startup", () => {
  test("rejects on port conflict (EADDRINUSE)", async () => {
    const blockingPort = 10000 + Math.floor(Math.random() * 50000);
    const blocker = http.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(blockingPort, "127.0.0.1", resolve)
    );

    try {
      await expect(
        startHttpProxy(blockingPort, "127.0.0.1")
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  test("binds to specified host and port", async () => {
    const port = 10000 + Math.floor(Math.random() * 50000);
    const server = await startHttpProxy(port, "127.0.0.1");
    try {
      const addr = server.address();
      expect(addr).not.toBeNull();
      if (typeof addr === "object" && addr) {
        expect(addr.port).toBe(port);
        expect(addr.address).toBe("127.0.0.1");
      }
    } finally {
      await stopHttpProxy(server);
    }
  });
});

// ─── Domain filtering tests ──────────────────────────────────────────────────
// Global config is WORKER_ALLOWED_DOMAINS=* (unrestricted), so all domains pass.
// Domain restriction via per-agent grants is tested separately.

describe("HTTP Proxy Domain Filtering (unrestricted mode)", () => {
  const deploymentName = "domain-test-worker";

  test("rejects request to loopback IP literal", async () => {
    const token = createValidToken(deploymentName);
    const res = await rawProxyRequest("http://127.0.0.1/", {
      proxyAuth: makeBasicAuth(deploymentName, token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Target IP not allowed");
  });

  test("rejects request to IPv4-mapped IPv6 loopback (hex form)", async () => {
    expect(__testOnly.isBlockedIpAddress("::ffff:7f00:1")).toBe(true);
  });

  test("rejects NAT64 loopback — compressed form (64:ff9b::7f00:1 → 127.0.0.1)", async () => {
    expect(__testOnly.isBlockedIpAddress("64:ff9b::7f00:1")).toBe(true);
  });

  test("rejects NAT64 link-local — expanded form (64:ff9b:0:0:0:0:a9fe:a9fe → 169.254.169.254)", async () => {
    // Regression: startsWith("64:ff9b::") missed this fully-expanded spelling.
    expect(__testOnly.isBlockedIpAddress("64:ff9b:0:0:0:0:a9fe:a9fe")).toBe(
      true
    );
  });

  test("allows NAT64 public address — expanded form (64:ff9b:0:0:0:0:cb00:7101 → 203.0.113.1)", async () => {
    expect(__testOnly.isBlockedIpAddress("64:ff9b:0:0:0:0:cb00:7101")).toBe(
      false
    );
  });

  test("rejects CONNECT when hostname resolves to loopback", async () => {
    const token = createValidToken(deploymentName);
    const res = await connectRequest("localhost", 443, {
      proxyAuth: makeBasicAuth(deploymentName, token),
    });
    expect(res.statusLine).toContain("403");
  });

  test("allows request to any domain in unrestricted mode", async () => {
    const token = createValidToken(deploymentName);
    const res = await rawProxyRequest("http://example.com/", {
      proxyAuth: makeBasicAuth(deploymentName, token),
    });
    // Passes auth + domain check — either upstream response or 502
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(407);
  });

  test("allows CONNECT to any domain in unrestricted mode", async () => {
    const token = createValidToken(deploymentName);
    const res = await connectRequest("example.com", 443, {
      proxyAuth: makeBasicAuth(deploymentName, token),
    });
    expect(res.statusLine).toContain("200");
  });
});

// ─── IDN / Unicode egress matching (#10 + #11) ───────────────────────────────
// A Unicode WORKER_DISALLOWED_DOMAINS entry must block BOTH the punycode host
// the HTTP path derives (`new URL().hostname` === "xn--mnchen-3ya.de") AND the
// raw Unicode host the CONNECT path extracts verbatim ("münchen.de"). Before
// the fix, normalizeDomainPattern only lowercased the pattern (stayed Unicode)
// and canonicalizeHostname didn't punycode the CONNECT host, so the HTTP host
// slipped past the blocklist and CONNECT vs HTTP disagreed for the same host.

describe("HTTP Proxy IDN/Unicode egress matching", () => {
  const HTTP_HOST = "xn--mnchen-3ya.de"; // what `new URL("http://münchen.de/").hostname` yields
  const CONNECT_HOST = "münchen.de"; // what the CONNECT parser returns verbatim

  // Snapshot the unrestricted-with-blocklist config and pass it into each
  // checkDomainAccess call — no shared module state, no cross-file env race.
  let config: ResolvedNetworkConfig;

  const prevAllowed = process.env.WORKER_ALLOWED_DOMAINS;
  const prevDisallowed = process.env.WORKER_DISALLOWED_DOMAINS;

  beforeAll(() => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    process.env.WORKER_DISALLOWED_DOMAINS = "münchen.de";
    config = resolveNetworkConfig();
  });

  afterAll(() => {
    // Restore the pre-suite env rather than hardcoding cleanup, so this block
    // can't leak its blocklist into later files in Bun's shared process.
    if (prevAllowed === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
    else process.env.WORKER_ALLOWED_DOMAINS = prevAllowed;
    if (prevDisallowed === undefined) delete process.env.WORKER_DISALLOWED_DOMAINS;
    else process.env.WORKER_DISALLOWED_DOMAINS = prevDisallowed;
  });

  test("punycode host (HTTP path) is blocked by the Unicode blocklist entry", async () => {
    const decision = await __testOnly.checkDomainAccess(
      config,
      HTTP_HOST,
      "idn-test-agent",
      undefined
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("global");
  });

  test("Unicode host (CONNECT path) is blocked by the same blocklist entry", async () => {
    const decision = await __testOnly.checkDomainAccess(
      config,
      CONNECT_HOST,
      "idn-test-agent",
      undefined
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("global");
  });

  test("CONNECT and HTTP forms canonicalize to the same ASCII name", () => {
    expect(__testOnly.canonicalizeHostname(CONNECT_HOST)).toBe(HTTP_HOST);
    expect(__testOnly.canonicalizeHostname(HTTP_HOST)).toBe(HTTP_HOST);
  });
});

// ─── DNS pinning / rebinding tests ───────────────────────────────────────────
// Regression coverage for https://github.com/lobu-ai/lobu/issues/252.
// The proxy must do exactly one DNS lookup per request, validate that result,
// and connect to the validated IP — so a resolver that flips between a public
// and an internal IP cannot bypass the internal-IP block.

describe("HTTP Proxy DNS pinning", () => {
  const deploymentName = "dns-pin-worker";

  afterEach(() => {
    __testOnly.setDnsLookup(null);
  });

  interface MockLookupState {
    calls: number;
    firstCall: Promise<void>;
  }

  function mockLookup(addresses: LookupAddress[][]): MockLookupState {
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const state: MockLookupState = { calls: 0, firstCall };
    __testOnly.setDnsLookup(async () => {
      const i = Math.min(state.calls, addresses.length - 1);
      state.calls += 1;
      if (state.calls === 1) resolveFirst();
      return addresses[i]!;
    });
    return state;
  }

  test("blocks when DNS returns a mix of public and loopback IPs", async () => {
    mockLookup([
      [
        { address: "203.0.113.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    ]);
    const token = createValidToken(deploymentName);
    const res = await rawProxyRequest("http://rebind.test/", {
      proxyAuth: makeBasicAuth(deploymentName, token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("local/private IP");
  });

  test("blocks CONNECT when DNS returns a mix of public and loopback IPs", async () => {
    mockLookup([
      [
        { address: "203.0.113.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    ]);
    const token = createValidToken(deploymentName);
    const res = await connectRequest("rebind.test", 443, {
      proxyAuth: makeBasicAuth(deploymentName, token),
    });
    expect(res.statusLine).toContain("403");
  });

  async function issueRawRequest(request: string): Promise<net.Socket> {
    const client = new net.Socket();
    await new Promise<void>((resolve, reject) => {
      client.on("error", reject);
      client.connect(proxyPort, "127.0.0.1", () => {
        client.write(request);
        resolve();
      });
    });
    return client;
  }

  test("performs exactly one DNS lookup per HTTP proxy request", async () => {
    const state = mockLookup([[{ address: "203.0.113.1", family: 4 }]]);
    const token = createValidToken(deploymentName);
    const auth = makeBasicAuth(deploymentName, token);
    const client = await issueRawRequest(
      `GET http://rebind.test/ HTTP/1.1\r\nHost: rebind.test\r\n` +
        `Proxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`
    );
    try {
      await state.firstCall;
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      client.destroy();
    }
    expect(state.calls).toBe(1);
  });

  test("performs exactly one DNS lookup per CONNECT request", async () => {
    const state = mockLookup([[{ address: "203.0.113.1", family: 4 }]]);
    const token = createValidToken(deploymentName);
    const auth = makeBasicAuth(deploymentName, token);
    const client = await issueRawRequest(
      `CONNECT rebind.test:443 HTTP/1.1\r\nHost: rebind.test:443\r\n` +
        `Proxy-Authorization: ${auth}\r\n\r\n`
    );
    try {
      await state.firstCall;
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      client.destroy();
    }
    expect(state.calls).toBe(1);
  });

  test("is flip-resistant: connects to first IP even if resolver later returns loopback", async () => {
    // First lookup returns a public IP; any subsequent lookup would return
    // loopback. The proxy must never issue that second lookup, and must not
    // land a connection on the loopback trap even if it did.
    const state = mockLookup([
      [{ address: "203.0.113.1", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }],
    ]);

    let loopbackHit = false;
    const trap = http.createServer((_req, res) => {
      loopbackHit = true;
      res.writeHead(200);
      res.end("trapped");
    });
    await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve));
    const trapAddr = trap.address() as net.AddressInfo;

    const client = new net.Socket();
    try {
      // Fire the proxy request via a raw socket. Wait for the mocked DNS
      // lookup to be called once (signal), then give the event loop a small
      // settle window for any follow-up connect attempt to land on the trap
      // before asserting. We don't wait for the upstream connect to
      // 203.0.113.1 to fail — that can take seconds on CI.
      const token = createValidToken(deploymentName);
      await new Promise<void>((resolve) => {
        client.on("error", () => resolve());
        client.connect(proxyPort, "127.0.0.1", () => {
          client.write(
            `GET http://rebind.test:${trapAddr.port}/ HTTP/1.1\r\n` +
              `Host: rebind.test:${trapAddr.port}\r\n` +
              `Proxy-Authorization: ${makeBasicAuth(deploymentName, token)}\r\n` +
              "Connection: close\r\n\r\n"
          );
          resolve();
        });
      });
      await state.firstCall;
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        trap.close((err) => (err ? reject(err) : resolve()))
      );
    }

    expect(state.calls).toBe(1);
    expect(loopbackHit).toBe(false);
  });
});
