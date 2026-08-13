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
  caller concerns (capability/platform), not executor behavior.
- `@lobu/connector-sdk` is externalized; the worker provides it at runtime.

## Key modules

- `compile/index.ts` — the shared connector esbuild pipeline
  (`compileConnectorFromFile`, `EXTERNAL_RUNTIME_DEPS`, the `npm:` resolver, an
  mtime-keyed LRU). It owns compile flags and filename resolution; callers own
  their environment-specific candidate-directory lists.
- `executor/` — isolated child execution (`child-runner.ts`, `runtime.ts`,
  `subprocess.ts`); parent↔child speak `ExecutorJob` / `ExecutorResult` over
  IPC. `redact.ts` removes recognized secret patterns from child output before
  it reaches logs.
- `daemon/` — the poll loop (`worker.ts`, `executor.ts`) that claims and runs
  jobs from the worker API.
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

- Validation: targeted `@lobu/connector-worker` tests plus the root gates
  (normally `make pre-pr-remote`, then `make review`; see root `AGENTS.md`).
