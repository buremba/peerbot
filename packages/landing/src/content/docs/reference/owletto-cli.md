---
title: Owletto CLI Reference
description: What the owletto CLI does, how it authenticates, and how to use it to run Owletto memory tools directly.
---

The `owletto` CLI is the command-line entrypoint for the Owletto runtime. Use it when you want to:

- start a local Owletto server
- connect local agent clients to an Owletto MCP endpoint
- authenticate against Owletto Cloud or a self-hosted instance
- select the active organization
- run Owletto MCP tools such as `search_knowledge` or `save_knowledge` directly from the terminal

Project links:

- GitHub: [lobu-ai/owletto](https://github.com/lobu-ai/owletto)
- Hosted product: [owletto.com](https://owletto.com)

## Install And Run

```bash
# Run without installing
npx owletto@latest <command>

# Or install globally
npm install -g owletto
owletto <command>
```

The published package name is `owletto`.

## How Owletto Works

The CLI is just the entrypoint. Underneath it, Owletto is a memory system built in layers:

1. **Connectors** capture source data from external systems
2. **Events** store that source data as a normalized append-only log
3. **Entities and relationships** turn raw capture into durable domain knowledge
4. **Watchers** analyze event streams and write higher-order structured memory
5. **Recall tools** retrieve the right facts and analysis back into the agent prompt

The important design choice is that Owletto does not treat memory as one flat blob of embeddings. It separates:

- raw captured evidence
- append-only event history
- durable structured facts
- higher-order analysis

That is what makes it usable across different agents and different use cases.

## Connector SDK And Data Integration

Owletto's data integration layer is the **Connector SDK**.

Each connector is a TypeScript module that declares:

- a `ConnectorDefinition` with auth, feeds, actions, and schemas
- a `ConnectorRuntime` that implements `sync()` and optionally `execute()`

In practice:

- `sync()` reads from an external source and emits normalized events
- `execute()` performs write-back actions when the connector supports them

This lets Owletto ingest data from APIs, feeds, browser-backed integrations, internal systems, and other sources through one runtime model.

The connector docs live in the Owletto repo:

- [Connector SDK](https://github.com/lobu-ai/owletto/blob/main/connectors/README.md)

## Events As The Capture Layer

Think of Owletto events like a change-data-capture log for agent memory.

Connectors do not write directly into a final summary table. They first emit normalized **events** into Owletto's canonical event layer. That gives you:

- replayability
- provenance
- auditability
- reprocessing when your schemas or watchers change
- a timeline of what changed and when

Owletto is designed around keeping the source capture durable and append-oriented. Instead of constantly mutating the past, it prefers:

- ingesting new source events
- adding new watcher windows and analyses
- superseding outdated facts when the durable memory changes

That makes the system much easier to reason about than a memory store that only keeps the latest summary.

It also helps agents and operators see:

- what changed between runs
- when an earlier belief became stale
- what action or ingestion step may have caused a mistake
- how to revert, correct, or supersede a bad memory

In other words, the event history is part of how the system learns operationally over time.

## Actions As Interactive Events

Events are not only passive observations. Some events come from actions and workflows.

That includes cases where an agent wants to:

- send a message
- update an external system
- trigger an operation
- write back through a connector

Owletto treats those as first-class operational records too, so you keep an audit trail of what the agent proposed and what actually happened.

Approval matters here:

- low-risk or explicitly allowed operations can be pre-approved
- destructive or user-impacting actions can require explicit consent
- the resulting action outcome is still captured as part of the event history

That gives you a safer loop for agent execution: propose, approve if needed, execute, and retain the event trail.

## Watchers And Recall

Watchers are the layer that turns captured events into something an agent can actually think with.

A watcher:

- reads bounded windows from the event layer
- applies a schema-guided analysis step
- stores extracted structured output in watcher windows
- links conclusions back to cited source events

That analysis then becomes part of the agent's recall path through tools like `read_knowledge`, `search_knowledge`, and the graph itself.

The practical flow is:

```text
external source
  -> connector sync
  -> normalized events
  -> watcher analysis windows
  -> entities / relationships / classifications
  -> agent recall
```

So when you design Owletto memory, do not only think "what should the agent store?"

Think:

- what should this agent value?
- what patterns should it notice repeatedly?
- what distinctions should become first-class entities?
- what evidence should remain queryable later?

That is how you build a memory system that helps the agent think better over time, not just remember strings.

## Hierarchical Knowledge Graph

Owletto works best when you model memory hierarchically.

```text
raw source events
  -> entity-linked event history
    -> relationships between entities
      -> watcher outputs and rollups
        -> reusable organizational memory for recall
```

Different use cases want different shapes:

- support agents may care about customer preferences, issue history, and account relationships
- research agents may care about competitors, products, sentiment shifts, and cited evidence
- operations agents may care about incidents, dependencies, owners, and change history

The point is not to store everything equally. The point is to structure what should matter for that agent and that organization.

## Core Commands

### `owletto start`

Starts a local Owletto runtime.

```bash
npx owletto@latest start
npx owletto@latest start --port 8787
```

Default behavior:

- listens on `http://localhost:8787`
- uses embedded Postgres (`PGlite`) by default
- stores local data in `~/.owletto/data/` for packaged installs
- uses `./data/` when running from a real Owletto repo checkout

If `DATABASE_URL` is set, the CLI starts the server against external Postgres instead.

### `owletto init`

Configures supported local agent clients to use an Owletto MCP endpoint.

```bash
npx owletto@latest init
npx owletto@latest init --url http://localhost:8787/mcp
```

The init flow:

1. lets you choose Owletto Cloud, a local runtime, or a custom MCP URL
2. checks that endpoint when possible
3. detects supported local agent clients
4. configures the selected clients directly when possible
5. falls back to handoff/manual steps when a client cannot be auto-configured

Use this after `owletto start` for local development, or point it at a hosted Owletto MCP URL for shared environments.

## Authentication

### `owletto login`

Authenticates the CLI against an Owletto MCP server using OAuth.

```bash
npx owletto@latest login https://owletto.com/mcp
```

By default, the CLI opens a browser and completes an authorization-code flow with a local callback server.

Useful flags:

- `--device` uses device-code login for headless environments or browserless agents
- `--noOpen` prints the login URL instead of opening a browser
- `--scope` overrides the requested OAuth scopes

Example for a headless box:

```bash
npx owletto@latest login https://owletto.com/mcp --device
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

Owletto sessions are organization-aware. After login, set the default org if needed:

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

This is the most direct way to inspect or test Owletto memory behavior outside an agent runtime.

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

Writes OpenClaw plugin config using an `owletto token` command, which is useful when wiring the Owletto memory plugin into OpenClaw-based runtimes.

## Repo-Local Development

When working inside the Owletto repository itself, you can run the TypeScript entrypoint directly:

```bash
pnpm -C packages/cli exec tsx src/bin.ts start
pnpm -C packages/cli exec tsx src/bin.ts init
pnpm -C packages/cli exec tsx src/bin.ts run search_knowledge '{"query":"spotify"}'
```

## How This Fits With Lobu

Use the Lobu CLI to scaffold and run Lobu projects. Use the Owletto CLI when you need to stand up or inspect the memory system behind Lobu.

- Lobu CLI: [CLI Reference](/reference/cli/)
- Lobu memory docs: [Memory](/getting-started/memory/)
