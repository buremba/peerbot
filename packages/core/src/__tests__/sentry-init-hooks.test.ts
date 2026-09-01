/**
 * The scrubber only protects the fleet if `initSentry` actually hands it to
 * the SDK. Typecheck proves the hooks have the right SHAPE; nothing proved
 * they were wired, so a dropped line here would silently reopen the leak this
 * module exists to close.
 *
 * Asserts on what each hook DOES, not on function identity: every captured
 * hook is run over a real credential-bearing payload. Comparing function
 * references would still pass if the three were wired to the wrong keys.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const initCalls: Array<Record<string, unknown>> = [];

mock.module("@sentry/node", () => ({
  init: (options: Record<string, unknown>) => {
    initCalls.push(options);
  },
  consoleLoggingIntegration: () => ({ name: "ConsoleLogging" }),
}));

const { initSentry } = await import("../sentry");

const SECRET = "SENTRY_INIT_SENTINEL";

// bun runs every test file in ONE process, so a DSN left set here would follow
// the suite into whatever file runs next and quietly arm Sentry there.
const ORIGINAL_DSN = process.env.SENTRY_DSN;
afterAll(() => {
  if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_DSN;
});

function capturedOptions(): Record<string, unknown> {
  expect(initCalls).toHaveLength(1);
  return initCalls[0] as Record<string, unknown>;
}

describe("initSentry credential hooks", () => {
  beforeEach(() => {
    initCalls.length = 0;
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/0";
  });

  test("does not initialize at all without a DSN", async () => {
    process.env.SENTRY_DSN = "";
    await initSentry();
    expect(initCalls).toHaveLength(0);
  });

  test("installs beforeSend, and it strips a query credential", async () => {
    await initSentry();
    const beforeSend = capturedOptions().beforeSend as (
      e: unknown
    ) => Record<string, unknown>;
    expect(typeof beforeSend).toBe("function");

    const scrubbed = beforeSend({
      request: { url: `https://example.test/cb?code=${SECRET}` },
      message: `oauth exchange failed: https://example.test/cb?code=${SECRET}`,
    });
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(JSON.stringify(scrubbed)).toContain("https://example.test/cb");
  });

  test("installs beforeSendTransaction, and it strips a span URL credential", async () => {
    await initSentry();
    const beforeSendTransaction = capturedOptions().beforeSendTransaction as (
      e: unknown
    ) => Record<string, unknown>;
    expect(typeof beforeSendTransaction).toBe("function");

    const scrubbed = beforeSendTransaction({
      transaction: "GET /api/v1/files/a",
      contexts: {
        trace: { data: { url: `/api/v1/files/a?token=${SECRET}&page=2` } },
      },
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(SECRET);
    // Route and ordinary params survive — the hook redacts, never drops.
    expect(serialized).toContain("/api/v1/files/a");
    expect(serialized).toContain("page=2");
  });

  test("installs beforeBreadcrumb, and it strips a console-derived credential", async () => {
    await initSentry();
    const beforeBreadcrumb = capturedOptions().beforeBreadcrumb as (
      b: unknown
    ) => Record<string, unknown>;
    expect(typeof beforeBreadcrumb).toBe("function");

    // Node's default consoleIntegration turns a console.log into exactly this
    // shape; it is the breadcrumb path that carries connector arguments.
    const scrubbed = beforeBreadcrumb({
      category: "console",
      level: "log",
      message: `POST https://api.example.test/v1/x?api_key=${SECRET}`,
      data: { authorization: `Bearer ${SECRET}`, status_code: 500 },
    });
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(SECRET);
    expect(scrubbed.category).toBe("console");
    // Triage fields must survive the scrub or the breadcrumb is worthless.
    expect((scrubbed.data as Record<string, unknown>).status_code).toBe(500);
  });

  test("keeps tracing off and PII out of the worker's config", async () => {
    await initSentry();
    const options = capturedOptions();
    expect(options.tracesSampleRate).toBe(0);
    expect(options.sendDefaultPii).toBe(false);
  });
});
