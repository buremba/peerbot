---
title: Memory benchmarks
description: How Lobu compares to Mem0, Supermemory, and Letta on public memory benchmarks, and how to reproduce the numbers.
---

Lobu's memory system is benchmarked against external memory systems (Mem0, Supermemory, Letta, Zep) on public datasets. This page summarises the headline numbers and points at the reproducible harness.

## Headline results

Same answerer (`glm-5.1` via z.ai), same top-K, same questions, three trials per public configuration.

### LongMemEval (oracle-50)

Single-session knowledge retention.

| System | Overall | Answer | Retrieval | Latency |
|---|---:|---:|---:|---:|
| **Lobu** | **87.1%** | **78.0%** | **100.0%** | 237ms |
| Supermemory | 69.1% | 56.0% | 96.6% | 702ms |
| Mem0 | 65.7% | 54.0% | 85.3% | 753ms |

### LoCoMo-50

Multi-session conversational memory (each scenario is ~19 sessions of 18+ turns, then a question grounded in the dialogue).

| System | Overall | Answer | Retrieval | Latency |
|---|---:|---:|---:|---:|
| **Lobu** | **57.8%** | **38.0%** | **79.5%** | **121ms** |
| Mem0 | 41.5% | 28.0% | 66.9% | 606ms |
| Supermemory | 23.2% | 14.0% | 36.5% | 532ms |

## Methodology guardrails

The harness applies the following fairness constraints:

- **Per-scenario isolation** — every scenario runs in a fresh system state. Providers do not search across earlier scenarios from the same run.
- **Multi-trial public runs** — public full-QA configs default to three trials so reports show run-to-run variability.
- **Uniform top-K** — every adapter asks for exactly the configured `topK`. No silent overfetch.
- **Per-system answerer token totals** — leaderboards include answerer-side prompt and completion tokens so LLM cost is visible alongside accuracy.
- **Parallel system execution** — compare configs run systems in parallel (`Promise.allSettled`); one provider's failure does not abort the others.
- **Async ingest is waited out** — for providers that index asynchronously (Zep's `/graph-batch`), the adapter polls until the server reports the ingest processed.
- **Raw metrics first** — treat answer accuracy, retrieval recall, and citation quality as the primary comparison. The reported "overall" number is a secondary house score.

### Latency caveat

Latency is **retrieval-only latency**, not end-to-end wall clock. It is not fully apples-to-apples when one system is local/in-process and another is a hosted API. Lobu's retrieval path is a multi-step plan (query expansion, entity search, content search, linked-context fetches) — that orchestration is what gets it to 100% retrieval recall on LongMemEval but also costs round trips. Mem0 and Supermemory adapters issue a single provider search per question.

## Reproducing the results

The full harness lives in the [`owletto` repo](https://github.com/lobu-ai/owletto) under [`benchmarks/memory/`](https://github.com/lobu-ai/owletto/tree/main/benchmarks/memory). The TypeScript runner is at `src/benchmarks/memory/`. External systems are integrated as long-lived Python adapter subprocesses framed over JSONL-on-stdin, which avoids per-op fork/exec cost.

### Prerequisites

- Node.js 20+, pnpm 9+, Docker
- `ZAI_API_KEY` (z.ai, used as the answerer model `glm-5.1`)
- API keys for any external systems you want to include: `MEM0_API_KEY`, `SUPERMEMORY_API_KEY`, `LETTA_API_KEY`, `ZEP_API_KEY`

### LongMemEval oracle-50, all systems

```bash
ZAI_API_KEY=... MEM0_API_KEY=... SUPERMEMORY_API_KEY=... LETTA_API_KEY=... \
  pnpm benchmark:memory --config benchmarks/memory/config.longmemeval.oracle.50.compare.all.zai.json
```

### LoCoMo-50, three-way (Lobu vs Mem0 vs Supermemory)

```bash
ZAI_API_KEY=... MEM0_API_KEY=... SUPERMEMORY_API_KEY=... \
  pnpm benchmark:memory --config benchmarks/memory/config.locomo.50.compare.top-memory.zai.json
```

### Lobu-only, no external API keys

```bash
# Retrieval-only (no answerer)
pnpm benchmark:memory --config benchmarks/memory/config.longmemeval.oracle.50.json

# Full QA with z.ai answerer
ZAI_API_KEY=... pnpm benchmark:memory --config benchmarks/memory/config.longmemeval.oracle.50.zai.json
ZAI_API_KEY=... pnpm benchmark:memory --config benchmarks/memory/config.locomo.50.zai.json
```

### Smaller LoCoMo slices

```bash
pnpm benchmark:memory --config benchmarks/memory/config.locomo.5.local.json
pnpm benchmark:memory --config benchmarks/memory/config.locomo.10.compare.top-memory.zai.json
pnpm benchmark:memory --config benchmarks/memory/config.locomo.30.local.json
```

A complete table of available configs is documented in [`benchmarks/memory/README.md`](https://github.com/lobu-ai/owletto/blob/main/benchmarks/memory/README.md#available-configs).

## GitHub Actions

The Memory Benchmark workflow runs the same harness in CI and uploads JSON + Markdown artifacts.

- Workflow: [`benchmark-memory.yml`](https://github.com/lobu-ai/owletto/blob/main/.github/workflows/benchmark-memory.yml)
- Trigger: [Actions → Memory Benchmark → Run workflow](https://github.com/lobu-ai/owletto/actions/workflows/benchmark-memory.yml)

Inputs include `dataset` (`longmemeval-oracle` or `locomo`), `limit`, `trials`, `model` (answerer model id), and `providers` (comma-separated adapter list).

## Adapters

| System | Adapter | Notes |
|---|---|---|
| Mem0 | [`adapters/mem0_adapter.py`](https://github.com/lobu-ai/owletto/blob/main/benchmarks/memory/adapters/mem0_adapter.py) | `MEM0_API_KEY` |
| Supermemory | [`adapters/supermemory_adapter.py`](https://github.com/lobu-ai/owletto/blob/main/benchmarks/memory/adapters/supermemory_adapter.py) | `SUPERMEMORY_API_KEY` |
| Letta | [`adapters/letta_adapter.py`](https://github.com/lobu-ai/owletto/blob/main/benchmarks/memory/adapters/letta_adapter.py) | `LETTA_API_KEY` |
| Zep | [`adapters/zep_adapter.py`](https://github.com/lobu-ai/owletto/blob/main/benchmarks/memory/adapters/zep_adapter.py) | `ZEP_API_KEY` (Cloud) or `ZEP_BASE_URL` (self-hosted) |

To add a new system, write a Python adapter that defines `reset` / `setup` / `ingest` / `retrieve` action handlers. The shared protocol module is at [`adapters/_bench_protocol.py`](https://github.com/lobu-ai/owletto/blob/main/benchmarks/memory/adapters/_bench_protocol.py).

## Why Lobu wins on retention

Lobu blends three signals for recall:

1. Entity name matching
2. Full-text search
3. Semantic vector search

Plus structured retrieval — Lobu stores knowledge in entity types backed by JSON Schema, with first-class relationships and superseding writes. That is why it reaches 100% retrieval on LongMemEval where vector-only systems plateau in the 80–90% range.
