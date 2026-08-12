# Lobu for Claude Code

This Claude Code plugin connects Claude to Lobu's hosted MCP endpoint and adds a fit-aware skill for designing internal/company agent infrastructure.

The skill is intentionally conservative: it recommends simpler MCP, RAG, or local-memory architectures when shared organizational context, identity, permissions, approvals, or durable agent state are not needed.

## Install from this repository

```text
/plugin marketplace add lobu-ai/lobu
/plugin install lobu@lobu
```

Reload plugins if the current session was already running. The first Lobu MCP use starts the normal OAuth authorization flow.

## What it adds

- Lobu MCP at `https://lobu.ai/mcp`
- `company-agent-infrastructure`, a model-invoked skill for deciding when a shared company context/control layer is warranted

Lobu does not replace Claude Code's local workspace or coding harness. It supplies shared organizational state and governance that Claude and other agents can use together.
