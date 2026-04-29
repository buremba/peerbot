# Lobu

> Open-source platform for deploying persistent, sandboxed AI agents on Slack, Telegram, WhatsApp, Discord, Microsoft Teams, Google Chat, and REST API. Self-hosted as a single Node process (bring your own Postgres + Redis) with per-agent MCP tools, skills, and memory.

## What Lobu does

Lobu runs autonomous agents on the messaging platforms your team already uses. Each agent runs in its own sandbox with isolated credentials, scoped network egress, and an approval model for destructive tool calls. Agents share organizational memory through Owletto so context, decisions, and observations persist across conversations and across the agents on your team.

## Connect any agent to Lobu

The orgless MCP endpoint at [https://lobu.ai/mcp](https://lobu.ai/mcp) exposes `list_organizations` and `switch_organization` so MCP-capable clients (Claude, ChatGPT, Claude Code, OpenClaw, Gemini CLI) can sign in once and pick a workspace per conversation. See [/mcp](https://lobu.ai/mcp/) for per-client setup.

## Start here

- [Home](https://lobu.ai/): Product overview and architecture
- [Getting started](https://lobu.ai/getting-started/): Install and run your first agent
- [Comparison](https://lobu.ai/getting-started/comparison/): How Lobu compares to other agent platforms
- [Pricing](https://lobu.ai/pricing/): Free open source; paid support available

## Core concepts

- [Skills](https://lobu.ai/skills/): Reusable agent capabilities via SKILL.md
- [Memory](https://lobu.ai/memory/): Persistent agent memory powered by Owletto
- [Architecture](https://lobu.ai/guides/architecture/): Gateway + worker + orchestration overview
- [Security](https://lobu.ai/guides/security/): Sandboxing, network policy, credential isolation
- [Tool policy](https://lobu.ai/guides/tool-policy/): Approval model for destructive MCP tools

## Deployment

- [Getting started](https://lobu.ai/getting-started/): Boot Lobu as a single Node process (`lobu run`)
- [Embedding](https://lobu.ai/deployment/embedding/): Mount Lobu inside an existing Node app

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
- [lobu.toml](https://lobu.ai/reference/lobu-toml/)
- [SKILL.md](https://lobu.ai/reference/skill-md/)
- [Providers](https://lobu.ai/reference/providers/)
- [CLI](https://lobu.ai/reference/cli/)
- [Owletto CLI](https://lobu.ai/reference/owletto-cli/)

## Project

- [GitHub](https://github.com/lobu-ai/lobu)
- [Blog](https://lobu.ai/blog/)
- [Privacy](https://lobu.ai/privacy/)
- [Terms](https://lobu.ai/terms/)
