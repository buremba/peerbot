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

Wires an existing project's agents to a memory MCP endpoint and configures local MCP-capable clients.

```bash
lobu memory init
lobu memory init --url http://localhost:8787/mcp
lobu memory init --agent support-bot --skip-auth
```

| Flag | Description |
|------|-------------|
| `--url <url>` | MCP server URL (skips the picker) |
| `--agent <id>` | Configure a specific agent only |
| `--skip-auth` | Skip the authentication step |

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

# Search memory
lobu memory run search_memory '{"query":"Acme"}' --org my-org

# Save new memory
lobu memory run save_memory '{"content":"Prefers weekly summaries","semantic_type":"preference","metadata":{}}' --org my-org

# Discover SDK methods
lobu memory run search_sdk '{"query":"watchers.create"}' --org my-org

# Query with a read-only TypeScript script over the typed client SDK
lobu memory run query_sdk '{"script":"export default async (ctx, client) => client.entities.list({ entity_type: \"company\", limit: 5 })"}' --org my-org

# Preview a mutating script without applying write/external SDK calls
lobu memory run run_sdk '{"dry_run":true,"script":"export default async (ctx, client) => client.entities.create({ type: \"company\", name: \"Acme\" })"}' --org my-org
```

### `lobu memory exec <script>`

Sugar for `lobu memory run run_sdk '{"script": ...}'` — runs the given TypeScript ClientSDK script source via the memory MCP without hand-quoting the JSON wrapper. `<script>` is the script text itself, so pipe a file in with `$(cat ...)`.

```bash
lobu memory exec 'export default async (ctx, client) => client.entities.list({ entity_type: "company", limit: 5 })' --org my-org
lobu memory exec "$(cat script.ts)" --url https://lobu.ai/mcp --org my-org
```

Accepts the same `--url`, `--org`, and `-c/--context` flags as `lobu memory run`.

## Seed Project Memory

### `lobu memory seed`

Provisions a memory workspace from `lobu.config.ts`. The schema (entity types, relationship types, watchers) and the org come from `defineConfig`; optional seed data records come from YAML files under `./data`.

Declare the schema in `lobu.config.ts`:

```ts
import {
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
} from "@lobu/cli/config";

const account = defineEntityType({ key: "account", name: "Account" });
const owns = defineRelationshipType({ key: "owns", name: "Owns" });
const digest = defineWatcher({
  agent: "sales",
  slug: "account-digest",
  name: "Account digest",
  schedule: "0 9 * * 1",
  prompt: "Summarize account changes.",
  extractionSchema: { type: "object", properties: {} },
});

export default defineConfig({
  org: "my-org",
  agents: [/* ... */],
  entities: [account],
  relationships: [owns],
  watchers: [digest],
});
```

```bash
lobu memory seed
lobu memory seed --dry-run
lobu memory seed --org my-org --url https://lobu.ai/mcp
```

## Browser Auth

### `lobu memory browser-auth`

Sets up browser auth for connectors that rely on a real browser session. The CLI launches a dedicated Chrome with remote debugging enabled and stores its CDP endpoint on the auth profile; the connector attaches over CDP at sync time and harvests fresh cookies live from that session. `--connector` is required.

```bash
# Launch a debug Chrome and store the CDP endpoint on the auth profile.
# A new Chrome window opens; sign into the site once and leave it open.
lobu memory browser-auth --connector x --auth-profile-slug my-profile

# Verify the CDP endpoint on a profile is still reachable.
lobu memory browser-auth --connector x --auth-profile-slug my-profile --check
```

| Flag | Description |
|------|-------------|
| `--connector <key>` | **Required.** Connector key (e.g. `x`) |
| `--domains <list>` | Comma-separated cookie-domain override |
| `--auth-profile-slug <slug>` | Browser auth profile slug to store the CDP endpoint on |
| `--remote-debug-port <port>` | Remote debugging port for the dedicated Chrome (default `9222`) |
| `--dedicated-profile <name>` | Dedicated Chrome profile dir name |
| `--check` | Check whether the CDP endpoint stored on a browser auth profile is reachable |

## Skills

The old standalone Lobu starter skills are folded into a single bundled `lobu` skill. Enable it from the agent settings UI, or add it to a project:

```bash
npx skills add lobu-ai/lobu --skill lobu
```

Local skills are referenced explicitly from `lobu.config.ts` via `skillFromFile`. There is no directory auto-discovery.

## Related

- Lobu CLI: [CLI Reference](/reference/cli/)
- Memory docs: [Memory](/getting-started/memory/)
