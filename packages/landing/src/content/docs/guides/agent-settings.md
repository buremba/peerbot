---
title: Agent Settings
description: What can be configured per agent and how those settings affect runtime.
---

Agent settings control behavior of each worker session.

## What You Can Configure

- **Provider and model** — `model`, `modelSelection` (auto/pinned), `providerModelPreferences`, `installedProviders`
- **Allowed/disallowed tools** — configured in `[agents.<id>.tools]` in `lobu.toml`
- **Skills/plugins and MCP server config** — `skillsConfig`, `mcpServers`, `pluginsConfig`
- **Permission grants (network domains)** — `networkConfig`
- **Agent prompts** — `identityMd`, `soulMd`, `userMd`
- **Auth profiles** — `authProfiles` for multi-provider credential management
- **Worker environment** — `nixConfig` for Nix packages
- **Verbose logging** — `verboseLogging` to show tool calls and reasoning
- **Template inheritance** — `templateAgentId` for settings fallback from a template agent

## How Settings Apply

- Gateway is the source of truth for settings.
- Worker fetches session context from gateway before execution.
- Tool policy is applied before tools are exposed to the model.

See [Tool Policy](/guides/tool-policy/) for the operator-facing config, and [`lobu.toml` reference](/reference/lobu-toml/) for the exact schema.

## Practical Guidance

- Keep tool permissions minimal.
- Add only required domains/grants.
- Prefer explicit permission grants over broad access.

## Memory Plugins

Memory is pluggable. In file-first projects, the gateway first checks `[memory.owletto]` in `lobu.toml`; any agent can still override the default via `pluginsConfig`.

### Defaults

| Effective config | Plugin used |
|---|---|
| `[memory.owletto]` disabled or unresolved, and no `MEMORY_URL` override | `@openclaw/native-memory` — files under `/workspace` (per-thread PVC in K8s, `./workspaces/{threadId}/` in Docker). Not shared across threads. |
| `[memory.owletto]` enabled | `@lobu/owletto-openclaw` — the OpenClaw memory plugin for Owletto. It translates OpenClaw memory calls into Owletto MCP requests via the gateway's `/mcp/owletto` proxy. Cross-session, shareable across agents. |
| `MEMORY_URL` set | Used as the base Owletto MCP endpoint before Lobu scopes it to the org from `[memory.owletto]` in `lobu.toml`. Useful for local or custom Owletto deployments. |

`lobu init` now scaffolds the file-first Owletto layout for memory-enabled projects:

- `[memory.owletto]` in `lobu.toml` (org, name, description, models, data)
- `models/`
- `data/`

For **Lobu Cloud**, Lobu can use the hosted default automatically. For **Owletto Local** and **Custom URL**, `MEMORY_URL` remains the base-endpoint override.

If the preferred plugin isn't installed, the gateway falls back to the other one (or to no memory if neither is installed).

### Per-agent override

A per-agent `pluginsConfig` **replaces** the default plugin list entirely — it does not merge. Include every plugin the agent should run.

Switch one agent to Owletto:

```json
{
  "pluginsConfig": {
    "plugins": [
      { "source": "@lobu/owletto-openclaw", "slot": "memory", "enabled": true }
    ]
  }
}
```

The gateway injects the internal `mcpUrl` and `gatewayAuthUrl` automatically — you don't need to hand-write them.

That means the plugin source is the only part you normally set yourself. OpenClaw loads `@lobu/owletto-openclaw` as the agent's `slot: "memory"` plugin, and Lobu fills in the proxy/auth details needed to reach Owletto safely.

Switch to native memory:

```json
{
  "pluginsConfig": {
    "plugins": [
      { "source": "@openclaw/native-memory", "slot": "memory", "enabled": true }
    ]
  }
}
```

Disable memory for the agent by setting `"enabled": false` (or by listing no `slot: "memory"` plugin at all).
