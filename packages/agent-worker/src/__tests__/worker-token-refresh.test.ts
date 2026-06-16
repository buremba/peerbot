/**
 * Worker-side token refresh (warm-worker + long-single-turn 2h TTL fix).
 *
 * Every worker token (deployment-lifetime WORKER_TOKEN at spawn, per-run
 * runJobToken per message) carries a fixed timestamp and is rejected 2h later
 * (#1266 — the short TTL is the leak-revocation property). Coverage:
 *
 *   - per-turn adoption: the transport's gateway POSTs use the freshly-adopted
 *     per-run token, never a stale captured one (the warm-worker-across-turns
 *     case — each turn mints a new token).
 *   - proactive refresh: when the live token is near expiry, the next gateway
 *     call refreshes BEFORE the 401.
 *   - reactive refresh: a 401 triggers one refresh + retry.
 *   - refresh denied (the revocation property): when the gateway denies refresh
 *     (deployment no longer live → 403), the manager keeps the old token and
 *     does not loop. The server-side liveness gate is tested in
 *     packages/server/src/gateway/__tests__/worker-token-refresh-route.test.ts.
 *   - the >2h single-turn case: a turn whose token would expire mid-turn gets a
 *     fresh token via reactive refresh so its terminal POST still succeeds.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HttpWorkerTransport } from "../gateway/gateway-integration";
import {
  __resetWorkerTokenManagerForTests,
  adoptWorkerToken,
  getWorkerTokenManager,
} from "../gateway/worker-token-manager";
import { writeSnapshot } from "../openclaw/transcript-snapshot";

let originalFetch: typeof globalThis.fetch;
let capturedAuth: string[];
let originalDispatcher: string | undefined;
let originalWorkerToken: string | undefined;
let originalTtl: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalDispatcher = process.env.DISPATCHER_URL;
  originalWorkerToken = process.env.WORKER_TOKEN;
  originalTtl = process.env.WORKER_TOKEN_TTL_MS;
  process.env.DISPATCHER_URL = "http://gw.test/lobu";
  capturedAuth = [];
  __resetWorkerTokenManagerForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetWorkerTokenManagerForTests();
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("DISPATCHER_URL", originalDispatcher);
  restore("WORKER_TOKEN", originalWorkerToken);
  restore("WORKER_TOKEN_TTL_MS", originalTtl);
});

/** A fetch that records Authorization headers and returns 200 for response
 *  POSTs; the refresh endpoint returns a configurable token. */
function stubFetch(opts?: {
  responseStatusByAuth?: (auth: string) => number;
  refreshToken?: string | null;
  refreshStatus?: number;
}): void {
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth =
        (init?.headers as Record<string, string> | undefined)?.Authorization ??
        "";
      if (url.endsWith("/worker/token/refresh")) {
        if (opts?.refreshStatus && opts.refreshStatus !== 200) {
          return new Response("{}", { status: opts.refreshStatus });
        }
        const tok = opts?.refreshToken ?? "refreshed-token";
        return new Response(JSON.stringify({ token: tok }), { status: 200 });
      }
      if (auth) capturedAuth.push(auth);
      const status = opts?.responseStatusByAuth?.(auth) ?? 200;
      return new Response(JSON.stringify({ ok: true }), { status });
    }
  ) as unknown as typeof globalThis.fetch;
}

function makeTransport(workerToken: string): HttpWorkerTransport {
  return new HttpWorkerTransport({
    gatewayUrl: "http://gw.test/lobu",
    workerToken,
    userId: "U1",
    channelId: "C1",
    conversationId: "conv-1",
    originalMessageTs: "1.1",
    teamId: "T1",
    platform: "api",
  });
}

describe("per-turn token adoption (transport reads the live manager token)", () => {
  test("constructor seeds the manager; POST uses that token", async () => {
    stubFetch();
    const transport = makeTransport("deployment-token");
    await transport.signalCompletion();
    expect(capturedAuth.length).toBeGreaterThan(0);
    expect(capturedAuth.every((a) => a === "Bearer deployment-token")).toBe(
      true
    );
  });

  test("adopting the fresh per-run token flips the bearer on the wire", async () => {
    stubFetch();
    const transport = makeTransport("stale-deployment-token");
    // Mirrors OpenClawWorker.execute(): adopt the freshly-minted runJobToken.
    adoptWorkerToken("fresh-run-token");
    await transport.signalCompletion();
    expect(capturedAuth).not.toContain("Bearer stale-deployment-token");
    expect(capturedAuth.every((a) => a === "Bearer fresh-run-token")).toBe(
      true
    );
  });

  test("adopt also mirrors into process.env.WORKER_TOKEN for env-readers", () => {
    adoptWorkerToken("env-mirror-token");
    expect(process.env.WORKER_TOKEN).toBe("env-mirror-token");
  });

  test("falls back to the deployment token when no per-run token is adopted", async () => {
    // No adopt() call — the manager keeps the boot token.
    stubFetch();
    const transport = makeTransport("deployment-token");
    await transport.signalError(new Error("boom"));
    expect(capturedAuth.every((a) => a === "Bearer deployment-token")).toBe(
      true
    );
  });
});

describe("seed() never clobbers a live token (aux-transport rollback guard)", () => {
  test("constructing an aux transport after adopt cannot roll the token back", async () => {
    stubFetch();
    // Turn start: adopt the live per-run token (mirrors OpenClawWorker.execute).
    adoptWorkerToken("live-run-token");
    // An exec job mid-turn constructs an auxiliary transport from the STALE boot
    // token — its constructor seed() must no-op, not clobber the live token.
    const aux = makeTransport("stale-boot-token");
    expect(getWorkerTokenManager().getToken()).toBe("live-run-token");
    await aux.signalCompletion();
    expect(capturedAuth.every((a) => a === "Bearer live-run-token")).toBe(true);
    expect(capturedAuth).not.toContain("Bearer stale-boot-token");
  });

  test("warm worker turn 2: re-adopting overrides turn 1's token (seed can't undo it)", async () => {
    stubFetch();
    // Turn 1 on a warm worker left its token in the process-wide manager.
    adoptWorkerToken("turn-1-token");
    // Turn 2 re-adopts its own fresh per-run token (OpenClawWorker.execute).
    adoptWorkerToken("turn-2-token");
    // A transport built for turn 2 seeds (no-op) and must use turn-2's token.
    const aux = makeTransport("boot-token");
    await aux.signalCompletion();
    expect(capturedAuth.every((a) => a === "Bearer turn-2-token")).toBe(true);
    expect(capturedAuth).not.toContain("Bearer turn-1-token");
  });

  test("seed() is a no-op once a token has been adopted", () => {
    const mgr = getWorkerTokenManager();
    mgr.adopt("live-token");
    mgr.seed("stale-boot-token");
    expect(mgr.getToken()).toBe("live-token");
  });

  test("seed() sets the token while uninitialized, then no-ops on a re-seed", () => {
    const mgr = getWorkerTokenManager();
    mgr.seed("boot-token");
    expect(mgr.getToken()).toBe("boot-token");
    // A second aux transport seeding a different token must not change it.
    mgr.seed("other-token");
    expect(mgr.getToken()).toBe("boot-token");
  });
});

describe("proactive refresh (before expiry)", () => {
  test("a near-expiry token is refreshed before the gateway call", async () => {
    process.env.WORKER_TOKEN_TTL_MS = "1000"; // 1s TTL → window = last 200ms
    stubFetch({ refreshToken: "proactively-refreshed" });
    const mgr = getWorkerTokenManager();
    // Adopt with an issuedAt far enough in the past to be "near expiry".
    mgr.adopt("about-to-expire", Date.now() - 900);
    await mgr.ensureFresh();
    expect(mgr.getToken()).toBe("proactively-refreshed");
    expect(process.env.WORKER_TOKEN).toBe("proactively-refreshed");
  });

  test("a fresh token is NOT refreshed (no-op)", async () => {
    process.env.WORKER_TOKEN_TTL_MS = "100000";
    stubFetch({ refreshToken: "should-not-be-used" });
    const mgr = getWorkerTokenManager();
    mgr.adopt("still-fresh", Date.now());
    await mgr.ensureFresh();
    expect(mgr.getToken()).toBe("still-fresh");
  });
});

describe("timer-driven refresh (>2h turn with NO gateway call)", () => {
  test("the timer refreshes BEFORE expiry even when no gateway call is made", async () => {
    // The load-bearing fix for the >2h single-turn case: an on-demand-only
    // refresh would fire too late (expired bearer → route rejects pre-liveness).
    // Short TTL so the proactive window (last 20%) opens almost immediately.
    process.env.WORKER_TOKEN_TTL_MS = "200"; // window starts at age 160ms
    stubFetch({ refreshToken: "timer-refreshed" });
    const mgr = getWorkerTokenManager();
    mgr.adopt("will-expire-soon", Date.now());
    mgr.enableAutoRefresh();
    try {
      // Wait past the proactive-window start but before hard expiry would have
      // mattered — NO fetchWithRefresh / ensureFresh call in between.
      await new Promise((r) => setTimeout(r, 260));
      expect(mgr.getToken()).toBe("timer-refreshed");
      expect(process.env.WORKER_TOKEN).toBe("timer-refreshed");
    } finally {
      mgr.disableAutoRefresh();
    }
  });

  test("disableAutoRefresh stops further timer refreshes", async () => {
    process.env.WORKER_TOKEN_TTL_MS = "200";
    let refreshCount = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/worker/token/refresh")) {
        refreshCount += 1;
        return new Response(JSON.stringify({ token: `r${refreshCount}` }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const mgr = getWorkerTokenManager();
    mgr.adopt("seed", Date.now());
    mgr.enableAutoRefresh();
    mgr.disableAutoRefresh();
    await new Promise((r) => setTimeout(r, 260));
    expect(refreshCount).toBe(0);
  });
});

describe("reactive refresh (401 → refresh → retry)", () => {
  test(">2h single turn: a 401 on the terminal POST refreshes and retries with the live token", async () => {
    process.env.WORKER_TOKEN_TTL_MS = "100000"; // not near expiry → no proactive
    // The expired turn token 401s; the refreshed token succeeds.
    stubFetch({
      refreshToken: "mid-turn-refreshed",
      responseStatusByAuth: (auth) =>
        auth === "Bearer expired-turn-token" ? 401 : 200,
    });
    const transport = makeTransport("expired-turn-token");
    // signalCompletion's POST should 401, refresh, and retry — not throw.
    await transport.signalCompletion();
    // The retry carried the refreshed token.
    expect(capturedAuth).toContain("Bearer mid-turn-refreshed");
    expect(getWorkerTokenManager().getToken()).toBe("mid-turn-refreshed");
  });
});

describe("refresh epoch guard (no clobber across the turn boundary)", () => {
  test("a refresh resolving after the next turn adopts is discarded", async () => {
    // Hold the refresh response open until we explicitly release it. The
    // Promise executor runs synchronously, so releaseRefresh is assigned before
    // any use (definite assignment).
    let releaseRefresh!: (tok: string) => void;
    const refreshGate = new Promise<string>((res) => {
      releaseRefresh = res;
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/worker/token/refresh")) {
        const tok = await refreshGate;
        return new Response(JSON.stringify({ token: tok }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const mgr = getWorkerTokenManager();
    mgr.adopt("turn-1-token");
    // Turn 1 kicks off a refresh that stays in flight (blocked on the gate).
    const refreshPromise = mgr.refresh();
    // Turn 1 ends; turn 2 starts and adopts its own fresh token.
    adoptWorkerToken("turn-2-token");
    // Now turn 1's refresh finally resolves with a refreshed-turn-1 token.
    releaseRefresh("refreshed-turn-1-token");
    await refreshPromise;
    // The stale refresh must NOT clobber turn 2's live token.
    expect(mgr.getToken()).toBe("turn-2-token");
    expect(process.env.WORKER_TOKEN).toBe("turn-2-token");
  });
});

describe("refresh denied = the revocation property", () => {
  test("when the gateway denies refresh (deployment not live → 403), keep the old token, do not loop", async () => {
    process.env.WORKER_TOKEN_TTL_MS = "100000";
    stubFetch({ refreshStatus: 403 });
    const mgr = getWorkerTokenManager();
    mgr.adopt("dead-deployment-token", Date.now());
    const result = await mgr.refresh();
    expect(result).toBeNull();
    // Old token retained — no fresh token minted for terminal work.
    expect(mgr.getToken()).toBe("dead-deployment-token");
  });

  test("concurrent refreshes share one in-flight request (no thundering herd)", async () => {
    process.env.WORKER_TOKEN_TTL_MS = "100000";
    let refreshCalls = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/worker/token/refresh")) {
        refreshCalls += 1;
        return new Response(JSON.stringify({ token: "shared" }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const mgr = getWorkerTokenManager();
    mgr.adopt("seed", Date.now());
    const [a, b, c] = await Promise.all([
      mgr.refresh(),
      mgr.refresh(),
      mgr.refresh(),
    ]);
    expect([a, b, c]).toEqual(["shared", "shared", "shared"]);
    expect(refreshCalls).toBe(1);
  });
});

describe("refreshed token propagation (the refresh must not be a no-op)", () => {
  // GatewayParams.workerToken is a GETTER reading the live manager token, not a
  // captured string. session-runner builds it that way so every MCP/interaction
  // gateway call after a mid-turn refresh sends the NEW bearer. This asserts the
  // getter contract: mutating the manager (as refresh() does) is visible through
  // the getter without rebuilding GatewayParams.
  test("a GatewayParams-style workerToken getter reflects a mid-turn refresh", () => {
    const mgr = getWorkerTokenManager();
    mgr.adopt("turn-token", Date.now());
    // The exact shape session-runner builds.
    const gwParams = {
      get workerToken() {
        return getWorkerTokenManager().getToken();
      },
    };
    expect(gwParams.workerToken).toBe("turn-token");
    // A mid-turn refresh swaps the live token...
    mgr.adopt("mid-turn-refreshed", Date.now());
    // ...and the getter reflects it WITHOUT GatewayParams being rebuilt. A
    // captured string would still read "turn-token" here (the original bug).
    expect(gwParams.workerToken).toBe("mid-turn-refreshed");
  });

  test("the snapshot write uses the LIVE manager token, not the original per-run token", async () => {
    process.env.WORKER_TOKEN_TTL_MS = "100000";
    let snapshotAuth: string | null = null;
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/worker/transcript/snapshot")) {
          snapshotAuth =
            (init?.headers as Record<string, string> | undefined)
              ?.Authorization ?? null;
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }
    ) as unknown as typeof globalThis.fetch;

    const mgr = getWorkerTokenManager();
    // Turn started with the per-run token, then refreshed mid-turn.
    mgr.adopt("original-run-token", Date.now());
    mgr.adopt("refreshed-run-token", Date.now());

    // Write a temp session file so writeSnapshot has bytes to POST.
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/snap-${Date.now()}.jsonl`;
    const { promises: fsp } = await import("node:fs");
    await fsp.writeFile(tmp, '{"role":"user","content":"hi"}\n', "utf-8");
    try {
      // Mirrors OpenClawWorker.cleanup(): bearer = getWorkerTokenManager().getToken().
      await writeSnapshot({
        sessionFile: tmp,
        gatewayUrl: "http://gw.test/lobu",
        workerToken: getWorkerTokenManager().getToken(),
        terminalStatus: "completed",
        runId: 7,
      });
      // The snapshot POST carried the REFRESHED token, not the original — a
      // captured `this.config.runJobToken` would have sent (and 401'd on) the
      // now-expired original.
      expect(snapshotAuth).toBe("Bearer refreshed-run-token");
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  });
});
