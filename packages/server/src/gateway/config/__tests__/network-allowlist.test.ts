/**
 * Tests for loadAllowedDomains' Sentry-ingest-host handling. This is the
 * load-bearing egress decision for worker Sentry reporting: the worker reaches
 * Sentry THROUGH the gateway proxy (not directly — the Linux systemd scope's
 * IPAddressDeny would drop a direct connection), so the proxy allowlist MUST
 * admit the Sentry ingest host or every capture POST is silently 403'd.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadAllowedDomains } from "../network-allowlist.js";

const SENTRY_DSN_PRESERVE = process.env.SENTRY_DSN;
const WAD_PRESERVE = process.env.WORKER_ALLOWED_DOMAINS;

beforeEach(() => {
  delete process.env.SENTRY_DSN;
  delete process.env.WORKER_ALLOWED_DOMAINS;
});

afterEach(() => {
  if (SENTRY_DSN_PRESERVE === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = SENTRY_DSN_PRESERVE;
  if (WAD_PRESERVE === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
  else process.env.WORKER_ALLOWED_DOMAINS = WAD_PRESERVE;
});

describe("loadAllowedDomains + SENTRY_DSN", () => {
  test("no DSN, no WORKER_ALLOWED_DOMAINS → complete isolation", () => {
    expect(loadAllowedDomains()).toEqual([]);
  });

  test("DSN set, WORKER_ALLOWED_DOMAINS unset → only the Sentry host is allowed", () => {
    process.env.SENTRY_DSN = "https://abc123@o42.ingest.de.sentry.io/9876";
    expect(loadAllowedDomains()).toEqual(["o42.ingest.de.sentry.io"]);
  });

  test("DSN set + allowlist → Sentry host appended", () => {
    process.env.SENTRY_DSN = "https://k@o1.ingest.us.sentry.io/2";
    process.env.WORKER_ALLOWED_DOMAINS = "github.com,api.example.com";
    const allowed = loadAllowedDomains();
    expect(allowed).toContain("o1.ingest.us.sentry.io");
    expect(allowed).toContain("github.com");
    expect(allowed).toContain("api.example.com");
  });

  test("DSN host already in allowlist → not duplicated", () => {
    process.env.SENTRY_DSN = "https://k@o1.ingest.us.sentry.io/2";
    process.env.WORKER_ALLOWED_DOMAINS = "o1.ingest.us.sentry.io";
    const allowed = loadAllowedDomains();
    expect(allowed.filter((d) => d === "o1.ingest.us.sentry.io")).toHaveLength(
      1
    );
  });

  test("unrestricted (*) mode is left untouched", () => {
    process.env.SENTRY_DSN = "https://k@o1.ingest.us.sentry.io/2";
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    expect(loadAllowedDomains()).toEqual(["*"]);
  });

  test("malformed DSN fails closed (no host added)", () => {
    process.env.SENTRY_DSN = "not-a-url";
    expect(loadAllowedDomains()).toEqual([]);
  });
});
