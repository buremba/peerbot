---
name: owletto
description: Install and use Owletto with Codex, ChatGPT, Claude, Cursor, Gemini, OpenClaw, or other MCP-capable agents, and operate Owletto memory, knowledge, watchers, and connections through the canonical MCP tools.
---

# Owletto

Use this skill when a user wants to connect an agent to Owletto, use Owletto as persistent memory, or operate the Owletto knowledge graph and watcher system safely.

## Core Rules

- **Web/desktop clients** (Claude Desktop, ChatGPT, Gemini, Cursor, Claude Code): Use direct remote HTTP MCP — they handle browser-based OAuth natively.
- **Coding agents without browser OAuth** (Codex, headless CI): Use the Owletto CLI with `--device` flag for device code login, then call MCP tools via the CLI.
- Use the actual runtime MCP URL. Never hardcode `owletto.com` unless the user explicitly asked for that hosted instance.
- Use canonical MCP tool names only.
- Search before create to avoid duplicate entities.
- Never fabricate Owletto links. If a tool returns a view URL, use that URL.

<!-- owletto-memory-guidance:start -->
## Memory Defaults

Your long-term memory is powered by Owletto. Do NOT use local files (memory/, MEMORY.md) for memory.
- Owletto automatically recalls relevant memories when you receive a message.
- To save something, call save_knowledge with the content and an appropriate semantic_type.
- To search, call search_knowledge. Results include view_url links to the web interface.
- NEVER construct Owletto URLs yourself. When the user asks for a link, call search_knowledge to get the correct view_url.
- When the user says "remember this", save it to Owletto immediately.
<!-- owletto-memory-guidance:end -->

## Install Flow

Start the local Owletto runtime first:

```bash
owletto start
```

Then run the interactive wizard:

```bash
owletto init
```

The wizard detects installed agents, authenticates, and configures supported local clients directly. For browser-managed clients it opens the install handoff or shows the required settings steps. Choose the MCP endpoint your agents should use: Cloud, local runtime, or a custom URL.

For manual per-client setup, see [references/client-install.md](references/client-install.md).
If the client cannot do browser OAuth (headless/CI), use device code login from [references/cli-fallback.md](references/cli-fallback.md).
After installation, validate connectivity with a read-only operation before doing mutations.

## Organization Management

The CLI stores one session per org. Set the default org after login:

```bash
owletto org set <slug>     # Set default org for CLI commands
owletto org current        # Show current org
```

Override per-command with `--org <slug>` or `OWLETTO_ORG` env var. For multi-server setups, use `--url` or `OWLETTO_URL` to target a different server.

## Tool Discipline

- Use `search_knowledge` first when the user asks about a specific entity or workspace memory.
- Use `read_knowledge` to retrieve saved content or watcher execution inputs. Supports semantic search via `query` parameter — finds content by meaning, not just keywords.
- Use `save_knowledge` to persist durable memory. To update an existing fact, pass `supersedes_event_id` with the old event ID — the old event is hidden from future searches. Always search first to avoid duplicates.
- Use `manage_entity` and `manage_connections` for graph and integration changes.
- Use `get_watcher` and `manage_watchers` for watcher inspection and execution workflows.

See [references/tool-workflows.md](references/tool-workflows.md) for the canonical patterns and example calls.

## Companion Skill

If the task is specifically OpenClaw plugin installation or reconfiguration, use `owletto-openclaw` for the setup steps and use this skill for general Owletto operation.
