import * as crypto from "node:crypto";
import type { LookupAddress } from "node:dns";
import * as http from "node:http";
import * as net from "node:net";
import { generateWorkerToken } from "@lobu/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __testOnly,
  startHttpProxy,
  stopHttpProxy,
} from "../../../gateway/proxy/http-proxy.js";

// SSRF / network-proxy hardening regression coverage.
//
//  - IPv4-mapped IPv6 loopback (decimal + hex) → blocked
//  - NAT64 (64:ff9b::/96) wrapping an internal IPv4 → blocked
//  - zone-id'd literals + malformed IP literals → rejected (fail closed)
//  - CONNECT port outside 1..65535 → 400
//  - a public host → permitted past auth + domain + IP checks
//  - a host that resolves to a private IP → 403 (and the proxy connects to
//    the already-validated resolved IP, never re-resolving — DNS rebinding)

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

let proxyPort: number;
let proxyServer: http.Server;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  process.env.WORKER_ALLOWED_DOMAINS = "*";
  proxyPort = 10000 + Math.floor(Math.random() * 50000);
  proxyServer = await startHttpProxy(proxyPort, "127.0.0.1");
});

afterAll(async () => {
  await stopHttpProxy(proxyServer);
  delete process.env.ENCRYPTION_KEY;
  delete process.env.WORKER_ALLOWED_DOMAINS;
});

afterEach(() => {
  __testOnly.setDnsLookup(null);
  __testOnly.setUpstreamRequestTimeoutMs(null);
});

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function token(deployment: string): string {
  return generateWorkerToken("u", "c", deployment, {
    channelId: "ch",
    platform: "test",
  });
}

function rawGet(
  targetUrl: string,
  auth: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    socket.connect(proxyPort, "127.0.0.1", () => {
      socket.write(
        `GET ${targetUrl} HTTP/1.1\r\nHost: ${new URL(targetUrl).host}\r\n` +
          `Proxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`
      );
    });
    let data = "";
    socket.on("data", (c: Buffer) => {
      data += c.toString();
    });
    const timer = setTimeout(() => {
      socket.destroy();
      finish();
    }, 1000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const statusMatch = data.match(/^HTTP\/\d\.\d (\d+)/);
      const headerEnd = data.indexOf("\r\n\r\n");
      resolve({
        statusCode: statusMatch ? Number.parseInt(statusMatch[1]!, 10) : 0,
        body: headerEnd !== -1 ? data.slice(headerEnd + 4) : "",
      });
    };
    socket.on("end", finish);
    socket.on("error", reject);
    // The proxy answers auth/domain/IP rejections immediately; only an
    // upstream connect attempt can stall. Treat a stall as "no proxy-side
    // rejection arrived" — fine for the permitted-host assertion.
  });
}

function connectReq(
  host: string,
  port: number,
  auth: string
): Promise<{ statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.connect(proxyPort, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
          `Proxy-Authorization: ${auth}\r\n\r\n`
      );
    });
    let data = "";
    socket.on("data", (c: Buffer) => {
      data += c.toString();
      const lineEnd = data.indexOf("\r\n");
      if (lineEnd !== -1) {
        socket.destroy();
        resolve({ statusLine: data.slice(0, lineEnd) });
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  });
}

describe("IP normalization (isBlockedIpAddress)", () => {
  it("blocks IPv4-mapped IPv6 loopback — dotted form", () => {
    expect(__testOnly.isBlockedIpAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 loopback — hex form", () => {
    expect(__testOnly.isBlockedIpAddress("::ffff:7f00:1")).toBe(true);
    // c000:0201 == 192.0.2.1 is public; 7f00:0001 == 127.0.0.1 is loopback.
    expect(__testOnly.isBlockedIpAddress("::ffff:7f00:0001")).toBe(true);
  });

  it("blocks NAT64-wrapped internal IPv4 (64:ff9b::/96)", () => {
    expect(__testOnly.isBlockedIpAddress("64:ff9b::7f00:1")).toBe(true);
    expect(__testOnly.isBlockedIpAddress("64:ff9b::127.0.0.1")).toBe(true);
    // link-local 169.254.169.254 (cloud metadata) wrapped in NAT64
    expect(__testOnly.isBlockedIpAddress("64:ff9b::a9fe:a9fe")).toBe(true);
  });

  it("strips zone IDs before checking", () => {
    expect(__testOnly.isBlockedIpAddress("fe80::1%eth0")).toBe(true);
    expect(__testOnly.isBlockedIpAddress("::1%lo0")).toBe(true);
  });

  it("fails closed on malformed IP-looking literals", () => {
    expect(__testOnly.isBlockedIpAddress("::ffff:zzzz:1")).toBe(true);
    expect(__testOnly.isBlockedIpAddress("64:ff9b::nope")).toBe(true);
    expect(__testOnly.isBlockedIpAddress("fe80::g%eth0")).toBe(true);
  });

  it("permits genuine public addresses", () => {
    expect(__testOnly.isBlockedIpAddress("8.8.8.8")).toBe(false);
    expect(__testOnly.isBlockedIpAddress("::ffff:8.8.8.8")).toBe(false);
    expect(__testOnly.isBlockedIpAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("treats hostnames as not-an-IP (caller resolves them)", () => {
    expect(__testOnly.isBlockedIpAddress("example.com")).toBe(false);
  });
});

describe("HTTP proxy SSRF guards", () => {
  const deployment = "ssrf-test-worker";

  it("denies HTTP request to IPv4-mapped IPv6 loopback (dotted)", async () => {
    const res = await rawGet(
      "http://[::ffff:127.0.0.1]/",
      basicAuth(deployment, token(deployment))
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Target IP not allowed");
  });

  it("denies HTTP request to IPv4-mapped IPv6 loopback (hex)", async () => {
    const res = await rawGet(
      "http://[::ffff:7f00:1]/",
      basicAuth(deployment, token(deployment))
    );
    expect(res.statusCode).toBe(403);
  });

  it("denies CONNECT with out-of-range port", async () => {
    const res = await connectReq(
      "example.com",
      99999,
      basicAuth(deployment, token(deployment))
    );
    expect(res.statusLine).toContain("400");
  });

  it("denies CONNECT with port 0", async () => {
    const res = await connectReq(
      "example.com",
      0,
      basicAuth(deployment, token(deployment))
    );
    expect(res.statusLine).toContain("400");
  });

  it("permits a public host past auth + domain + IP checks", async () => {
    // Stand up a local origin and point the (mocked) resolver for the public
    // host at it. 127.0.0.1 itself is blocked, but the proxy connects to the
    // address the resolver returns — so routing the validated path to a
    // loopback origin would be rejected. Instead resolve to a non-loopback,
    // unreachable public IP and assert the proxy did NOT reject it with
    // 407/403: it got past auth + domain + IP checks and only then failed to
    // open the upstream socket (502). That's the "permitted" outcome.
    __testOnly.setDnsLookup(
      async (): Promise<LookupAddress[]> => [
        { address: "203.0.113.10", family: 4 },
      ]
    );
    __testOnly.setUpstreamRequestTimeoutMs(250);
    const res = await rawGet(
      "http://public.example/",
      basicAuth(deployment, token(deployment))
    );
    expect(res.statusCode).not.toBe(407);
    expect(res.statusCode).not.toBe(403);
  });

  it("denies a host that resolves to a private IP", async () => {
    __testOnly.setDnsLookup(
      async (): Promise<LookupAddress[]> => [
        { address: "10.1.2.3", family: 4 },
      ]
    );
    const res = await rawGet(
      "http://internal.example/",
      basicAuth(deployment, token(deployment))
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("local/private IP");
  });

  it("connects to the validated resolved IP, never re-resolving (DNS rebinding)", async () => {
    // First lookup: public IP pointed at a local trap server. Any later
    // lookup would return loopback. The proxy must issue exactly one lookup
    // and connect only to the validated address.
    let trapHit = false;
    const trap = http.createServer((_req, res) => {
      trapHit = true;
      res.writeHead(200);
      res.end("trapped");
    });
    await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve));
    const trapAddr = trap.address() as net.AddressInfo;

    let calls = 0;
    __testOnly.setDnsLookup(async (): Promise<LookupAddress[]> => {
      calls += 1;
      return calls === 1
        ? [{ address: "203.0.113.7", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    });
    __testOnly.setUpstreamRequestTimeoutMs(250);

    const client = new net.Socket();
    try {
      await new Promise<void>((resolve) => {
        client.on("error", () => resolve());
        client.connect(proxyPort, "127.0.0.1", () => {
          client.write(
            `GET http://rebind.example:${trapAddr.port}/ HTTP/1.1\r\n` +
              `Host: rebind.example:${trapAddr.port}\r\n` +
              `Proxy-Authorization: ${basicAuth(deployment, token(deployment))}\r\n` +
              "Connection: close\r\n\r\n"
          );
          resolve();
        });
      });
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        trap.close((err) => (err ? reject(err) : resolve()))
      );
    }

    expect(calls).toBe(1);
    expect(trapHit).toBe(false);
  });
});
