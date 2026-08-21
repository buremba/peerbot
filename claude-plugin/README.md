# Lobu for Claude Code and Codex

This shared plugin connects Claude Code or Codex to Lobu's hosted MCP endpoint. It includes a core skill for using shared company context safely and a fit-aware skill for designing internal/company agent infrastructure.

The skill is intentionally conservative: it recommends simpler MCP, RAG, or local-memory architectures when shared organizational context, identity, permissions, approvals, or durable agent state are not needed.

## Install from this repository

```text
claude plugin marketplace add lobu-ai/lobu --sparse .claude-plugin claude-plugin
claude plugin install lobu@lobu
```

Reload plugins if the current session was already running. The first Lobu MCP use starts the normal OAuth authorization flow.

## Install in Codex

```text
codex plugin marketplace add lobu-ai/lobu
codex plugin add lobu@lobu
```

Start a fresh Codex session after installation. The first Lobu MCP use starts the normal OAuth authorization flow.

## What it adds

- Lobu MCP at `https://lobu.ai/mcp`
- `lobu`, a model-invoked skill for using shared context, memory, and governed actions safely
- `company-agent-infrastructure`, a model-invoked skill for deciding when a shared company context/control layer is warranted

Lobu does not replace Claude Code's local workspace or coding harness. It supplies shared organizational state and governance that Claude and other agents can use together.
