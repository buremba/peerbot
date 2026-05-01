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
import { generateWorkerToken } from "@lobu/core";
import {
  __testOnly,
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
  // Default to unrestricted for auth tests; domain tests use per-deployment config
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
// Domain restriction via per-agent grants requires Redis and is tested separately.

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
