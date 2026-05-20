# fix-sync-loop design

Two bugs block the headless `lobu run → lobu apply → trigger_feed → events appear` data sync loop on a fresh install. Both confirmed via local repro against the embedded server (PGlite, port 8802).

## Bug A — embedded mode never executes `runs(run_type='sync')`

`packages/server/src/tools/admin/manage_feeds.ts:483-509` and `packages/server/src/scheduled/check-due-feeds.ts` both insert pending `runs` rows. They are claimed and executed by the **out-of-process connector-worker daemon** (`packages/connector-worker/src/daemon/worker.ts` + `executor.ts`), which polls `/api/workers/poll` over HTTP. `lobu run` (embedded mode) boots the gateway + task scheduler but never starts the daemon, so feed-sync rows sit in `pending` forever. No `events` ever land.

`packages/server/src/lib/feed-sync.ts::runFeed` exists but only calls `executeCompiledConnector` and discards results — it does NOT persist `events`. The persistence path is the daemon's `client.stream(...)` call, which lands in `worker-api.ts::streamContent` and `insertEvent`. So a "tick that calls `runFeed` per pending run" would not produce events. We need the actual claim → execute → stream → complete pipeline.

### Fix

Run the connector-worker daemon **in-process** under `start-local.ts` / `server.ts` immediately after `bootTaskScheduler`, pointed at `http://127.0.0.1:${PORT}`. Same code path the standalone daemon uses; same atomic claim SQL (`packages/server/src/worker-api.ts::pollWorkerJob`); same complete/stream wiring. No new claim semantics, no double-execution concern — the daemon and any external worker fleet would coordinate via the existing `FOR UPDATE OF r SKIP LOCKED` claim filter.

Implementation:
- New module `packages/server/src/scheduled/embedded-connector-worker.ts` that **constructs `WorkerDaemon` directly** (NOT `startDaemon` — that installs signal handlers + `process.exit`, wrong for in-process use), then `void daemon.start().catch(logger.error)`.
- Started **after `httpServer.listen()` callback fires** so the daemon's boot-time `/api/health` check can resolve. In `start-local.ts`/`server.ts`, move the embedded-daemon spawn into the listen callback (or use a setImmediate post-listen).
- Wired into both `server.ts` and `start-local.ts`. Default ON in embedded mode; opt-out via `LOBU_DISABLE_EMBEDDED_WORKER=1` (e.g. prod with external fleet).
- Stable `worker_id` = `embedded:${hostname()}:${pid}` so claims are attributable in logs.
- Shutdown: call `daemon.stop()` + `await daemon.waitForActiveJobs(30_000)` from the existing `shutdown(signal)` path. Note: `stop()` only flips the running flag; it does NOT interrupt the in-flight `sleep(pollIntervalMs)`. The wait covers in-flight jobs; the daemon exits within `pollIntervalMs` after.

### Race / correctness

- Atomic claim already exists in `worker-api.ts::pollWorkerJob` (`FOR UPDATE OF r SKIP LOCKED LIMIT 1`). Embedded + external daemons can co-exist; whichever calls `/api/workers/poll` first wins the row. No double-execute.
- Heartbeat-lost reaper (`startStaleRunReaper`) already handles crashed/killed runs.
- Default OFF when `WORKER_API_TOKEN` is set AND `LOBU_DISABLE_EMBEDDED_WORKER=1` — so prod with external fleet can opt out.

## Bug B — `/api/workers/poll` 500s with `RangeError: init["status"] must be in the range of 200 to 599`

Repro: hit `/api/workers/poll` with a Bearer that resolves to a valid Better-Auth session (i.e. the install_operator). Server returns 500.

Stack:
```
RangeError at undici/initializeResponse
  new Response(body, init)
  at [getResponseCache] (@hono/node-server)
  at get headers (@hono/node-server)
  at set res (hono/context.js:133)
  at dispatch (hono/compose.js:38)
```

Trap output (instrumented `globalThis.Response` constructor):
- `body` = `(data, arg, headers) => this.#newResponse(data, arg, headers)` — i.e. the Hono Context's `c.body` method
- `init` = a Hono `Context` object (with `init.status` = the `c.status` method, which is a Function)

### Root cause

`packages/server/src/workspace/multi-tenant.ts::resolveAuth` is invoked two ways:
1. As a Hono middleware: `app.use('/foo', mcpAuth)` — `next` returns `Promise<void>`.
2. As a wrapped call: `app.use('/api/workers/*', async (c, next) => mcpAuth(c, async () => { ... return c.json(...); }))` — the cb's return value is a `Response`.

Inside `resolveAuth`, every branch uses the same pattern:
```ts
await setContextAndContinue({...});
return undefined;
```

`setContextAndContinue` returns `next()`. In case (2), `next` is the cb; the cb returns a `Response`; `setContextAndContinue` returns that `Response`. The caller **awaits then discards** it and returns `undefined`.

When the workers/* middleware's cb returns `c.json(..., 403)` (e.g. "Worker token missing device_worker:run scope" — session auth populates `mcpIsAuthenticated=true` but never sets `mcpAuthInfo`, so the scopes check fails), that 403 Response is lost. `mcpAuth` returns `undefined`. The workers middleware returns `undefined`. Hono compose sees `res=undefined && context.finalized=false` → does NOT set `c.res` AND advances to next handler (because the OUTER `next` was called via `setContextAndContinue → cb`-wait, actually the cb returned BEFORE calling outer `next`, so Hono should stop). The actual mechanism for the bad Response getting into `c.res` is somewhere downstream re-wraps via `c.header()`'s line 211 finalized-path which does `this.#res = createResponseInstance(this.#res.body, this.#res)` — but the upstream root cause is the discarded Response.

### Fix

Change `resolveAuth` so it propagates `setContextAndContinue`'s return value instead of discarding it. All eight call sites switch from:
```ts
await setContextAndContinue({...});
return undefined;
```
to:
```ts
return setContextAndContinue({...});
```

(`setContextAndContinue` already returns a Promise resolving to whatever `next()` resolves to. For middleware-style use, `next()` resolves to `undefined` — behavior preserved. For wrapped-cb use, the cb's Response now propagates.)

**Type widening required.** `WorkspaceProvider.resolveAuth` currently takes Hono `Next` (`() => Promise<void>`). `mcpAuth` already widens its `next` param to `() => Promise<unknown>` and casts to `Next` before calling `resolveAuth`. To make TypeScript see the cb's `Response` return value flow through, widen `WorkspaceProvider.resolveAuth`'s `next` param to `() => Promise<Response | undefined | void>` in `packages/server/src/workspace/types.ts`, and stop the `as Next` cast in `auth/middleware.ts`. Existing call sites that pass Hono's Next still typecheck (void is a subtype here).

### Validation

- Curl `/api/workers/poll` with the install_operator's signed session-token bearer: must return JSON (403 "missing device_worker:run scope" if session-only; 200 next_poll if PAT with proper scope). Not 500.
- Existing PAT/OAuth paths unchanged (cb already returns through `setContextAndContinue → next()`).

## Test plan

1. `make build-packages` → clean.
2. `make typecheck` → clean.
3. Boot `lobu run` against PGlite (port 8802). Sign in as install_operator. Trigger a feed via `manage_feeds.trigger_feed`. Wait ≤ 30s. Query `events` table — must have new rows. (Bug A fix.)
4. Curl `POST /api/workers/poll` with a session-token Bearer. Must return 200/403/204 — never 500. Grep server log for "RangeError" — none. (Bug B fix.)

## Schema / migrations

None. No new tables, no column changes.
