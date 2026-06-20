# Lobu

> Open-source infrastructure for multi-tenant AI agents: sandboxed execution, shared memory, and an SDK that pulls live company data and acts on your high-level goals.

## What Lobu does

Lobu runs goal-driven AI teammates where your team already works: Slack, Telegram, WhatsApp, Discord, Microsoft Teams, Google Chat, REST API, and MCP-capable clients. Agents connect to company systems, turn updates into shared memory, collaborate with humans, and act safely in your tools. Each user or channel gets an isolated worker with gateway-mediated credentials, scoped network egress, and approval flows for sensitive tool calls.

## Connect any agent to Lobu

The canonical MCP endpoint at [https://lobu.ai/mcp](https://lobu.ai/mcp) lets MCP-capable clients such as Claude, ChatGPT, Claude Code, and OpenClaw sign in once, list available organizations, and switch to the right workspace per conversation. See [/mcp](https://lobu.ai/mcp/) for per-client setup.

## Start here

- [Home](https://lobu.ai/): Product overview, connectors, memory, agents, platforms, and architecture
- [Getting started](https://lobu.ai/getting-started/): Install and run your first agent
- [Comparison](https://lobu.ai/getting-started/comparison/): How Lobu compares to other agent platforms
- [Serverless OpenClaw](https://lobu.ai/serverless-openclaw/): Managed runtime and usage-based billing

## Core concepts

- [Skills](https://lobu.ai/getting-started/skills/): Reusable agent capabilities via SKILL.md
- [Memory](https://lobu.ai/getting-started/memory/): Persistent typed memory for agents
- [Architecture](https://lobu.ai/guides/architecture/): Gateway, workers, proxy, and sandboxing model
- [Security](https://lobu.ai/guides/security/): Sandboxing, network policy, and credential isolation
- [Tool policy](https://lobu.ai/guides/tool-policy/): Approval model for destructive MCP tools

## Deployment

- [Lobu Cloud](https://lobu.ai/deployment/cloud/): Managed deployment with no infrastructure to run
- [Docker](https://lobu.ai/deployment/docker/): Run the Lobu app container on a single host
- [Kubernetes](https://lobu.ai/deployment/kubernetes/): Deploy Lobu with the public Helm chart
- [Getting started](https://lobu.ai/getting-started/): Boot Lobu locally with `lobu run`
- [Architecture](https://lobu.ai/guides/architecture/): Embedded gateway + worker deployment model

## Messaging platforms

- [Slack](https://lobu.ai/platforms/slack/)
- [Telegram](https://lobu.ai/platforms/telegram/)
- [WhatsApp](https://lobu.ai/platforms/whatsapp/)
- [Discord](https://lobu.ai/platforms/discord/)
- [Microsoft Teams](https://lobu.ai/platforms/teams/)
- [Google Chat](https://lobu.ai/platforms/google-chat/)
- [REST API](https://lobu.ai/platforms/rest-api/)

## Connect external agents

- [ChatGPT](https://lobu.ai/connect-from/chatgpt/)
- [Claude](https://lobu.ai/connect-from/claude/)
- [OpenClaw](https://lobu.ai/connect-from/openclaw/)

## Reference

- [API reference](https://lobu.ai/reference/api-reference/)
- [lobu.config.ts](https://lobu.ai/reference/lobu-config/)
- [SKILL.md](https://lobu.ai/reference/skill-md/)
- [Providers](https://lobu.ai/reference/providers/)
- [CLI](https://lobu.ai/reference/cli/)
- [Lobu memory CLI](https://lobu.ai/reference/lobu-memory/)

## Project

- [GitHub](https://github.com/lobu-ai/lobu)
- [Blog](https://lobu.ai/blog/)
- [Privacy](https://lobu.ai/privacy/)
- [Terms](https://lobu.ai/terms/)
