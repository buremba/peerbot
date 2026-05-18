/**
 * Unit tests for the worker-side per-run snapshot helpers
 * (`hydrateFromSnapshot`, `writeSnapshot`).
 *
 * These exercise the HTTP-client side of the snapshot path against a mocked
 * gateway. Coverage:
 *  - Hydrate writes the gateway's bytes verbatim to disk, fsyncs, returns
 *    the post-hydrate file size matching the byte_size column contract.
 *  - Hydrate handles 404 (no completed snapshot) → returns false, leaves
 *    the local file untouched.
 *  - Hydrate failures are non-fatal at the caller's discretion (we re-throw,
 *    caller logs+continues; behaviour verified in worker.ts but we assert
 *    the throw shape here).
 *  - writeSnapshot reads the session file, POSTs body, handles 409 (race
 *    win), missing file (early-exit worker), and empty file all silently.
 *  - The transport layer never throws — `cleanup()` runs in the worker's
 *    dying breath and any throw would abort the surrounding `finally`.
 *
 * The gateway test (`packages/server/src/gateway/__tests__/
 * agent-transcript-snapshot.test.ts`) covers the route + PG side; this
 * file is the symmetric client side.
 */

import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  hydrateFromSnapshot,
  writeSnapshot,
} from "../openclaw/transcript-snapshot";

let tmp: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "snapshot-test-"));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tmp, { recursive: true, force: true });
});

function stubFetch(
  handler: (url: string, init: RequestInit) => Response
): void {
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return handler(url, init ?? {});
    }
  ) as unknown as typeof globalThis.fetch;
}

describe("hydrateFromSnapshot", () => {
  test("boot-hydrate-fsync: writes bytes verbatim, file size matches body length", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    const expected =
      `{"type":"session","version":3,"id":"hydrate","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"resume"}]}}\n`;

    stubFetch((url, init) => {
      expect(url.endsWith("/worker/transcript/snapshot")).toBe(true);
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-jwt"
      );
      return new Response(expected, { status: 200 });
    });

    const hydrated = await hydrateFromSnapshot({
      sessionFile,
      gatewayUrl: "http://gw.test/lobu",
      workerToken: "test-jwt",
    });
    expect(hydrated).toBe(true);

    // File written + fsynced → stat size matches byte_size we'd compute.
    const stats = await fs.stat(sessionFile);
    expect(stats.size).toBe(Buffer.byteLength(expected, "utf-8"));
    const back = await fs.readFile(sessionFile, "utf-8");
    expect(back).toBe(expected);
  });

  test("returns false on 404 and does not touch the file", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    stubFetch(() => new Response("", { status: 404 }));

    const hydrated = await hydrateFromSnapshot({
      sessionFile,
      gatewayUrl: "http://gw.test/lobu",
      workerToken: "test-jwt",
    });
    expect(hydrated).toBe(false);
    // No file created.
    let exists = false;
    try {
      await fs.stat(sessionFile);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("throws on non-2xx, non-404 — caller logs + continues with local file", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    stubFetch(() => new Response("boom", { status: 500 }));
    await expect(
      hydrateFromSnapshot({
        sessionFile,
        gatewayUrl: "http://gw.test/lobu",
        workerToken: "test-jwt",
      })
    ).rejects.toThrow(/transcript hydrate failed: 500/);
  });
});

describe("writeSnapshot", () => {
  test("happy path: reads file, POSTs body + terminalStatus, gateway 200", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    await fs.mkdir(join(tmp, ".openclaw"), { recursive: true });
    const body =
      `{"type":"session","version":3,"id":"write","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"u1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n`;
    await fs.writeFile(sessionFile, body, "utf-8");

    let postedBody: string | null = null;
    stubFetch((url, init) => {
      expect(url.endsWith("/worker/transcript/snapshot")).toBe(true);
      expect(init.method).toBe("POST");
      postedBody = init.body as string;
      return new Response('{"id":1}', { status: 200 });
    });

    await writeSnapshot({
      sessionFile,
      gatewayUrl: "http://gw.test/lobu",
      workerToken: "test-jwt",
      terminalStatus: "completed",
      runId: 42,
    });
    expect(postedBody).not.toBeNull();
    const parsed = JSON.parse(postedBody!);
    expect(parsed.snapshotJsonl).toBe(body);
    expect(parsed.terminalStatus).toBe("completed");
    // P1#1: runId MUST be on the POST body so the route attributes the
    // snapshot to the exact run this worker claimed, not "latest run for
    // (org, agent, conv)".
    expect(parsed.runId).toBe(42);
  });

  test("non-completed terminalStatus is skipped (no POST, no waste)", async () => {
    // Hydrate filters terminal_status='completed' — writing failed/
    // timeout/cancelled rows is pure network waste. Codex round 2
    // quality win C on PR #865. The cleanup() path is also gated on
    // `terminalStatus === "completed"`, but writeSnapshot defends in
    // depth so any future caller can't accidentally write a row that
    // hydrate will never read.
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    await fs.mkdir(join(tmp, ".openclaw"), { recursive: true });
    await fs.writeFile(sessionFile, `{"type":"session"}\n`, "utf-8");

    let calls = 0;
    stubFetch(() => {
      calls++;
      return new Response("{}", { status: 200 });
    });

    for (const terminalStatus of ["failed", "timeout", "cancelled"] as const) {
      await writeSnapshot({
        sessionFile,
        gatewayUrl: "http://gw.test/lobu",
        workerToken: "test-jwt",
        terminalStatus,
        runId: 42,
      });
    }
    expect(calls).toBe(0);
  });

  test("race-win-409 is benign — no throw", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    await fs.mkdir(join(tmp, ".openclaw"), { recursive: true });
    await fs.writeFile(sessionFile, `{"type":"session"}\n`, "utf-8");

    stubFetch(() => new Response("conflict", { status: 409 }));

    // No throw — cleanup() in the worker's dying breath must never
    // re-throw inside a `finally`.
    await writeSnapshot({
      sessionFile,
      gatewayUrl: "http://gw.test/lobu",
      workerToken: "test-jwt",
      terminalStatus: "completed",
      runId: 42,
    });
  });

  test("no session file (early-exit worker): silently skips, no fetch", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    let calls = 0;
    stubFetch(() => {
      calls++;
      return new Response("", { status: 200 });
    });

    await writeSnapshot({
      sessionFile,
      gatewayUrl: "http://gw.test/lobu",
      workerToken: "test-jwt",
      terminalStatus: "failed",
      runId: 42,
    });
    expect(calls).toBe(0);
  });

  test("empty session file is skipped — never POST an empty snapshot", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    await fs.mkdir(join(tmp, ".openclaw"), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf-8");
    let calls = 0;
    stubFetch(() => {
      calls++;
      return new Response("{}", { status: 200 });
    });

    await writeSnapshot({
      sessionFile,
      gatewayUrl: "http://gw.test/lobu",
      workerToken: "test-jwt",
      terminalStatus: "completed",
      runId: 42,
    });
    expect(calls).toBe(0);
  });

  test("server 500 is logged, not thrown", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    await fs.mkdir(join(tmp, ".openclaw"), { recursive: true });
    await fs.writeFile(sessionFile, `{"type":"session"}\n`, "utf-8");
    stubFetch(() => new Response("boom", { status: 500 }));

    // No throw — same invariant as the 409 case. Logs go to pino; we
    // don't assert log content here.
    await writeSnapshot({
      sessionFile,
      gatewayUrl: "http://gw.test/lobu",
      workerToken: "test-jwt",
      terminalStatus: "completed",
      runId: 42,
    });
  });

  test("fetch throw is caught — cleanup() must never re-throw", async () => {
    const sessionFile = join(tmp, ".openclaw", "session.jsonl");
    await fs.mkdir(join(tmp, ".openclaw"), { recursive: true });
    await fs.writeFile(sessionFile, `{"type":"session"}\n`, "utf-8");
    globalThis.fetch = (() => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    // No throw escapes — caller is the cleanup() finally block.
    await writeSnapshot({
      sessionFile,
      gatewayUrl: "http://gw.test/lobu",
      workerToken: "test-jwt",
      terminalStatus: "completed",
      runId: 42,
    });
  });
});
