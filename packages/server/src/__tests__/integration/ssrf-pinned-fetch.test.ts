/**
 * Node-runtime integration for ssrfSafeFetch's pinned connect.lookup.
 *
 * Production runs the server under Node (undici fetch), where the `dispatcher`
 * RequestInit option is honored. undici invokes `connect.lookup` with
 * `{ all: true }` and expects the Node dns.lookup all-form callback (an array of
 * `{ address, family }`). The original lookup only ever returned the scalar
 * `(err, address, family)` form, so real upstream MCP/OAuth fetches failed
 * before a socket was even opened. This pins that contract by driving a real
 * fetch through a dispatcher built with the pinned lookup against a loopback
 * server (the reserved-IP guard is covered by ip-blocklist-ssrf.test.ts and is
 * intentionally bypassed here).
 *
 * Lives in the vitest tree (Node) rather than the bun:test gateway suite because
 * Bun's native fetch ignores the undici dispatcher — the behavior under test is
 * Node/undici-specific.
 */

import { createServer } from "node:http";
import { Agent } from "undici";
import { describe, expect, it } from "vitest";
import { pinnedConnectLookup } from "../../gateway/proxy/ip-blocklist";

describe("ssrfSafeFetch pinned connect.lookup (undici under Node)", () => {
  it("connects to the pinned address regardless of the request hostname", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve())
    );
    const { port } = server.address() as { port: number };

    const dispatcher = new Agent({
      connect: { lookup: pinnedConnectLookup("127.0.0.1", 4) },
    });
    try {
      // `pinned.invalid` does not resolve in DNS — the request only succeeds
      // because the pinned lookup forces every connection to 127.0.0.1.
      const res = await fetch(`http://pinned.invalid:${port}/`, {
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("pinned-ok");
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
