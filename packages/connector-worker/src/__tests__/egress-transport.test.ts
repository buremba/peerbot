import { afterEach, describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import {
  __egressTransportTestOnly,
  fetchCredentialedPublicUrl,
  fetchPublicUrl,
  parseCredentialedHttpsUrl,
  PrivateAddressError,
} from "../egress/transport.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("public URL transport boundary", () => {
  test("returns the exact validated DNS answer to the socket lookup", async () => {
    const answers: LookupAddress[] = [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ];
    const lookup = __egressTransportTestOnly.createGuardedLookup(async () => answers);

    const selected = await new Promise<{ address: string; family: number }>(
      (resolve, reject) => {
        lookup("resolver.example", { all: false }, (error, address, family) => {
          if (error) reject(error);
          else resolve({ address, family });
        });
      }
    );

    expect(selected).toEqual(answers[0]);
  });

  test("rechecks literal redirect targets before dialing", () => {
    let dialed = false;
    let blocked: Error | null = null;
    const connect = (() => {
      dialed = true;
    }) as Parameters<typeof __egressTransportTestOnly.connectPublicTarget>[2];

    __egressTransportTestOnly.connectPublicTarget(
      {
        hostname: "127.0.0.1",
        host: "127.0.0.1:80",
        protocol: "http:",
        port: "80",
        servername: null,
        localAddress: null,
      },
      (error) => {
        blocked = error;
      },
      connect
    );

    expect(dialed).toBe(false);
    expect(blocked?.message).toMatch(/private\/internal address/i);
  });

  test("preserves the hostname and SNI while the socket lookup pins the IP", () => {
    let forwarded: Record<string, unknown> | null = null;
    const options = {
      hostname: "api.example.com",
      host: "api.example.com:443",
      protocol: "https:",
      port: "443",
      servername: "api.example.com",
      localAddress: null,
    };
    const connect = ((received: Record<string, unknown>) => {
      forwarded = received;
    }) as Parameters<typeof __egressTransportTestOnly.connectPublicTarget>[2];

    __egressTransportTestOnly.connectPublicTarget(
      options,
      () => undefined,
      connect
    );

    expect(forwarded).toBe(options);
    expect(forwarded?.hostname).toBe("api.example.com");
    expect(forwarded?.servername).toBe("api.example.com");
  });

  test("parses HTTPS credential destinations without changing their components", () => {
    const parsed = parseCredentialedHttpsUrl(
      "HTTPS://api.example.com:8443/token?audience=mcp#ignored"
    );
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("api.example.com");
    expect(parsed.port).toBe("8443");
    expect(parsed.pathname).toBe("/token");
    expect(parsed.search).toBe("?audience=mcp");
    expect(
      parseCredentialedHttpsUrl(new URL("https://api.example.com/refresh")).href
    ).toBe("https://api.example.com/refresh");
  });

  test("rejects invalid, relative, plaintext, and non-HTTP credential destinations", () => {
    for (const value of [
      "not a URL",
      "/relative/token",
      "http://api.example.com/token",
      "ftp://api.example.com/token",
      "javascript:alert(1)",
    ]) {
      expect(() => parseCredentialedHttpsUrl(value)).toThrow();
    }
  });

  test("rejects plaintext credentials before global fetch", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(
      fetchCredentialedPublicUrl("http://api.example.com/token", {
        headers: { Authorization: "Bearer secret" },
      })
    ).rejects.toThrow(/require HTTPS/i);
    expect(fetched).toBe(false);
  });

  test("disables automatic redirects for credential-bearing requests", async () => {
    let redirectMode: RequestRedirect | undefined;
    globalThis.fetch = (async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await fetchCredentialedPublicUrl("https://api.example.com/token");
    expect(redirectMode).toBe("error");
    await expect(
      fetchCredentialedPublicUrl("https://api.example.com/token", {
        redirect: "follow",
      })
    ).rejects.toThrow(/cannot automatically follow redirects/i);
  });
});

describe("surfacing the blocked-target decision", () => {
  // Node reports a connector rejection as `TypeError("fetch failed")` with the
  // real reason on `cause`, so without unwrapping, a deliberate security block
  // is indistinguishable from an upstream outage. These pin the unwrapping
  // itself: the mechanism is `instanceof PrivateAddressError`, and a test that
  // only asserted on message text would keep passing if that regressed to a
  // string match against a message someone later reworded.
  test("unwraps a blocked target from the cause chain", async () => {
    const blocked = new PrivateAddressError("169.254.169.254");
    globalThis.fetch = (() => {
      throw new TypeError("fetch failed", { cause: blocked });
    }) as typeof globalThis.fetch;

    await expect(fetchPublicUrl("https://metadata.example/")).rejects.toBe(blocked);
  });

  test("unwraps a blocked target nested in an AggregateError", async () => {
    const blocked = new PrivateAddressError("10.0.0.1");
    globalThis.fetch = (() => {
      throw new TypeError("fetch failed", {
        cause: new AggregateError([new Error("ECONNREFUSED"), blocked]),
      });
    }) as typeof globalThis.fetch;

    await expect(fetchPublicUrl("https://multi.example/")).rejects.toBe(blocked);
  });

  test("identifies the error by class, not by message text", async () => {
    // The discriminating case: this is a genuine PrivateAddressError whose
    // message no longer carries the old "URL points to a private/internal
    // address:" prefix. `instanceof` still finds it; the string match this
    // replaced would not, and would report a security block as an outage.
    const blocked = new PrivateAddressError("172.16.0.5");
    blocked.message = "reworded by a later refactor";
    globalThis.fetch = (() => {
      throw new TypeError("fetch failed", { cause: blocked });
    }) as typeof globalThis.fetch;

    await expect(fetchPublicUrl("https://reworded.example/")).rejects.toBe(blocked);
  });

  test("leaves an ordinary upstream failure untouched", async () => {
    const outage = new TypeError("fetch failed", {
      cause: new Error("ECONNRESET"),
    });
    globalThis.fetch = (() => {
      throw outage;
    }) as typeof globalThis.fetch;

    await expect(fetchPublicUrl("https://upstream.example/")).rejects.toBe(outage);
  });
});
