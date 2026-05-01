# @lobu/openclaw-plugin

Lobu memory plugin for [OpenClaw](https://openclaw.ai). Gives OpenClaw agents persistent, structured memory over MCP — recall relevant facts before each prompt and capture new observations after each session.

Full install guide: **[lobu.ai/connect-from/openclaw](https://lobu.ai/connect-from/openclaw/)**

## Install

```bash
openclaw plugins install @lobu/openclaw-plugin
```

Then log in and configure against your Lobu memory MCP endpoint:

```bash
lobu login
lobu memory configure --url <mcp-url> --org <org-slug>
lobu memory health --url <mcp-url> --org <org-slug>
```

Replace `<mcp-url>` with your workspace MCP URL (for example `https://lobu.ai/mcp/acme`, or `http://localhost:8787/mcp` for the local runtime). `lobu memory configure` writes a `tokenCommand` that uses `lobu token --raw`, so the plugin reuses the top-level Lobu CLI login.

## Configuration

| Field | Description |
|-------|-------------|
| `mcpUrl` | Full MCP endpoint URL. Required. |
| `webUrl` | Public web URL for the Lobu memory instance. Used to generate links shown to the agent. |
| `token` | Bearer token for MCP requests. Optional — if unset, the plugin runs interactive device login. |
| `tokenCommand` | Shell command that prints a bearer token to stdout. Alternative to `token`. |
| `headers` | Extra HTTP headers for MCP requests. |
| `autoRecall` | Search Lobu memory for relevant memories before each prompt. Default `true`. |
| `recallLimit` | Maximum recalled memory records per request. Default `6`. |
| `autoCapture` | Capture conversation observations as long-term memories after each session. Default `true`. |

See [`openclaw.plugin.json`](./openclaw.plugin.json) for the full schema.

## License

BUSL-1.1. See the repository [LICENSE](../../LICENSE).
