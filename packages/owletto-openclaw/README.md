# @lobu/owletto-openclaw

Lobu memory plugin for [OpenClaw](https://openclaw.ai). Gives OpenClaw agents persistent, structured memory over MCP — recall relevant facts before each prompt and capture new observations after each session.

Full install guide: **[lobu.ai/connect-from/openclaw](https://lobu.ai/connect-from/openclaw/)**

## Install

```bash
openclaw plugins install owletto-openclaw-plugin
```

Then log in and configure against your Lobu memory MCP endpoint:

```bash
owletto login <mcp-url>
owletto configure
owletto health
```

Replace `<mcp-url>` with your workspace MCP URL (for example `https://owletto.com/mcp/acme`, or `http://localhost:8787/mcp` for the local runtime).

For headless environments without browser access:

```bash
owletto login --device <mcp-url>
```

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
