---
name: owletto-openclaw
description: Install and configure the Owletto memory plugin for OpenClaw, including OAuth login and MCP health verification.
---

# Owletto OpenClaw Setup

Use this skill when a user wants Owletto long-term memory working in OpenClaw.

For general Owletto usage with Codex, ChatGPT, Claude, Cursor, Gemini, or generic MCP workflows, use `owletto`.

## Quick Setup

Start the local Owletto runtime first:

```bash
owletto start
```

Then run the interactive wizard:

```bash
owletto init
```

Choose the MCP endpoint (Cloud, local runtime, or custom URL). The wizard will detect OpenClaw and run the full plugin setup.

## Manual Setup

1. Install the OpenClaw plugin.

```bash
openclaw plugins install owletto-openclaw-plugin
```

2. Log in to Owletto.

```bash
owletto login <mcp-url>
```

3. Configure the plugin.

```bash
owletto configure
```

4. Verify connectivity.

```bash
owletto health
```

## Self-Hosted

Start a local Owletto server first (no Docker needed):

```bash
owletto start
```

Then configure OpenClaw against it:

```bash
owletto init --url http://localhost:8787/mcp
```

## Notes

- Replace `<mcp-url>` with the target MCP URL (e.g. the URL shown on the workspace data sources page).
- For headless environments without browser access, use `owletto login --device <mcp-url>`.
