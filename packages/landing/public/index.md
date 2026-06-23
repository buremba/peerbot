# Lobu

> Open-source infrastructure for AI teammates that watch, remember, and act. Connectors and webhooks build a live org knowledge graph in an append-only log; agents look it up and branch into isolated sandboxes to do work.

## What Lobu does

Lobu runs goal-driven AI teammates where your team already works: Slack, Telegram, WhatsApp, Discord, Microsoft Teams, Google Chat, REST API, and MCP-capable clients. Connectors poll and webhooks push into one durable event log; watchers and chat agents share typed entity memory instead of re-fetching state through MCP every turn. Each user or channel gets an isolated worker with gateway-mediated credentials, guardrails, scoped network egress, and approval flows for sensitive tool calls.

## Connect any agent to Lobu

The canonical MCP endpoint at [https://lobu.ai/mcp](https://lobu.ai/mcp) lets MCP-capable clients such as Claude, ChatGPT, Claude Code, and OpenClaw sign in once and read/write the same org graph your Slack agents use. MCP is for recall and write; ingestion still flows through connectors and webhooks. See [/mcp](https://lobu.ai/mcp/) and [Connect from Claude](https://lobu.ai/connect-from/claude/).

## Start here

- [Home](https://lobu.ai/): Product overview, memory pipeline, skills, platforms
- [Getting started](https://lobu.ai/getting-started/): Install and run your first agent
- [Comparison](https://lobu.ai/getting-started/comparison/): Lobu vs OpenClaw, Claude Tag, and others
- [Serverless OpenClaw](https://lobu.ai/serverless-openclaw/): Managed runtime and usage-based billing

## Core concepts

- [Skills](https://lobu.ai/getting-started/skills/): Reusable agent capabilities via SKILL.md
- [Memory](https://lobu.ai/getting-started/memory/): Connectors, entities, watchers, append-only org memory
- [Architecture](https://lobu.ai/guides/architecture/): Gateway, workers, proxy, and sandboxing model
- [Security](https://lobu.ai/guides/security/): Sandboxing, network policy, and credential isolation

## Connect external agents

- [Claude](https://lobu.ai/connect-from/claude/)
- [ChatGPT](https://lobu.ai/connect-from/chatgpt/)
- [OpenClaw](https://lobu.ai/connect-from/openclaw/)

## Reference

- [CLI](https://lobu.ai/reference/cli/)
- [lobu.config.ts](https://lobu.ai/reference/lobu-config/)
- [REST API reference](https://lobu.ai/reference/api-reference/)

## Optional

- [GitHub](https://github.com/lobu-ai/lobu)
- [Privacy](https://lobu.ai/privacy/)
- [Terms](https://lobu.ai/terms/)