---
title: Agent Settings
description: What can be configured per agent and how those settings affect runtime.
---

Agent settings control behavior of each worker session.

## What You Can Configure

- **Provider and model** — `model`, `modelSelection` (auto/pinned), `providerModelPreferences`, `installedProviders`
- **Allowed/disallowed tools** — `toolsConfig`
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

## Practical Guidance

- Keep tool permissions minimal.
- Add only required domains/grants.
- Prefer explicit permission grants over broad access.

## Memory Plugin Defaults

The default memory plugin depends on the `MEMORY_URL` environment variable:

| `MEMORY_URL` | Default plugin |
|---|---|
| **Not set** (default) | `@openclaw/native-memory` (filesystem-based) |
| **Set** | `@lobu/owletto-openclaw` (falls back to native memory if the Owletto plugin is not installed) |

When Owletto is active, the gateway automatically configures the MCP endpoint and auth URL — no manual wiring needed.

### Per-agent override

You can override the default for a specific agent by setting `pluginsConfig` in agent settings:

```json
{
  "pluginsConfig": {
    "plugins": [
      {
        "source": "@lobu/owletto-openclaw",
        "slot": "memory",
        "enabled": true
      }
    ]
  }
}
```

Or switch to native memory explicitly:

```json
{
  "pluginsConfig": {
    "plugins": [
      {
        "source": "@openclaw/native-memory",
        "slot": "memory",
        "enabled": true
      }
    ]
  }
}
```

Set `"enabled": false` to disable memory entirely for an agent.
