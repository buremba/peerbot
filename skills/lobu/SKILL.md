---
name: lobu
description: Build, run, and maintain Lobu agent projects, including lobu.toml, prompt files, local skills, evals, providers, connections, and Lobu memory workflows.
---

# Lobu

Use this skill when the user is working on a Lobu project or wants to scaffold, run, validate, evaluate, or connect one. Also use it when the user wants persistent Lobu memory, MCP client setup, OpenClaw memory plugin configuration, knowledge search/save workflows, watchers, or browser-authenticated connectors.

## Core Model

- **Lobu** is the agent framework, runtime, deployment layer, and memory surface.
- Keep framework configuration in `lobu.toml`.
- Keep agent identity and behavior in `IDENTITY.md`, `SOUL.md`, and `USER.md`.
- Keep reusable capability bundles in `skills/<name>/SKILL.md` or `agents/<agent>/skills/<name>/SKILL.md`.
- Use `lobu login` for CLI authentication. Do not use a separate memory login command.
- Use `lobu memory ...` for memory operations, MCP client wiring, seeding, direct tool calls, and browser-auth capture.

## Project Checklist

1. Read `lobu.toml` first.
2. Read the active agent files under `agents/<id>/`.
3. Check local skills under `skills/` and `agents/<id>/skills/`.
4. Use `lobu validate` after config changes.
5. Use `lobu eval` when prompt or behavior changes.

## Common Commands

```bash
npx @lobu/cli@latest init my-agent
npx @lobu/cli@latest run
npx @lobu/cli@latest validate
npx @lobu/cli@latest eval
npx @lobu/cli@latest login
```

<!-- owletto-memory-guidance:start -->
## Memory Defaults

Your long-term memory is powered by Owletto. Do NOT use local files (memory/, MEMORY.md) for memory.
- Owletto automatically recalls relevant memories when you receive a message.
- To save something, call save_knowledge with the content and an appropriate semantic_type.
- To search, call search_knowledge. Results include view_url links to the web interface.
- NEVER construct Owletto URLs yourself. When the user asks for a link, call search_knowledge to get the correct view_url.
- When the user says "remember this", save it to Owletto immediately.
<!-- owletto-memory-guidance:end -->

## Lobu Memory

Configure project-scoped memory in `lobu.toml`:

```toml
[memory.owletto]
enabled = true
org = "my-org"
name = "My workspace"
models = "./models"
data = "./data"
```

Then seed or operate the memory workspace with:

```bash
lobu login
lobu memory org set <org-slug>
lobu memory health --org <org-slug>
lobu memory seed --org <org-slug>
lobu memory run search_knowledge '{"query":"Acme"}' --org <org-slug>
```

Use `search_knowledge` first when the user asks about a specific entity or workspace memory. Use `save_knowledge` to persist durable memory. To update existing knowledge, search first, then save with `supersedes_event_id` so the old row is tombstoned rather than deleted.

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

For connectors that need cookies from a local browser session:

```bash
lobu memory browser-auth --connector <key> --auth-profile-slug <slug>
lobu memory browser-auth --connector <key> --auth-profile-slug <slug> --check
```

Use `--chrome-profile`, `--launch-cdp`, and `--dedicated-profile` only when the user needs a specific browser profile or dedicated remote-debugging profile.

## Tool Discipline

- Search before create to avoid duplicate entities.
- Never fabricate Lobu memory links. If a tool returns a view URL, use that URL.
- Use canonical MCP tool names only.
- Prefer read-only operations before mutations when validating connectivity.
- `events` is append-only: never delete rows directly; use tombstone/supersede flows.
