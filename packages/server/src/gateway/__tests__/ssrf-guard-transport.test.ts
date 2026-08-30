import { describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { __ssrfGuardTestOnly } from "../proxy/ssrf-guard.js";

describe("public URL transport boundary", () => {
  test("returns the exact validated DNS answer to the socket lookup", async () => {
    const answers: LookupAddress[] = [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ];
    const lookup = __ssrfGuardTestOnly.createGuardedLookup(async () => answers);

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
    }) as Parameters<typeof __ssrfGuardTestOnly.connectPublicTarget>[2];

    __ssrfGuardTestOnly.connectPublicTarget(
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
    }) as Parameters<typeof __ssrfGuardTestOnly.connectPublicTarget>[2];

    __ssrfGuardTestOnly.connectPublicTarget(
      options,
      () => undefined,
      connect
    );

    expect(forwarded).toBe(options);
    expect(forwarded?.hostname).toBe("api.example.com");
    expect(forwarded?.servername).toBe("api.example.com");
  });
});
