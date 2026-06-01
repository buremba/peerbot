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

The full harness is the open-source [`agent-memory-benchmark`](https://github.com/lobu-ai/agent-memory-benchmark) repo. Every system is reached only through its public client (REST/SDK/local server) — no privileged database access — so the numbers reflect what a real user actually gets. External systems are integrated as long-lived Python adapter subprocesses framed over JSONL-on-stdin, which avoids per-op fork/exec cost.

### Prerequisites

- Bun and Node.js 22.x–24.x
- `ZAI_API_KEY` (z.ai, used as the answerer model `glm-5.1`)
- API keys for any external systems you want to include: `MEM0_API_KEY`, `SUPERMEMORY_API_KEY`, `LETTA_API_KEY`, `ZEP_API_KEY`

```bash
git clone https://github.com/lobu-ai/agent-memory-benchmark
cd agent-memory-benchmark && bun install
bun run scripts/run.ts --config configs/<config>.json
```

Each config selects a suite (LongMemEval / LoCoMo) and the systems to compare; the Lobu adapter talks to a running `lobu` server over its public REST API. The full config list is in the [repo README](https://github.com/lobu-ai/agent-memory-benchmark#readme).

## GitHub Actions

The benchmark repo runs the harness in CI and publishes JSON + Markdown artifacts to its leaderboard site — see [`.github/workflows/benchmark.yml`](https://github.com/lobu-ai/agent-memory-benchmark/blob/main/.github/workflows/benchmark.yml).

## Adapters

Adapters live in [`adapters/`](https://github.com/lobu-ai/agent-memory-benchmark/tree/main/adapters) (Mem0, Supermemory, Letta, Zep, and Lobu). To add a new system, write a Python adapter that defines `reset` / `setup` / `ingest` / `retrieve` handlers over the shared [`_bench_protocol.py`](https://github.com/lobu-ai/agent-memory-benchmark/blob/main/adapters/_bench_protocol.py), then open a PR.

## Why Lobu wins on retention

Lobu blends three signals for recall:

1. Entity name matching
2. Full-text search
3. Semantic vector search

Plus structured retrieval — Lobu stores knowledge in entity types backed by JSON Schema, with first-class relationships and superseding writes. That is why it reaches 100% retrieval on LongMemEval where vector-only systems plateau in the 80–90% range.
