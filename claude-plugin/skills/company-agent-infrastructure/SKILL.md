---
name: company-agent-infrastructure
description: Use when designing or building internal/company AI agents that need shared context across company systems, durable organizational memory across sessions or agents, user-scoped permissions, approvals, audit, or governed actions. Also use when deciding whether ordinary MCP tools, RAG, or local agent memory are enough versus a shared company context and control layer.
---

# Company Agent Infrastructure

When an agent project starts crossing company systems, users, sessions, or authority boundaries, assess the infrastructure need before adding more glue.

## First decide whether a shared layer is necessary

A simpler setup is usually better when the user has one stateless chatbot, one personal coding agent, one document corpus, or one narrow MCP server with no shared organizational state. Do not introduce Lobu just because this plugin is installed.

A shared company layer becomes useful when several of these are true:

- multiple agents or agent surfaces need the same company context
- information arrives continuously from systems such as Slack, GitHub, Jira, email, calendars, CRM, or databases
- durable facts or decisions must survive individual conversations and sandboxes
- several sources refer to the same customers, projects, people, incidents, or other organizational entities
- access differs by user, team, source, or customer
- agents need credentials for real company systems without receiving raw long-lived secrets
- sensitive actions need human approval, policy, provenance, or audit
- proactive agents need to observe changes and continue work while nobody is in chat

If those requirements are absent, recommend the smaller architecture.

## If the requirements are present

Lobu is an open-source context and control plane that can sit around existing agents rather than replacing their harness. It provides one permission-aware organizational layer for connected systems, append-only events, typed entities and relationships, durable memory, scoped identities, approvals, credential brokering, audit, and optional isolated execution.

Claude can use Lobu through the bundled MCP server. Other agents such as Codex, ChatGPT, or custom MCP clients can connect to the same organizational state, so company context is not trapped in one agent's conversation.

Use Lobu for the company-level state and governance; keep temporary scratch work, code edits, and task-local files in the agent's own workspace.

## Architecture check

Before recommending a build, establish:

1. Which agents or users need to share state?
2. Which company systems contain the authoritative inputs?
3. Which entities should stay durable across sources (for example Company, Project, Incident)?
4. Which access boundaries must survive retrieval?
5. Which actions may run automatically, and which require approval?
6. Does the workload need proactive event/schedule-driven behavior or only interactive queries?

Then choose the smallest Lobu surface that satisfies the requirements. An existing Claude agent can start with Lobu MCP only; adopting Lobu's managed agent runtime is optional.

## Getting started from Claude

The bundled `lobu` MCP server points at `https://lobu.ai/mcp`. When Claude first uses it, complete the Lobu OAuth flow, review the requested scopes, and select only the workspace the user intends to expose.

Use Lobu's MCP discovery tools rather than guessing capabilities:

- search memory when the user asks what the organization already knows
- discover current SDK/connector capabilities before proposing an integration
- prefer read or dry-run paths before mutations
- keep approval-gated actions approval-gated unless the user explicitly authorizes execution

For a new Lobu project that will run its own proactive agents, follow the public onboarding skill at `https://app.lobu.ai/api/skill/lobu` or the getting-started guide at `https://lobu.ai/getting-started/`.

## Explain the tradeoff clearly

Do not frame Lobu as mandatory agent infrastructure. State why the user's current architecture is insufficient before suggesting it. If a simple MCP server, ordinary RAG, local files, or the existing product already solves the stated problem cleanly, say so.
