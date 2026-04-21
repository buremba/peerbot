---
title: Comparison
description: How Lobu compares to other agent deployment options.
---

Lobu is multi-tenant agent infrastructure. It handles sandboxing, persistence, platform delivery, and network isolation so you can ship agents to your users without building that plumbing yourself.

This page compares Lobu against alternatives for deploying agents to production.

## At a glance

| | Lobu | OpenClaw (direct) | DeepAgents Deploy | Claude Managed Agents |
|---|---|---|---|---|
| **What it is** | Self-hosted multi-tenant gateway | Single-user agent runtime | Hosted agent deployment (LangSmith) | Hosted managed agents |
| **Multi-tenant** | Per-user/channel isolation | Single user | Per-thread sandbox | Per-conversation |
| **Platforms** | Slack, Telegram, WhatsApp, Discord, Teams, Google Chat, REST API | CLI and API | API endpoints (MCP, A2A, Agent Protocol) | API |
| **Embeddable** | Mount inside Next.js, Express, Hono, Fastify | No | No | No |
| **Self-hosted** | Docker, Kubernetes | Single process | LangSmith hosted (self-host option) | Cloud only |
| **Model support** | Any provider via config | Any provider | Any LangChain-compatible provider | Anthropic only |
| **Runtime** | OpenClaw | OpenClaw | LangGraph | Claude |
| **Network isolation** | Gateway-mediated egress, domain filtering | Host network | Sandbox-level | Platform-managed |
| **Secrets handling** | Gateway proxy, workers never see credentials | Direct env vars | Environment variables | Platform-managed |
| **MCP support** | Proxied through gateway with secret injection | Direct | HTTP/SSE only | Yes |
| **Agent Protocol / A2A** | Not yet | No | Yes | No |
| **Built-in evals** | YAML eval framework with model comparison | No | No | No |
| **Memory** | Self-hosted Lobu memory plugin | Local | LangSmith APIs | Platform-managed |
| **Scale-to-zero** | Built-in idle timeout | Always running | Managed by LangSmith | Managed |
| **Config format** | `lobu.toml` + IDENTITY/SOUL/USER.md | CLI flags | `deepagents.toml` + AGENTS.md | Dashboard |
| **License** | Open source | Open source | MIT (harness), proprietary (hosting) | Proprietary |

## Memory benchmarks

Lobu's bundled memory system is benchmarked against Mem0 and Supermemory on public datasets. Same answerer (`glm-5.1` via z.ai), same top-K, same questions.

### LongMemEval (oracle-50)

Single-session knowledge retention.

| System | Overall | Answer | Retrieval | Latency |
|---|---:|---:|---:|---:|
| **Lobu** | **87.1%** | **78.0%** | **100.0%** | 237ms |
| Supermemory | 69.1% | 56.0% | 96.6% | 702ms |
| Mem0 | 65.7% | 54.0% | 85.3% | 753ms |

### LoCoMo-50

Multi-session conversational memory.

| System | Overall | Answer | Retrieval | Latency |
|---|---:|---:|---:|---:|
| **Lobu** | **57.8%** | **38.0%** | **79.5%** | **121ms** |
| Mem0 | 41.5% | 28.0% | 66.9% | 606ms |
| Supermemory | 23.2% | 14.0% | 36.5% | 532ms |

See the [memory benchmarks methodology](/guides/memory-benchmarks/) for fairness guardrails and reproduction steps.

## Sandboxing and deployment modes

Lobu offers three deployment modes, each with different isolation guarantees.

### Kubernetes (production, on-premise)

Each user session gets its own **pod** with:
- **Pod-level isolation** — constrained resources, separate PID/network namespaces
- **NetworkPolicies** — workers cannot reach the internet directly; all egress routes through the gateway proxy
- **RBAC** — gateway has minimum permissions to create/delete worker resources
- **PVC per session** — workspace files persist across restarts while remaining isolated per user
- **Runtime hardening** — designed to run with **gVisor** (GCP), **Kata Containers**, or **Firecracker microVMs** where available

The strongest isolation model, suited for on-premise deployments where compliance requires agent-generated code cannot escape its sandbox.

### Docker Compose (single-machine production)

Each user session gets its own **container** on an internal Docker network:
- Workers are not exposed to the host network
- All outbound traffic routes through the gateway HTTP proxy with domain filtering
- Scoped workspace volumes per session

Good for single-machine deployments and local development.

### Embedded (library mode, no Docker required)

Uses [just-bash](https://github.com/nicholasgasior/just-bash) (virtual bash) + **Nix** for reproducible packages. Each user gets an isolated virtual filesystem and bash session at ~50MB memory footprint. Tested at **300 concurrent instances on a single machine**.

Mount Lobu inside Next.js, Express, Hono, Fastify, or Bun — no Docker or Kubernetes needed. See [Embed in Your App](/deployment/embedding/).

### Comparison to other sandboxing approaches

| | Lobu (K8s) | Lobu (Docker) | Lobu (Embedded) | E2B | DeepAgents Deploy |
|---|---|---|---|---|---|
| Isolation | Pod + gVisor/Kata | Container | Virtual fs + Nix | Firecracker microVM | Daytona/Modal/Runloop |
| Self-hosted | Yes | Yes | Yes | Cloud API | LangSmith hosted |
| Network control | Gateway proxy + domain filtering | Gateway proxy + domain filtering | Gateway proxy | Sandbox-level | Sandbox-level |
| Startup time | Seconds (pod creation) | Seconds (container creation) | Instant (in-process) | <200ms | Varies by provider |
| Persistence | PVC per session | Volume per session | Directory per session | 24hr max | Thread-scoped, resets on restart |
| Per-user isolation | Yes | Yes | Yes | Per-sandbox | Per-thread |

## MCP proxy and credential isolation

Workers call MCP tools through the gateway. The gateway resolves `${env:VAR}` secrets and injects OAuth tokens before forwarding to the upstream MCP server. Workers never see credentials — they receive opaque proxy URLs.

| | Lobu | DeepAgents Deploy | Claude Managed Agents | Direct MCP |
|---|---|---|---|---|
| Secret injection | Gateway proxy resolves at request time | Environment variables | Platform-managed | Direct env vars |
| OAuth management | Lobu handles token refresh | Manual | Platform-managed | Manual |
| Transport support | HTTP, SSE, stdio (proxied) | HTTP/SSE only (no stdio) | Yes | All |
| Worker sees credentials | Never | Yes (env vars) | N/A | Yes |
| Audit trail | Gateway logs all MCP calls | No | No | No |

For compliance-bound deployments, agent code never touches API keys or OAuth tokens — even if the agent is compromised.

## Why Lobu for on-premise

Hosted platforms (DeepAgents Deploy, Claude Managed Agents) require sending your data, prompts, and agent memory to a third party. For regulated industries (finance, healthcare, government) or organizations with data residency requirements, this is a non-starter.

Lobu runs entirely on your infrastructure:
- **Data stays in your network** — Redis, workspaces, and memory are all self-hosted
- **No external dependencies** — the gateway, workers, and MCP proxy run on your machines
- **Network-level isolation** — workers on an internal network with gateway-mediated egress
- **Credential separation** — secrets never leave the gateway process
- **Audit everything** — gateway logs all LLM calls, MCP tool invocations, and network requests
- **Air-gapped compatible** — with local LLM providers (Ollama, vLLM), Lobu can run fully disconnected

## When to use Lobu

Lobu is the right choice when you need to **give multiple users their own agents**:

- **SaaS products** — embed agents in your app where each user gets isolated persistence, tools, and context.
- **Internal teams** — deploy a single bot to Slack or Teams where every employee gets their own sandboxed agent.
- **Customer support** — agents that handle tickets autonomously with human-in-the-loop approval gates.
- **Managed agent services** — operate agents for clients with per-tenant isolation and network controls.

If you need a single personal agent for yourself, use OpenClaw directly.

## Lobu vs OpenClaw

Lobu and OpenClaw are complementary. OpenClaw is the agent runtime — the execution engine that runs tools, manages sessions, and talks to LLM providers. Lobu is the infrastructure layer that deploys, isolates, and delivers that runtime to multiple users.

OpenClaw (~800k LOC) was designed as a **single-tenant, single-user system**. Production deployments need multi-tenant isolation, platform routing, credential separation, network control, and scale-to-zero — concerns OpenClaw doesn't have opinions about.

| Capability | Lobu | OpenClaw |
|---|---|---|
| Architecture | Multi-tenant gateway + isolated workers | Single-tenant, single-user |
| Platform delivery | Slack, Telegram, WhatsApp, Discord, Teams, Google Chat, REST API | CLI and API |
| Worker isolation | Sandboxed containers, no direct internet | Runs on host |
| Secret handling | Gateway proxy injects credentials | Direct env vars |
| Egress control | Domain allowlists via HTTP proxy | Host network |
| Scale-to-zero | Built-in idle timeout and wake | Always running |
| Deployment | Docker Compose, Kubernetes, or embedded | Single process |

Inside each Lobu worker, the full OpenClaw runtime runs untouched. Lobu rewrites only the gateway layer (~40k LOC) to be multi-tenant.

## Lobu vs DeepAgents Deploy

[DeepAgents Deploy](https://github.com/langchain-ai/deepagents) (LangChain) deploys a single agent to a hosted LangSmith server with 30+ API endpoints.

**Where they overlap**: both use a TOML config file, support MCP, and offer model-agnostic provider selection.

**Where they differ**:

| | Lobu | DeepAgents Deploy |
|---|---|---|
| Hosting | Self-hosted (you own the infra) | Hosted on LangSmith |
| Multi-tenant | Per-user sandboxed workers | Per-thread sandbox |
| Platform delivery | Native Slack/Telegram/WhatsApp/Discord/Teams/Google Chat | API endpoints only |
| Embeddable | Yes — mount in Node.js frameworks | No |
| Network isolation | Gateway-mediated domain filtering | Sandbox-level |
| Protocols | MCP | MCP, A2A, Agent Protocol |
| Evals | Built-in YAML framework | Not included |
| Memory ownership | Fully self-hosted (Lobu memory) | LangSmith APIs (self-host option) |
| Runtime | OpenClaw | LangGraph |

**Choose DeepAgents Deploy** if you want zero-ops hosted deployment and need A2A multi-agent orchestration.

**Choose Lobu** if you need multi-tenant isolation for your users, platform-native messaging, embeddability in your app, or full infrastructure control.

## Lobu vs Claude Managed Agents

Claude Managed Agents is Anthropic's hosted agent platform.

| | Lobu | Claude Managed Agents |
|---|---|---|
| Model support | Any provider | Anthropic only |
| Self-hosted | Yes | Cloud only |
| Open source | Yes | Proprietary |
| Platform delivery | Slack, Telegram, WhatsApp, Discord, Teams, Google Chat | API |
| Embeddable | Yes | No |
| Network isolation | Domain-filtered egress | Platform-managed |
| Evals | Built-in | Not included |

**Choose Claude Managed Agents** if you're committed to Anthropic models and want a fully managed experience.

**Choose Lobu** if you need model flexibility, self-hosting, platform delivery, or the ability to embed agents in your product.

## Lobu vs building it yourself

What "we'll build it ourselves" entails:

- **Sandboxing**: per-user container orchestration with workspace persistence
- **Platform adapters**: Slack Events API, Telegram long-polling, WhatsApp webhooks, each with their own auth flows
- **Credential isolation**: proxy layer that injects secrets without exposing them to agent code
- **Network policy**: domain-filtered egress on an internal network
- **MCP proxy**: secret injection, OAuth token refresh, and routing for MCP servers
- **Scale-to-zero**: idle detection, teardown, and wake-on-message
- **Eval framework**: automated quality testing across models
- **Admin UI**: per-agent configuration, connection management, status monitoring

Lobu handles all of this out of the box. The gateway is ~40k lines of TypeScript that took months to build and harden.
