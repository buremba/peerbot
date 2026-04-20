# Memory Benchmark Harness

This folder holds the reproducible memory benchmark harness used to compare Owletto against external memory systems (Mem0, Supermemory, Letta, Zep) on public datasets.

The headline result tables are published in the [main README](../../README.md#benchmarks). This document covers **how to reproduce them**, how the harness is structured, and what caveats matter when interpreting the results.

## Layout

```
benchmarks/memory/
├── adapters/              # Python adapters for external systems
│   ├── _bench_protocol.py # Shared JSONL-over-stdin protocol
│   ├── mem0_adapter.py
│   ├── supermemory_adapter.py
│   ├── letta_adapter.py
│   └── zep_adapter.py
├── suites/                # Benchmark question/scenario sets
│   ├── locomo.50.json
│   ├── longmemeval-oracle.10.json
│   ├── longmemeval-oracle.50.json
│   └── owletto-memory-bench.v1.json
├── config.example.json    # Reference multi-system config
└── config.*.json          # Per-scenario run configs
```

The TypeScript runner lives at `src/benchmarks/memory/`. Each adapter implements `reset` / `setup` / `ingestScenario` / `retrieve` / `dispose`. Python adapters share a long-lived JSONL-over-stdin protocol so the per-op fork+exec cost stays out of the wall clock.

## Methodology guardrails

The public harness now applies the following fairness constraints:

- **Per-scenario isolation:** every benchmark scenario runs in a fresh system state. Providers do not search across earlier scenarios from the same benchmark run.
- **Multi-trial public runs:** public full-QA configs default to **3 trials** so reports can include basic run-to-run variability.
- **Uniform top-K:** every adapter asks its provider for **exactly the configured `topK`** — no silent overfetch (earlier Letta/Zep code had a `topK * 3` overfetch hack; it has been removed).
- **Per-system answerer token totals:** report leaderboards include `Answerer prompt tok` and `Answerer completion tok` when a QA answerer is configured, so answerer-side LLM cost is visible alongside accuracy.
- **Parallel system execution:** compare configs can run systems in parallel (`parallelSystems: true`, default) via `Promise.allSettled`; one provider's failure (e.g. Zep quota exhaustion) does not abort the other systems.
- **Async ingest is waited out:** for providers that index asynchronously (Zep's `/graph-batch`), the adapter polls until the server reports the ingest processed before allowing retrieval. Otherwise recall numbers are artificially zero.
- **Raw metrics first:** treat **answer accuracy**, **retrieval recall**, and **citation quality** as the primary comparison. The reported **overall** number is a secondary house score.
- **Latency caveat:** latency is **retrieval-only latency** and is not fully apples-to-apples when one system is local/in-process and another is a hosted API.

## Datasets

### LongMemEval (oracle-50)

Single-session knowledge questions where the relevant context is provided up-front and the system must remember it across an extended chat history. Tests **knowledge retention**.

### LoCoMo (50 scenarios × ~19 sessions)

Multi-session conversational benchmark. Each scenario is ~19 sessions of 18+ turns between two participants, then a question grounded in the dialogue. Categories: `single-hop`, `multi-hop`, `temporal`. Tests **long-horizon conversational memory**.

The Owletto adapter chunks each session by turn at ingest, then reconstructs the full session text at retrieval — this keeps both fine-grained recall and full-context grounding.

## Reproducing the published results

### Prerequisites

- Node.js 20+, pnpm 9+, Docker
- `ZAI_API_KEY` (z.ai, used as the answerer model `glm-5.1`)
- API keys for every external system you want to include:
  - `MEM0_API_KEY`
  - `SUPERMEMORY_API_KEY`
  - `LETTA_API_KEY`
  - `ZEP_API_KEY` (optional — see [Zep](#zep-cloud-vs-self-hosted) below)

Public compare/full-QA presets in this folder default to **3 trials**. Retrieval-only smoke configs remain single-trial for speed.

### LongMemEval oracle-50, all systems

```bash
ZAI_API_KEY=... MEM0_API_KEY=... SUPERMEMORY_API_KEY=... LETTA_API_KEY=... \
  pnpm benchmark:memory --config benchmarks/memory/config.longmemeval.oracle.50.compare.all.zai.json
```

### LoCoMo-50, three-way (Owletto vs Mem0 vs Supermemory)

```bash
ZAI_API_KEY=... MEM0_API_KEY=... SUPERMEMORY_API_KEY=... \
  pnpm benchmark:memory --config benchmarks/memory/config.locomo.50.compare.top-memory.zai.json
```

### Owletto-only, no external API keys needed

```bash
# Retrieval-only (no answerer)
pnpm benchmark:memory --config benchmarks/memory/config.longmemeval.oracle.50.json

# Full QA with z.ai answerer
ZAI_API_KEY=... pnpm benchmark:memory --config benchmarks/memory/config.longmemeval.oracle.50.zai.json
ZAI_API_KEY=... pnpm benchmark:memory --config benchmarks/memory/config.locomo.50.zai.json
```

### Smaller LoCoMo slices (faster iteration)

```bash
pnpm benchmark:memory --config benchmarks/memory/config.locomo.5.local.json
pnpm benchmark:memory --config benchmarks/memory/config.locomo.10.compare.top-memory.zai.json
pnpm benchmark:memory --config benchmarks/memory/config.locomo.30.local.json
```

## Available configs

| Config | Suite | Systems | Notes |
|---|---|---|---|
| `config.example.json` | — | reference | Template showing all knobs |
| `config.local.json` | small | owletto-local | Quick smoke test |
| `config.local.retrieval-only.json` | small | owletto-local | No answerer call |
| `config.locomo.5.local.json` | LoCoMo-5 | owletto-local | Fastest iteration |
| `config.locomo.5.compare.all.zai.json` | LoCoMo-5 | owletto, mem0, supermemory, zep | Smoke compare against all hosted systems (1 trial) |
| `config.locomo.10.compare.top-memory.zai.json` | LoCoMo-10 | owletto, mem0, supermemory | Quick 3-way, 3 trials |
| `config.locomo.15.local.json` | LoCoMo-15 | owletto-local | |
| `config.locomo.30.local.json` | LoCoMo-30 | owletto-local | |
| `config.locomo.50.zai.json` | LoCoMo-50 | owletto-local | Owletto-only full run, 3 trials |
| `config.locomo.50.compare.top-memory.zai.json` | LoCoMo-50 | owletto, mem0, supermemory | Public 3-way compare, 3 trials |
| `config.longmemeval.oracle.50.json` | LongMemEval-50 | owletto-local | Retrieval-only |
| `config.longmemeval.oracle.50.zai.json` | LongMemEval-50 | owletto-local | Full QA, 3 trials |
| `config.longmemeval.oracle.50.compare.all.zai.json` | LongMemEval-50 | all systems | Public full compare, 3 trials |
| `config.longmemeval.oracle.50.compare.top-memory.zai.json` | LongMemEval-50 | owletto, mem0, supermemory | 3 trials |
| `config.longmemeval.oracle.50.compare.supermemory.zai.json` | LongMemEval-50 | owletto, supermemory | 3 trials |
| `config.longmemeval.oracle.50.compare.supermemory.native.zai.json` | LongMemEval-50 | owletto + supermemory variants | Compares Supermemory's native options, 3 trials |

## GitHub Actions

The **Memory Benchmark** workflow runs the same harness in CI and uploads JSON+Markdown artifacts.

- Workflow: [`benchmark-memory.yml`](../../.github/workflows/benchmark-memory.yml)
- Trigger: [Actions → Memory Benchmark → Run workflow](https://github.com/lobu-ai/owletto/actions/workflows/benchmark-memory.yml)

Inputs:

| Input | Values | Default |
|---|---|---|
| `dataset` | `longmemeval-oracle`, `locomo` | `longmemeval-oracle` |
| `limit` | integer (number of scenarios) | `50` |
| `trials` | integer (full benchmark reruns) | `3` |
| `model` | answerer model id (e.g. `glm-5.1`) | `glm-5.1` |
| `providers` | comma-separated: `owletto-local,supermemory,supermemory-rerank,supermemory-profile,mem0,letta` | `owletto-local,supermemory,mem0` |

Each run writes a summary into the GitHub Actions UI and uploads the JSON/Markdown report under **Artifacts**.

## Adapters

External systems are integrated as Python adapters under `adapters/`. Each adapter is a long-lived subprocess that the TypeScript runner spawns once and then frames each operation as one line of JSON over stdin (`{"id": N, "action": "...", "payload": {...}}`). Responses come back on stdout, matched by `id`. This avoids the ~250 ms fork+exec cost per op that a 1000-op LoCoMo-50 run would otherwise pay.

| System | Adapter | API key |
|---|---|---|
| Mem0 | [`adapters/mem0_adapter.py`](adapters/mem0_adapter.py) | `MEM0_API_KEY` |
| Supermemory | [`adapters/supermemory_adapter.py`](adapters/supermemory_adapter.py) | `SUPERMEMORY_API_KEY` |
| Letta | [`adapters/letta_adapter.py`](adapters/letta_adapter.py) | `LETTA_API_KEY` |
| Zep | [`adapters/zep_adapter.py`](adapters/zep_adapter.py) | `ZEP_API_KEY` (Cloud) or `ZEP_BASE_URL` (self-hosted) |

To add a new system, write a Python adapter that defines `reset` / `setup` / `ingest` / `retrieve` action handlers and ends with `raise SystemExit(serve(ACTIONS))`. The shared protocol module is at [`adapters/_bench_protocol.py`](adapters/_bench_protocol.py).

### Zep (Cloud vs self-hosted)

- **Zep Cloud** requires `ZEP_API_KEY`.
- **Self-hosted Zep**: set `ZEP_BASE_URL` (e.g. `http://localhost:8000/api/v2`). When `ZEP_BASE_URL` points at a local host, `ZEP_API_KEY` is optional.
- Self-hosted Zep works in local benchmark runs, not in GitHub Actions runs against your laptop.
- Zep Cloud's `/graph-batch` is **asynchronous**: `POST` returns 202 with `processed: false`, then the server indexes episodes in the background. The adapter polls `GET /graph/episodes/{uuid}` on the tail episode and waits for `processed: true` before finishing `ingest`, otherwise retrieval fires against an empty index (0% recall). Tuning knobs: `ZEP_INGEST_WAIT_SECONDS` (default 600), `ZEP_INGEST_POLL_INTERVAL` (default 3.0), `ZEP_MAX_RETRIES` on 429s (default 5, exponential backoff).
- Zep Cloud **free tier** has a global rate limit and an **episode usage quota** that a single LoCoMo-50 run can exhaust. Expect `403 forbidden: Account is over the episode usage limit` when the quota is gone. Paid accounts are recommended for full-suite comparisons.

## Interpreting latency fairly

The benchmark's `latency` field is **retrieval latency**, not end-to-end wall clock. The reported `context tokens` is a client-side estimate (`chars / 4`).

Public accuracy comparisons are close to apples-to-apples because all systems get the same scenarios, same questions, same top-K, and same downstream answerer. Latency is inherently less apples-to-apples whenever Owletto is run **locally/in-process** while competing systems are called as **hosted APIs over the network**.

Owletto's retrieval path is a **multi-step plan**, not a single provider call:

- shared query expansion / normalization in the product search path
- entity search plus org-wide content search
- entity-scoped content reads for matched entities
- linked-context fetches
- chronology-aware historical reads when the prompt implies it

That extra orchestration is what gets Owletto to **100% retrieval recall** on LongMemEval, but it also costs round trips. By contrast, the Mem0 and Supermemory adapters issue a **single provider search request** per question and return the top hits directly.

So the latency comparison should be read as:

- **Owletto:** richer retrieval orchestration, higher recall, higher latency-per-call, lower total LLM cost downstream
- **Mem0 / Supermemory:** thinner single-call path, lower latency-per-call, lower recall

A minimal single-query Owletto fast-path is not part of the published runs.

## Open levers / next steps

The current weakest categories and the most actionable improvements are tracked in [`docs/memory-benchmark-next-steps.md`](../../docs/memory-benchmark-next-steps.md).
