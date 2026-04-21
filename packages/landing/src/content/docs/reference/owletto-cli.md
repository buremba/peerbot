---
title: Lobu memory CLI Reference
description: What the owletto CLI does, how it authenticates, and how to use it to run Lobu memory tools directly.
---

The `owletto` CLI starts local Lobu memory servers, connects agent clients, and runs memory tools directly.

- Hosted: [app.lobu.ai](https://app.lobu.ai)

## Install And Run

```bash
# Run without installing
npx owletto@latest <command>

# Or install globally
npm install -g owletto
owletto <command>
```

The published package name is `owletto`.

## Architecture Overview

Lobu memory is a layered system that separates raw capture from structured knowledge:

```
external source
  -> connectors (sync/execute)
  -> normalized events (append-only log)
  -> watcher analysis windows
  -> entities / relationships / classifications
  -> agent recall (search_knowledge, read_knowledge)
```

**Key concepts:**

- **Events** are append-only and immutable. They provide replayability, provenance, and auditability.
- **Watchers** analyze event windows and extract structured facts linked to source evidence.
- **Entities** form a hierarchical knowledge graph that turns raw capture into durable domain knowledge.
- **Actions** are first-class events too, with approval workflows for destructive operations.

## Connector SDK

Lobu memory's data integration layer. Each connector declares:

- `ConnectorDefinition` — auth, feeds, actions, schemas
- `ConnectorRuntime` — implements `sync()` and optional `execute()`

Docs: [Connector SDK](https://github.com/lobu-ai/owletto/blob/main/connectors/README.md)

## Core Commands

### `owletto start`

Starts a local Lobu memory runtime.

```bash
npx owletto@latest start
npx owletto@latest start --port 8787
```

Default behavior:

- listens on `http://localhost:8787`
- uses embedded Postgres (`PGlite`) by default
- stores local data in `~/.owletto/data/` for packaged installs
- uses `./data/` when running from an `owletto` repo checkout

If `DATABASE_URL` is set, the CLI starts the server against external Postgres instead.

### `owletto init`

Configures local agent clients to use a Lobu memory MCP endpoint.

```bash
npx owletto@latest init
npx owletto@latest init --url http://localhost:8787/mcp
```

Detects supported clients and auto-configures them. Falls back to manual steps when needed.

## Authentication

### `owletto login`

Authenticates the CLI against a Lobu memory MCP server using OAuth.

```bash
npx owletto@latest login https://app.lobu.ai/mcp
```

By default, the CLI opens a browser and completes an authorization-code flow with a local callback server.

Useful flags:

- `--device` uses device-code login for headless environments or browserless agents
- `--noOpen` prints the login URL instead of opening a browser
- `--scope` overrides the requested OAuth scopes

Example for a headless box:

```bash
npx owletto@latest login https://app.lobu.ai/mcp --device
```

### `owletto token`

Prints a usable access token from the saved session.

```bash
npx owletto@latest token
npx owletto@latest token --raw
```

This is mainly useful for integrations or plugin setups that need a token command.

### `owletto health`

Checks that the saved session is valid and that the CLI can reach the MCP endpoint.

```bash
npx owletto@latest health
```

## Organization Selection

Lobu memory sessions are organization-aware. After login, set the default org if needed:

```bash
npx owletto@latest org current
npx owletto@latest org set my-org
```

You can also override organization and server selection per command:

- `--org <slug>`
- `--url <mcp-url>`
- `OWLETTO_ORG`
- `OWLETTO_URL`

## Run MCP Tools Directly

### `owletto run`

Lists tools when called without arguments, or executes a tool when given a tool name and JSON params.

```bash
# List available tools
npx owletto@latest run

# Search memory
npx owletto@latest run search_knowledge '{"query":"Acme"}'

# Read saved content
npx owletto@latest run read_knowledge '{"query":"customer preferences"}'

# Save new knowledge
npx owletto@latest run save_knowledge '{"content":"Prefers weekly summaries","semantic_type":"preference","metadata":{}}'
```

This is the most direct way to inspect or test Lobu memory behavior outside an agent runtime.

### Which MCP tools are available?

The exact tool list depends on the endpoint and your session scope. Run `owletto run` with no arguments to see what's available.

**Core memory:** `search_knowledge`, `read_knowledge`, `save_knowledge`

**Watchers:** `list_watchers`, `get_watcher`

**Organization:** `list_organizations`, `switch_organization` (unscoped endpoint only)

**Admin / workspace** (admin sessions only): `manage_entity`, `manage_entity_schema`, `manage_connections`, `manage_feeds`, `manage_auth_profiles`, `manage_operations`, `manage_watchers`, `manage_classifiers`, `query_sql`

## Other Useful Commands

### `owletto doctor`

Checks local prerequisites such as Node, Docker, and current server reachability.

```bash
npx owletto@latest doctor
```

### `owletto browser-auth`

Captures browser-based auth/cookie state for connectors that rely on a real browser session.

This is mainly for connector setup, not day-to-day memory usage.

### `owletto configure`

Writes OpenClaw plugin config for `@lobu/owletto-openclaw` using an `owletto token` command.

## Repo-Local Development

When working inside the `owletto` repository itself, you can run the TypeScript entrypoint directly:

```bash
pnpm -C packages/cli exec tsx src/bin.ts start
pnpm -C packages/cli exec tsx src/bin.ts init
pnpm -C packages/cli exec tsx src/bin.ts run search_knowledge '{"query":"spotify"}'
```

## How This Fits With Lobu

Use the Lobu CLI to scaffold and run Lobu projects. Use the `owletto` CLI when you need to stand up or inspect the Lobu memory system behind them.

- Lobu CLI: [CLI Reference](/reference/cli/)
- Lobu memory docs: [Memory](/getting-started/memory/)
