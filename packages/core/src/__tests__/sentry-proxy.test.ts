/**
 * Worker Sentry must route through the gateway egress proxy. The
 * @sentry/node-core transport reads ONLY lowercase http_proxy/https_proxy, but
 * the worker spawn env sets uppercase HTTP_PROXY — so initSentry passes the
 * proxy explicitly via transportOptions.proxy (built from
 * resolveSentryEgressProxy) or the capture is kernel-blocked in prod
 * (IPAddressDeny=any). This pins that resolution contract with a pure,
 * env-injected helper (no module mocking — runs identically in src and dist).
 */
import { describe, expect, test } from "bun:test";
import { resolveSentryEgressProxy } from "../sentry";

describe("resolveSentryEgressProxy", () => {
  test("uses HTTP_PROXY (the var the worker spawn env sets)", () => {
    expect(
      resolveSentryEgressProxy({ HTTP_PROXY: "http://localhost:8118" })
    ).toBe("http://localhost:8118");
  });

  test("prefers HTTP_PROXY over HTTPS_PROXY", () => {
    expect(
      resolveSentryEgressProxy({
        HTTP_PROXY: "http://localhost:8118",
        HTTPS_PROXY: "http://localhost:9",
      })
    ).toBe("http://localhost:8118");
  });

  test("falls back to HTTPS_PROXY when HTTP_PROXY is unset", () => {
    expect(
      resolveSentryEgressProxy({ HTTPS_PROXY: "http://localhost:8118" })
    ).toBe("http://localhost:8118");
  });

  test("undefined with no proxy (server/dev → direct egress)", () => {
    expect(resolveSentryEgressProxy({})).toBeUndefined();
  });
});
