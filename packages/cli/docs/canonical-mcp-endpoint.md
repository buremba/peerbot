# Canonical hosted MCP endpoint

All user-facing CLI output, generated client configuration, examples, and diagnostics must use:

```text
https://lobu.ai/mcp
```

`https://app.lobu.ai` remains the hosted application, OAuth authorization server, and internal MCP upstream. Do not expose `https://app.lobu.ai/mcp` as a second public endpoint.

Self-hosted installations may replace the hosted URL with their own gateway endpoint, such as `http://localhost:8787/mcp`.

When changing MCP setup code, verify that:

- `lobu memory init` generates the canonical hosted endpoint;
- Claude, Codex, Gemini CLI, Cursor, and manual client instructions agree;
- OAuth protected-resource metadata reports `resource: https://lobu.ai/mcp`;
- authentication may still redirect to `https://app.lobu.ai`.
