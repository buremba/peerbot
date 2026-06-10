---
title: Memory plugin
description: "Give an OpenClaw agent persistent Lobu memory over MCP with @lobu/openclaw-plugin: recall before each prompt, capture after each session."
---

[`@lobu/openclaw-plugin`](https://www.npmjs.com/package/@lobu/openclaw-plugin) gives an [OpenClaw](https://openclaw.ai) agent persistent, structured memory backed by Lobu over MCP. It recalls relevant facts before each prompt and captures new observations after each session, so a coding agent (or any OpenClaw agent) remembers across runs instead of starting cold every time.

This page is the package reference. For the click-through install flow with screenshots, see [Install to OpenClaw](/connect-from/openclaw/); for the memory model the plugin reads and writes, see [Memory](/getting-started/memory/).

## Install

```bash
openclaw plugins install @lobu/openclaw-plugin
```

Then log in and point the plugin at your Lobu memory MCP endpoint:

```bash
lobu login
lobu memory configure --url <mcp-url> --org <org-slug>
lobu memory health    --url <mcp-url> --org <org-slug>
```

Replace `<mcp-url>` with your workspace MCP URL: `https://lobu.ai/mcp/acme` for cloud, or `http://localhost:8787/mcp` for the local runtime. `lobu memory configure` writes a `tokenCommand` that shells out to `lobu token --raw`, so the plugin reuses your top-level Lobu CLI login rather than holding its own credential.

## Configuration

| Field | Description |
|-------|-------------|
| `mcpUrl` | Full MCP endpoint URL. **Required.** |
| `webUrl` | Public web URL for the Lobu instance. Used to render links the agent can show the user. |
| `token` | Bearer token for MCP requests. Optional: if unset, the plugin runs interactive device login. |
| `tokenCommand` | Shell command that prints a bearer token to stdout. Alternative to `token` (what `lobu memory configure` wires up). |
| `headers` | Extra HTTP headers for MCP requests. |
| `autoRecall` | Search Lobu memory for relevant memories before each prompt. Default `true`. |
| `recallLimit` | Maximum recalled records per request. Default `6`. |
| `autoCapture` | Capture conversation observations as long-term memories after each session. Default `true`. |
| `agentId` | Agent this plugin instance is bound to. When set, `autoCapture` stamps `metadata.agent_id` on every save so recall can scope to this agent's own writes. Falls back to the `LOBU_AGENT_ID` env var. |

The full schema lives in the package's `openclaw.plugin.json`.

## How it works

The plugin wraps the Lobu memory MCP server and adds two automatic hooks around each turn:

- **Recall (before the prompt).** When `autoRecall` is on, the plugin calls `search_memory` for context relevant to the incoming prompt and injects up to `recallLimit` records. The recall round-trip is deliberately bounded well under OpenClaw's ~15s hook budget; a slow search degrades to "no recall" rather than letting OpenClaw kill the hook.
- **Capture (after the session).** When `autoCapture` is on, the plugin distills the conversation into observations and saves them with `save_memory`, stamping `metadata.agent_id` when `agentId` is set so each agent's writes stay attributable.

## Tools the agent gets

The plugin registers each Lobu MCP server tool with OpenClaw under a `lobu_` prefix (`search_memory` becomes `lobu_search_memory`, and so on). Tools the server advertises but the plugin doesn't yet know are skipped rather than registered. The current set:

| Tool | Use |
|------|-----|
| `search_memory` | Hybrid (vector + full-text) search across the org's events. |
| `save_memory` | Append a new memory/event (with entity links, semantic type, metadata). |
| `list_organizations` | List the orgs the authenticated user belongs to; marks the bound org. |
| `search_sdk` | Discover ClientSDK methods and docs (doesn't query workspace data). |
| `query_sdk` | Run read-only TypeScript over the ClientSDK in a sandboxed isolate. |
| `run_sdk` | Full-SDK TypeScript, including writes. Destructive; the agent should confirm first. |
| `query_sql` | Paginated read-only SQL, auto-scoped to the bound org. |

In standalone mode the plugin also registers auth tools, `lobu_login` and `lobu_login_check`, so an agent that hits a not-yet-authenticated memory instance can drive the device-login flow itself (show the user the login URL + code, then finish auth) instead of failing.

## See also

- [Install to OpenClaw](/connect-from/openclaw/): the guided setup flow.
- [Memory](/getting-started/memory/): the entity + event model the plugin reads and writes.
- [Lobu memory CLI](/reference/lobu-memory/): `lobu memory configure / health / token` and friends.
