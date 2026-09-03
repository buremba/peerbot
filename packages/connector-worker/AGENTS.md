# Connector worker package agent rules

Read root `AGENTS.md` first. This package is the connector/embedding executor: a
daemon polls the worker API for jobs and runs each connector sync/action in an
isolated child process. `@lobu/connector-worker/compile` is the shared compile
pipeline also used by `@lobu/cli` and `@lobu/server`.

## Boundaries

- Connector code runs in an isolated Node child (direct `fork`, or a
  `nix-shell` wrapper for declared native packages). This is process isolation,
  not a hardened security sandbox. `SubprocessExecutor` defaults to a 10-minute
  timeout and 512 MB V8 old space; the daemon sets 1024 MB, and interactive auth
  disables the fixed timeout while it waits for the user.
- The child inherits the small system-env allowlist in `executor/subprocess.ts`
  plus explicit `job.env`, never the complete host environment. Credentials and
  config belong in the typed job context; never expose `WORKER_API_TOKEN` to
  connector code.
- No durable state lives on the worker: connector checkpoints are persisted by
  the gateway, not here, and the child has no direct Lobu DB handle.
- The executor is generic; device-pinned connectors and cloud-fleet daemons are
  caller concerns (capability/platform), not executor semantics.
- `@lobu/connector-sdk` is externalized; the worker provides it at runtime.

## Key modules

- `compile/index.ts` — the shared connector esbuild pipeline
  (`compileConnectorFromFile`, `EXTERNAL_RUNTIME_DEPS`, the `npm:` resolver, an
  mtime-keyed LRU). It owns compile flags and filename resolution; callers own
  their environment-specific candidate-directory lists.
- `executor/` — connector execution behind one `SyncExecutor` contract
  (`interface.ts`). `select.ts` picks the lane from the job: `subprocess.ts` +
  `child-runner.ts` fork a Node child (parent↔child speak `ExecutorJob` /
  `ExecutorResult` over IPC); `isolate.ts` runs a pure-JS bundle inside a V8
  isolate in-process. A job that says `lane: 'isolate'` never falls back to a
  child: without `isolated-vm` the run fails. `redact.ts` removes recognized
  secret patterns from either lane's output before it reaches logs.
- `isolate/` — the isolate lane's host side: `load.ts` (Node-major gated
  `isolated-vm` loader, null under Bun), `bridge.ts` (`IsolateHost`: memory
  limit, wall clock, named sync/async capabilities as `ivm.Reference`s),
  `prelude.ts` (the guest's globals — timers, console, URL, TextEncoder,
  AbortController, fetch — all over host capabilities; add one only with a
  connector that needs it), `eligibility.ts` (rejects bundles that still
  `require()` a Node builtin).
- `daemon/` — the poll loop (`worker.ts`, `executor.ts`) that claims and runs
  jobs from the worker API. `automation.ts` is the device-only Automation arm:
  it spawns the user's local agent CLI per its `AgentSpec` (from
  `@lobu/core/contracts/worker/device-automation`) with the user's own
  environment minus `WORKER_API_TOKEN` — not the connector-child env allowlist.
  `automation-process.ts` owns that CLI's OS process tree: it spawns the agent
  under a process-group anchor so descendants can be terminated through an
  identity the kernel cannot recycle underneath the daemon.
- `self-check/` — connector-runtime parity assertions (packaging only; no
  network or DB).
- `embeddings*.ts` — local/remote embedding generation for emitted content and
  embedding-backfill jobs.

## Package-specific traps

- This package is **biome-excluded** (`config/biome.config.json`); edit
  surgically, matching each file's existing style.
- Server/CLI consumers resolve this package through `dist`; rebuild before
  exercising those entrypoints. `bun run daemon` loads daemon source through
  `tsx`, but its subprocess still prefers `dist/executor/child-runner.js` when
  that file exists.

## Validation

- Validation: targeted `@lobu/connector-worker` tests plus the root gates (see
  root `AGENTS.md`).
