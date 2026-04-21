# Client Install Paths

Install the Owletto starter skill first:

```bash
npx owletto@latest skills add owletto
```

Then use the workspace or org-scoped MCP URL provided by the product surface. Do not replace it with a hardcoded hosted URL unless the user asked for that exact instance.

## Claude Code

Register the remote HTTP MCP server (handles OAuth automatically):

```bash
claude mcp add --transport http owletto <mcp-url>
```

## Codex

Register the remote HTTP MCP server:

```bash
codex mcp add owletto --url <mcp-url>
```

If the server requires OAuth and Codex cannot complete browser login, use the CLI device flow from [cli-fallback.md](cli-fallback.md).

## ChatGPT

Open `Settings -> Integrations -> Model Context Protocol -> Add Server`, name it `Owletto`, and paste the MCP URL.

## Claude Desktop

Open `Settings -> Connectors -> Add Custom Connector`, paste the MCP URL, then enable the connector.

## Gemini CLI

Register the remote HTTP MCP server:

```bash
gemini mcp add --transport http owletto <mcp-url>
```

## Cursor

Open the generated install link for Cursor so it receives the exact runtime MCP URL.

## OpenClaw

Use the OpenClaw setup flow from `owletto-openclaw`:

```bash
openclaw plugins install owletto-openclaw-plugin
owletto login <mcp-url>
owletto configure
owletto health
```
