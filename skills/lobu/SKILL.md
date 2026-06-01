---
name: lobu
description: Work with an existing Lobu project (run, validate, evaluate, connect) and with Lobu memory from your coding agent. Covers MCP client setup, OpenClaw memory plugin, knowledge search/save, watchers, and browser-authenticated connectors. To scaffold a NEW project run "npx @lobu/cli@latest init"; the AGENTS.md it generates is the config-API guide.
---

# Lobu

Use this skill when working with an existing Lobu project — running, validating, evaluating, or connecting one — or with Lobu memory from a coding agent: MCP client setup, OpenClaw memory plugin configuration, knowledge search/save workflows, watchers, and browser-authenticated connectors.

To scaffold a NEW project, run `npx @lobu/cli@latest init`. The `AGENTS.md` it writes into the project is the source of truth for the config API (the `define*` helpers, connectors, auth, watchers, memory) — this skill does not duplicate it. For an existing project, jump to "Core Model" + the relevant reference section below.

## Core Model

- **Lobu** is the agent framework, runtime, deployment layer, and memory surface.
- Keep framework configuration in `lobu.config.ts` (TypeScript, `defineConfig` from `@lobu/cli/config`).
- Keep agent identity and behavior in `IDENTITY.md`, `SOUL.md`, and `USER.md`.
- Keep reusable capability bundles in `skills/<name>/SKILL.md` or `agents/<agent>/skills/<name>/SKILL.md`.
- Use `lobu login` for CLI authentication. Do not use a separate memory login command.
- Use `lobu memory ...` for memory operations, MCP client wiring, seeding, direct tool calls, and browser-auth capture.

## Project Checklist

1. Read `lobu.config.ts` first.
2. Read the active agent files under `agents/<id>/`.
3. Check local skills under `skills/` and `agents/<id>/skills/`.
4. Use `lobu validate` after config changes.
5. When prompt or behavior changes, run evals via promptfoo (see `examples/personal-finance/evals/promptfooconfig.yaml`). The in-house `lobu eval` command has been removed.

## Common Commands

```bash
npx @lobu/cli@latest init my-agent
npx @lobu/cli@latest run
npx @lobu/cli@latest validate
npx @lobu/cli@latest login
```

## Authentication

- Interactive (human at a terminal): `lobu login` runs the device-code flow with a browser approval.
- CI / your own automation: `LOBU_API_TOKEN`, or `lobu login --token <pat>`.
- Local `lobu run`: the CLI mints credentials automatically over loopback — no prompt.
- Headless, on a *user's* behalf: `lobu login --email <address>`. The server emails the user a one-click approval link and the CLI polls until they approve, then stores the scoped credential — no TTY, no pre-minted token. This is the auth.md "user_claimed" flow.

An external agent not using this CLI can drive the same flow over HTTP: read `<origin>/auth.md` (linked from the `agent_auth` block in `<origin>/.well-known/oauth-authorization-server`) for the endpoints. Today only the email user_claimed flow exists (no zero-touch ID-JAG). Never fabricate a token.

<!-- lobu-memory-guidance:start -->
## Memory Defaults

Your long-term memory is powered by Lobu. Do NOT use local files (memory/, MEMORY.md) for memory.
- Lobu automatically recalls relevant memories when you receive a message.
- To save something, call save_memory with the content and an appropriate semantic_type.
- To search, call search_memory. Results include view_url links to the web interface.
- NEVER construct Lobu URLs yourself. When the user asks for a link, call search_memory to get the correct view_url.
- When the user says "remember this", save it to Lobu immediately.
- When a message changes a fact you already stored (an updated preference, status, count, location, or plan), first search_memory for the prior memory to get its id, then save_memory the new value with supersedes_event_id set to that id. This replaces the stale value so future recalls return the current one; the old value stays in history but is hidden from normal search.
<!-- lobu-memory-guidance:end -->

## Lobu Memory

Configure project-scoped memory in `lobu.config.ts` by setting the org on `defineConfig` and declaring the schema with the `define*` helpers:

```ts
import { defineConfig, defineEntityType } from "@lobu/cli/config";

const ticket = defineEntityType({
  key: "ticket",
  name: "Ticket",
  properties: {
    subject: {
      type: "string",
      "x-table-label": "Subject",
      "x-table-column": true,
    },
  },
});

export default defineConfig({
  org: "my-org",
  orgName: "My workspace",
  agents: [/* ... */],
  entities: [ticket],
});
```

Seed data records still live as YAML under `./data`. Then seed or operate the memory workspace with:

```bash
lobu login
lobu memory org set <org-slug>
lobu memory health --org <org-slug>
lobu memory seed --org <org-slug>
lobu memory run search_memory '{"query":"Acme"}' --org <org-slug>
```

Use `search_memory` first when the user asks about a specific entity or workspace memory. Use `save_memory` to persist durable memory. To update existing knowledge, search first, then save with `supersedes_event_id` so the old row is tombstoned rather than deleted.

## MCP Client Setup

Use the actual MCP URL for the user's runtime. Never hardcode a hosted URL unless the user explicitly asks for that instance.

Common setup commands:

```bash
# Claude Code
claude mcp add --transport http lobu <mcp-url>

# Codex
codex mcp add lobu --url <mcp-url>

# Gemini CLI
gemini mcp add --transport http lobu <mcp-url>

# Interactive client wiring wizard
lobu memory init --url <mcp-url>
```

For ChatGPT, Claude Desktop, Cursor, and other browser-managed clients, paste the MCP URL into the client's MCP/connector settings and complete OAuth in the browser.

## OpenClaw Memory Plugin

For OpenClaw, install the plugin and let the Lobu CLI write plugin config:

```bash
openclaw plugins install @lobu/openclaw-plugin
lobu login
lobu memory configure --url <mcp-url> --org <org-slug>
lobu memory health --url <mcp-url> --org <org-slug>
```

`lobu memory configure` writes a token command that uses `lobu token --raw`, so OpenClaw reuses the top-level Lobu login.

## Browser-Authenticated Connectors

For connectors that need a real browser session, `browser-auth` launches a dedicated Chrome with remote debugging, stores its CDP endpoint on the auth profile, and the connector attaches over CDP at sync time (harvesting cookies live):

```bash
lobu memory browser-auth --connector <key> --auth-profile-slug <slug>
lobu memory browser-auth --connector <key> --auth-profile-slug <slug> --check
```

Use `--dedicated-profile` only when you want a non-default dedicated Chrome profile directory; use `--remote-debug-port` to customize the CDP port (default `9222`).

## Tool Discipline

- Search before create to avoid duplicate entities.
- Never fabricate Lobu memory links. If a tool returns a view URL, use that URL.
- Use canonical MCP tool names only.
- Prefer read-only operations before mutations when validating connectivity.
- `events` is append-only: never delete rows directly; use tombstone/supersede flows.
