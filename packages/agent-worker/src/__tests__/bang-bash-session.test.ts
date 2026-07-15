/**
 * `!`-bash session-persistence contracts and the remote-backend composition
 * (issue #1989, PR-D4 follow-ups).
 *
 * - `persistBangBashSession` must be BYTE-idempotent: a same-run retry rewrites
 *   the file with identical bytes, or the gateway's monotonic-prefix snapshot
 *   guard 409s and wedges the run. Idempotency is by construction (stable
 *   header + verbatim branch, never `exportToJsonl()`'s fresh timestamp) —
 *   these tests lock it in.
 * - `normalizeHydratedSessionFile` must truncate an assistant-less hydrated
 *   file (pi re-appends the whole branch on the next assistant flush, which
 *   would double the `session` header mid-file) and leave a normal session
 *   untouched.
 * - The `!` intercept drives `session.executeBash(cmd, undefined,
 *   { operations, excludeFromContext })`. The remote-provider test composes
 *   that exact call shape with the generic runtime ops (fetch-mocked gateway),
 *   covering the `runtimeProviderId` backend path the sdk-e2e can't reach
 *   without live sandbox credentials.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BashOperations,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getWorkerRuntimeProvider } from "../embedded/runtime/index";
import {
  buildAgentSession,
  normalizeHydratedSessionFile,
  persistBangBashSession,
} from "../runtime/session-runner";

let tempDir: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bang-bash-session-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  mock.restore();
});

/**
 * The header timestamp has millisecond precision, and a same-run retry in prod
 * comes seconds later. Without crossing a millisecond boundary between writes,
 * a regenerated-timestamp regression (the exact `exportToJsonl()` bug the
 * helper exists to avoid) would serialize identical bytes and slip through.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 3));
}

const localOps: BashOperations = {
  exec: async (...args) => {
    args[2].onData(Buffer.from("bang-output\n"));
    return { exitCode: 0 };
  },
};

/** A real pi session backed by a real on-disk session file, like the worker's. */
async function makeSession() {
  const sessionManager = SessionManager.create(
    tempDir,
    join(tempDir, "sessions")
  );
  const { session } = await buildAgentSession({
    cwd: tempDir,
    sessionManager,
    customTools: [],
  });
  return {
    session,
    sessionManager,
    sessionFile: sessionManager.getSessionFile(),
  };
}

describe("persistBangBashSession", () => {
  test("same-run retry is byte-idempotent, and the file round-trips", async () => {
    const { session, sessionManager, sessionFile } = await makeSession();
    await session.executeBash("echo bang", undefined, {
      operations: localOps,
    });

    await persistBangBashSession(sessionManager, sessionFile);
    const first = await fs.readFile(sessionFile);
    expect(first.length).toBeGreaterThan(0);

    await tick();
    await persistBangBashSession(sessionManager, sessionFile);
    const second = await fs.readFile(sessionFile);
    expect(second.equals(first)).toBe(true);

    // The written bytes are exactly what SessionManager.open() expects on the
    // next hydrate: same header id, same branch entry ids, record intact.
    const reopened = SessionManager.open(sessionFile);
    expect(reopened.getHeader()?.id).toBe(sessionManager.getHeader()?.id);
    expect(reopened.getBranch().map((e) => e.id)).toEqual(
      sessionManager.getBranch().map((e) => e.id)
    );

    // A retry AFTER a rehydrate must also be byte-identical — the header and
    // entries must survive open() verbatim (no regenerated timestamps).
    await tick();
    await persistBangBashSession(reopened, sessionFile);
    const third = await fs.readFile(sessionFile);
    expect(third.equals(first)).toBe(true);

    session.dispose();
  });

  test("no header yet → writes nothing (blocked-preflight on a virgin manager)", async () => {
    const sessionManager = SessionManager.create(
      tempDir,
      join(tempDir, "sessions-virgin")
    );
    const sessionFile = sessionManager.getSessionFile();
    if (sessionManager.getHeader() === null) {
      await persistBangBashSession(sessionManager, sessionFile);
      expect(existsSync(sessionFile)).toBe(false);
    } else {
      // pi mints the header at create() in this version — the guard is then
      // unreachable and persisting a branch-less session must still round-trip.
      await persistBangBashSession(sessionManager, sessionFile);
      const reopened = SessionManager.open(sessionFile);
      expect(reopened.getHeader()?.id).toBe(sessionManager.getHeader()?.id);
    }
  });
});

describe("normalizeHydratedSessionFile", () => {
  test("assistant-less session → file truncated so pi's re-append can't double the header", async () => {
    const { session, sessionManager, sessionFile } = await makeSession();
    await session.executeBash("echo bang", undefined, {
      operations: localOps,
    });
    await persistBangBashSession(sessionManager, sessionFile);
    expect((await fs.readFile(sessionFile)).length).toBeGreaterThan(0);

    await normalizeHydratedSessionFile(sessionManager, sessionFile);
    expect((await fs.readFile(sessionFile)).length).toBe(0);

    session.dispose();
  });

  test("session WITH an assistant message → file left untouched", async () => {
    const { session, sessionManager, sessionFile } = await makeSession();
    await session.executeBash("echo bang", undefined, {
      operations: localOps,
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      timestamp: Date.now(),
    } as never);
    await persistBangBashSession(sessionManager, sessionFile);
    const before = await fs.readFile(sessionFile);

    await normalizeHydratedSessionFile(sessionManager, sessionFile);
    const after = await fs.readFile(sessionFile);
    expect(after.equals(before)).toBe(true);

    session.dispose();
  });

  test("missing file (fresh conversation) → no throw", async () => {
    const { session, sessionManager } = await makeSession();
    await normalizeHydratedSessionFile(
      sessionManager,
      join(tempDir, "does-not-exist.jsonl")
    );
    session.dispose();
  });
});

describe("`!` intercept call shape against the remote runtime backend", () => {
  test("executeBash with provider ops + excludeFromContext hits the gateway and records the flagged entry", async () => {
    const fetchMock = mock(async () =>
      Response.json({ stdout: "remote-ok\n", stderr: "", exitCode: 0 })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = getWorkerRuntimeProvider("vercel");
    if (!provider) throw new Error("vercel provider not registered");
    const remoteOps = provider.createBashOps({
      gw: {
        gatewayUrl: "http://127.0.0.1:8787/lobu/",
        workerToken: "worker-token",
        channelId: "chan",
        conversationId: "conv",
        workspaceDir: "/workspace/conv",
      },
    });

    const { session, sessionManager, sessionFile } = await makeSession();
    // The exact call the `!!` intercept makes (session-runner's bangBash path).
    const result = await session.executeBash("echo remote", undefined, {
      operations: remoteOps,
      excludeFromContext: true,
    });

    expect(result.cancelled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("remote-ok");

    // The command went to the gateway's generic runtime route with the worker
    // bearer token — not to a local shell.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/lobu/internal/runtime/exec");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer worker-token"
    );
    expect(JSON.parse(String(init.body)).command).toBe("echo remote");

    // pi recorded the bashExecution entry carrying excludeFromContext, and the
    // force-flush is byte-idempotent on a remote-backed record too.
    const entry = sessionManager
      .getBranch()
      .find((e) => e.type === "message" && e.message.role === "bashExecution");
    if (!entry || entry.type !== "message") {
      throw new Error("no bashExecution entry recorded");
    }
    expect(
      (entry.message as { excludeFromContext?: boolean }).excludeFromContext
    ).toBe(true);

    await persistBangBashSession(sessionManager, sessionFile);
    const first = await fs.readFile(sessionFile);
    await tick();
    await persistBangBashSession(sessionManager, sessionFile);
    expect((await fs.readFile(sessionFile)).equals(first)).toBe(true);

    session.dispose();
  });
});
