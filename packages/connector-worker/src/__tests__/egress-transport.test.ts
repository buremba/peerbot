import { afterEach, describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import {
  __egressTransportTestOnly,
  DnsResolutionError,
  EgressDispatcher,
  fetchCredentialedPublicUrl,
  fetchPublicUrl,
  MalformedHostError,
  parseCredentialedHttpsUrl,
  parseExemptHosts,
  PrivateAddressError,
  type ResolveAllAddresses,
  resolveEgressAddresses,
} from "../egress/transport.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A fake resolver: every name → this fixed answer set. */
const answering =
  (addresses: string[]): ResolveAllAddresses =>
  async () =>
    addresses.map((address) => ({ address }));

/** A resolver that must never be consulted: the decision has to fall before DNS. */
const neverResolves: ResolveAllAddresses = async (hostname) => {
  throw new Error(`lookup must not run for ${hostname}`);
};

const BLOCK = { addressPolicy: "block-private" } as const;
const ALLOW = { addressPolicy: "allow-private" } as const;

describe("public URL transport boundary", () => {
  test("returns the exact validated DNS answer to the socket lookup", async () => {
    const answers: LookupAddress[] = [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ];
    const lookup = __egressTransportTestOnly.createGuardedLookup(
      __egressTransportTestOnly.resolveEgressOptions({ lookup: async () => answers }),
    );

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
    }) as Parameters<typeof __egressTransportTestOnly.createGuardedConnector>[1];

    __egressTransportTestOnly.createGuardedConnector(__egressTransportTestOnly.resolveEgressOptions({}), connect)(
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
      }
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
    }) as Parameters<typeof __egressTransportTestOnly.createGuardedConnector>[1];

    __egressTransportTestOnly.createGuardedConnector(__egressTransportTestOnly.resolveEgressOptions({}), connect)(
      options,
      () => undefined
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

  test("fetches through the dispatcher it is handed, never a bare fetch", async () => {
    let dispatcher: unknown;
    globalThis.fetch = (async (_input, init) => {
      dispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const own = new EgressDispatcher({ addressPolicy: "allow-private" });
    await fetchPublicUrl("http://127.0.0.1:9/health", {}, own);
    expect(dispatcher).toBe(own);

    await fetchPublicUrl("https://api.example.com/");
    expect(dispatcher).toBeInstanceOf(EgressDispatcher);
    expect(dispatcher).not.toBe(own);
  });

  test("a dispatcher refuses a literal its policy cannot dial before the request leaves", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(fetchPublicUrl("http://127.0.0.1/")).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(fetchPublicUrl("http://localhost/")).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(
      fetchPublicUrl("http://169.254.169.254/", {}, new EgressDispatcher({ addressPolicy: "allow-private" }))
    ).rejects.toBeInstanceOf(PrivateAddressError);
    expect(fetched).toBe(false);

    const exempt = new EgressDispatcher({ exemptHosts: ["LocalHost"] });
    expect(() => exempt.assertReachable("localhost")).not.toThrow();
    expect(() => exempt.assertReachable("127.0.0.1")).toThrow(PrivateAddressError);
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

  test("carries the refused DNS answer, so a caller can name it without parsing text", async () => {
    const error = await resolveEgressAddresses("db.example.com", {
      ...BLOCK,
      lookup: answering(["93.184.216.34", "10.0.0.7"]),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(PrivateAddressError);
    expect((error as PrivateAddressError).hostname).toBe("db.example.com");
    expect((error as PrivateAddressError).address).toBe("10.0.0.7");
    expect((new PrivateAddressError("127.0.0.1") as PrivateAddressError).address).toBeNull();
  });
});

describe("resolveEgressAddresses — the address axis", () => {
  test("a public literal passes under both policies, in canonical form", async () => {
    for (const policy of [BLOCK, ALLOW]) {
      await expect(resolveEgressAddresses("93.184.216.34", { ...policy, lookup: neverResolves })).resolves.toEqual([
        { address: "93.184.216.34", family: 4 },
      ]);
      await expect(resolveEgressAddresses("::ffff:93.184.216.34", { ...policy, lookup: neverResolves })).resolves.toEqual([
        { address: "93.184.216.34", family: 4 },
      ]);
      await expect(resolveEgressAddresses("[2606:4700::1111]", { ...policy, lookup: neverResolves })).resolves.toEqual([
        { address: "2606:4700::1111", family: 6 },
      ]);
    }
  });

  test("a loopback literal passes allow-private and is refused under block-private", async () => {
    await expect(resolveEgressAddresses("127.0.0.1", { ...ALLOW, lookup: neverResolves })).resolves.toEqual([
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(resolveEgressAddresses("127.0.0.1", { ...BLOCK, lookup: neverResolves })).rejects.toBeInstanceOf(
      PrivateAddressError
    );
    // The default policy is the strict one.
    await expect(resolveEgressAddresses("127.0.0.1", { lookup: neverResolves })).rejects.toBeInstanceOf(
      PrivateAddressError
    );
  });

  test("a metadata literal is refused under both policies", async () => {
    for (const policy of [BLOCK, ALLOW]) {
      await expect(resolveEgressAddresses("169.254.169.254", { ...policy, lookup: neverResolves })).rejects.toBeInstanceOf(
        PrivateAddressError
      );
      await expect(resolveEgressAddresses("::a9fe:a9fe", { ...policy, lookup: neverResolves })).rejects.toBeInstanceOf(
        PrivateAddressError
      );
    }
  });

  test("a malformed IP-looking literal fails closed", async () => {
    await expect(resolveEgressAddresses("64:ff9b::nope", { ...ALLOW, lookup: neverResolves })).rejects.toBeInstanceOf(
      MalformedHostError
    );
  });

  test("a hostname resolving to a public address passes, every answer canonical", async () => {
    await expect(
      resolveEgressAddresses("db.example.com", { ...BLOCK, lookup: answering(["93.184.216.34", "::ffff:93.184.216.35"]) })
    ).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
  });

  test("a hostname resolving to ANY blocked address is refused (multi-record rebind)", async () => {
    await expect(
      resolveEgressAddresses("db.example.com", { ...BLOCK, lookup: answering(["93.184.216.34", "169.254.169.254"]) })
    ).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(
      resolveEgressAddresses("db.example.com", { ...ALLOW, lookup: answering(["10.0.0.5", "169.254.169.254"]) })
    ).rejects.toBeInstanceOf(PrivateAddressError);
  });

  test("a hostname resolving into RFC1918 is allowed self-hosted and refused on cloud", async () => {
    await expect(
      resolveEgressAddresses("db.example.com", { ...ALLOW, lookup: answering(["10.0.0.5"]) })
    ).resolves.toEqual([{ address: "10.0.0.5", family: 4 }]);
    await expect(
      resolveEgressAddresses("db.example.com", { ...BLOCK, lookup: answering(["10.0.0.5"]) })
    ).rejects.toBeInstanceOf(PrivateAddressError);
  });

  test("a failed or empty lookup is a DNS error, never a pass-through", async () => {
    const failing: ResolveAllAddresses = async () => {
      throw new Error("ENOTFOUND");
    };
    const failed = await resolveEgressAddresses("db.example.com", { ...ALLOW, lookup: failing }).then(
      () => null,
      (e: unknown) => e
    );
    expect(failed).toBeInstanceOf(DnsResolutionError);
    expect((failed as Error).message).toMatch(/db\.example\.com.*ENOTFOUND/);
    await expect(resolveEgressAddresses("db.example.com", { ...ALLOW, lookup: answering([]) })).rejects.toBeInstanceOf(
      DnsResolutionError
    );
  });

  test("names are canonicalized before matching and resolving", async () => {
    const seen: string[] = [];
    const recording: ResolveAllAddresses = async (hostname) => {
      seen.push(hostname);
      return [{ address: "93.184.216.34" }];
    };
    await resolveEgressAddresses("DB.Example.COM.", { ...BLOCK, lookup: recording });
    expect(seen).toEqual(["db.example.com"]);
  });
});

describe("resolveEgressAddresses — internal names", () => {
  test("localhost and the internal suffixes are refused by name under block-private, before DNS", async () => {
    for (const name of ["localhost", "LocalHost.", "db.localhost", "printer.local", "wiki.internal", "erp.intranet", "ad.corp", "nas.lan", "hub.home"]) {
      await expect(resolveEgressAddresses(name, { ...BLOCK, lookup: neverResolves })).rejects.toBeInstanceOf(
        PrivateAddressError
      );
    }
    // Look-alikes that merely contain the word are ordinary names.
    await expect(
      resolveEgressAddresses("localhost.example.com", { ...BLOCK, lookup: answering(["93.184.216.34"]) })
    ).resolves.toHaveLength(1);
  });

  test("under allow-private they are ordinary names, judged on what they resolve to", async () => {
    await expect(
      resolveEgressAddresses("db.local", { ...ALLOW, lookup: answering(["192.168.1.20"]) })
    ).resolves.toEqual([{ address: "192.168.1.20", family: 4 }]);
    await expect(
      resolveEgressAddresses("localhost", { ...ALLOW, lookup: answering(["127.0.0.1", "::1"]) })
    ).resolves.toEqual([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(
      resolveEgressAddresses("db.local", { ...ALLOW, lookup: answering(["169.254.169.254"]) })
    ).rejects.toBeInstanceOf(PrivateAddressError);
  });
});

describe("exempt hosts — an operator's own database, or a run naming localhost", () => {
  test("a CGNAT literal is refused under block-private without an exemption", async () => {
    await expect(resolveEgressAddresses("100.127.177.56", { ...BLOCK, lookup: neverResolves })).rejects.toBeInstanceOf(
      PrivateAddressError
    );
  });

  test("a CGNAT literal is permitted when explicitly exempted", async () => {
    await expect(
      resolveEgressAddresses("100.127.177.56", { ...BLOCK, exemptHosts: ["100.127.177.56"], lookup: neverResolves })
    ).resolves.toEqual([{ address: "100.127.177.56", family: 4 }]);
  });

  test("an exempted hostname resolving into CGNAT is permitted, and the address is what gets dialled", async () => {
    await expect(
      resolveEgressAddresses("mac.tailnet.ts.net", {
        ...BLOCK,
        exemptHosts: ["mac.tailnet.ts.net"],
        lookup: answering(["100.127.177.56"]),
      })
    ).resolves.toEqual([{ address: "100.127.177.56", family: 4 }]);
  });

  test("an exemption for localhost admits the name AND the loopback it resolves to", async () => {
    await expect(
      resolveEgressAddresses("localhost", { ...BLOCK, exemptHosts: ["LOCALHOST"], lookup: answering(["127.0.0.1"]) })
    ).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      resolveEgressAddresses("[::1]", { ...BLOCK, exemptHosts: ["::1"], lookup: neverResolves })
    ).resolves.toEqual([{ address: "::1", family: 6 }]);
  });

  test("a DIFFERENT private host is still refused while one host is exempted", async () => {
    await expect(
      resolveEgressAddresses("10.0.0.5", { ...BLOCK, exemptHosts: ["100.127.177.56"], lookup: neverResolves })
    ).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(
      resolveEgressAddresses("db.example.com", { ...BLOCK, exemptHosts: ["other.example.com"], lookup: answering(["10.0.0.5"]) })
    ).rejects.toBeInstanceOf(PrivateAddressError);
  });

  /**
   * The floor an exemption drops to still refuses cloud metadata in every
   * spelling: link-local (169.254.169.254), AWS IMDS over IPv6 (`fd00:ec2::254`,
   * inside ULA, which the floor otherwise permits), Alibaba (inside CGNAT, the
   * very range a Tailscale exemption targets) and Oracle. As literals and as
   * DNS answers for an exempted name.
   */
  test.each([
    ["169.254.169.254", "link-local metadata"],
    ["fd00:ec2::254", "AWS IMDS over IPv6 (inside ULA)"],
    ["100.100.100.200", "Alibaba metadata (inside CGNAT)"],
    ["192.0.0.192", "Oracle Cloud metadata"],
  ])("%s stays refused even when explicitly exempted (%s)", async (address) => {
    await expect(
      resolveEgressAddresses(address, { ...BLOCK, exemptHosts: [address], lookup: neverResolves })
    ).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(
      resolveEgressAddresses("evil.example.com", { ...BLOCK, exemptHosts: ["evil.example.com"], lookup: answering([address]) })
    ).rejects.toBeInstanceOf(PrivateAddressError);
    // ...and under allow-private without any exemption, the same answer.
    await expect(resolveEgressAddresses(address, { ...ALLOW, lookup: neverResolves })).rejects.toBeInstanceOf(
      PrivateAddressError
    );
  });

  test("ordinary ULA and CGNAT hosts are still exemptible (the refused set is metadata-only)", async () => {
    await expect(
      resolveEgressAddresses("fd00::1", { ...BLOCK, exemptHosts: ["fd00::1"], lookup: neverResolves })
    ).resolves.toEqual([{ address: "fd00::1", family: 6 }]);
    await expect(
      resolveEgressAddresses("100.127.177.56", { ...BLOCK, exemptHosts: ["100.127.177.56"], lookup: neverResolves })
    ).resolves.toEqual([{ address: "100.127.177.56", family: 4 }]);
  });

  /**
   * An exemption is matched on the host SPELLING (canonicalized for case,
   * trailing dot and IPv6 brackets only), before the range check normalizes
   * IPv4-mapped / NAT64 / zone-id forms. So an alternate spelling of an
   * exempted address misses the exemption and stays refused. Deliberate and
   * fail-closed: widening the match to normalized forms would let a single
   * exemption admit every wrapper spelling of that address.
   */
  test.each(["::ffff:100.127.177.56", "64:ff9b::100.127.177.56", "100.127.177.56%eth0"])(
    "%s does NOT inherit the exemption for 100.127.177.56",
    async (spelling) => {
      await expect(
        resolveEgressAddresses(spelling, { ...BLOCK, exemptHosts: ["100.127.177.56"], lookup: neverResolves })
      ).rejects.toThrow();
    }
  );
});

describe("parseExemptHosts — the operator's comma-separated exact hosts", () => {
  test("parses a comma-separated list, trimming and dropping blanks", () => {
    expect(parseExemptHosts(" 100.127.177.56 , db.example.com ,, ", "TEST_HOSTS")).toEqual([
      "100.127.177.56",
      "db.example.com",
    ]);
    expect(parseExemptHosts("100.127.177.56, db.corp, fd00::1", "TEST_HOSTS")).toEqual([
      "100.127.177.56",
      "db.corp",
      "fd00::1",
    ]);
  });

  test("undefined / non-string / blank yields no entries", () => {
    expect(parseExemptHosts(undefined, "TEST_HOSTS")).toEqual([]);
    expect(parseExemptHosts(42, "TEST_HOSTS")).toEqual([]);
    expect(parseExemptHosts("   ", "TEST_HOSTS")).toEqual([]);
  });

  test("shapes that can never match a host fail at parse time, naming the setting", () => {
    expect(() => parseExemptHosts("100.64.0.0/10", "TEST_HOSTS")).toThrow(/TEST_HOSTS.*CIDR/);
    expect(() => parseExemptHosts("*.ts.net", "TEST_HOSTS")).toThrow(/wildcard/);
    expect(() => parseExemptHosts("10.0.0.5:5432", "TEST_HOSTS")).toThrow(/port/);
    expect(() => parseExemptHosts("[fd00::1]", "TEST_HOSTS")).toThrow(/bracket/);
  });
});
