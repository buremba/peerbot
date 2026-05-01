---
title: Lobu Memory CLI Reference
description: Use the Lobu CLI to configure memory MCP endpoints, seed workspaces, run memory tools, and wire local MCP clients.
---

Lobu memory commands live under `lobu memory`. Authentication is shared with the rest of the CLI: run `lobu login` once, then memory commands reuse that session.

- Hosted: [app.lobu.ai](https://app.lobu.ai)
- Default MCP endpoint: `https://lobu.ai/mcp`

## Install And Authenticate

```bash
# Run without installing
npx @lobu/cli@latest <command>

# Or install globally
npm install -g @lobu/cli
lobu <command>

# Authenticate once for all Lobu CLI commands
lobu login
```

Use `lobu token --raw` when another local tool needs a bearer token command.

## Runtime

`lobu run` is the only local boot path. There is no separate memory runtime command.

```bash
lobu run
```

## Client Wiring

### `lobu memory init`

Configures local MCP-capable clients to use a Lobu memory MCP endpoint.

```bash
lobu memory init
lobu memory init --url http://localhost:8787/mcp
```

The wizard detects supported clients and auto-configures them when possible. Browser-managed clients fall back to manual setup instructions.

### `lobu memory configure`

Writes OpenClaw plugin config for `@lobu/openclaw-plugin`. The generated plugin config uses `lobu token --raw`, so it reuses top-level `lobu login` authentication.

```bash
openclaw plugins install @lobu/openclaw-plugin
lobu login
lobu memory configure --url https://lobu.ai/mcp --org my-org
lobu memory health --url https://lobu.ai/mcp --org my-org
```

## Health

### `lobu memory health`

Checks that the current Lobu login can authenticate to the MCP endpoint and list available tools.

```bash
lobu memory health
lobu memory health --org my-org
lobu doctor --memory-only
```

## Organization Selection

### `lobu memory org`

Stores the default memory organization for commands that need an org-scoped MCP URL.

```bash
lobu memory org current
lobu memory org set my-org
```

You can also override per-command with:

- `--org <slug>`
- `--url <mcp-url>`
- `LOBU_MEMORY_ORG`
- `LOBU_MEMORY_URL`

## Run MCP Tools Directly

### `lobu memory run`

Lists tools when called without arguments, or executes a tool when given a tool name and JSON params.

```bash
# List available tools
lobu memory run --org my-org

# Search knowledge
lobu memory run search_knowledge '{"query":"Acme"}' --org my-org

# Save new knowledge
lobu memory run save_knowledge '{"content":"Prefers weekly summaries","semantic_type":"preference","metadata":{}}' --org my-org

# Discover SDK methods
lobu memory run search '{"query":"watchers.create"}' --org my-org

# Run a TypeScript script over the typed client SDK
lobu memory run execute '{"script":"export default async (ctx, client) => client.entities.list({ entity_type: \"company\", limit: 5 })"}' --org my-org
```

## Seed Project Memory

### `lobu memory seed`

Provisions a memory workspace from `[memory.owletto]` in `lobu.toml`, `./models`, and optional `./data`.

```bash
lobu memory seed
lobu memory seed --dry-run
lobu memory seed --org my-org --url https://lobu.ai/mcp
```

## Browser Auth

### `lobu memory browser-auth`

Captures browser cookie state for connectors that rely on a real browser session.

```bash
lobu memory browser-auth --connector x --auth-profile-slug my-profile
lobu memory browser-auth --connector x --auth-profile-slug my-profile --check
```

Useful flags:

- `--chrome-profile <name>` chooses a local Chrome profile
- `--launch-cdp` launches a dedicated remote-debugging Chrome profile
- `--dedicated-profile <name>` names the dedicated profile

## Skills

The old standalone Owletto starter skills are folded into the bundled Lobu starter skill:

```bash
# Enable the Lobu skill from the agent settings UI
```

Local skills are still discovered from `skills/<id>/SKILL.md` and `agents/<agent-id>/skills/<id>/SKILL.md`.

## Related

- Lobu CLI: [CLI Reference](/reference/cli/)
- Memory docs: [Memory](/getting-started/memory/)
