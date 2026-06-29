---
title: Agent Settings
description: What can be configured per agent and how those settings affect runtime.
---

Agent settings control behavior of each worker session.

## What You Can Configure

Two surfaces feed an agent's effective config:

- **Runtime config** — the camelCase keys below, stored per agent and edited through the web UI or the settings API.
- **`lobu.config.ts` operator config** — code-as-config declarations on `defineAgent` (e.g. `tools`, `egress`, `guardrails`) applied with `lobu apply`.

Runtime config keys:

- **Provider and model** — `model`, `modelSelection` (auto/pinned), `providerModelPreferences`, `installedProviders`
- **Skills/plugins and connector config** — `skillsConfig`, `pluginsConfig`, and connector connections
- **Permission grants (network domains)** — `networkConfig`
- **Agent prompts** — `identityMd`, `soulMd`, `userMd`
- **Auth profiles** — `authProfiles` for multi-provider credential management
- **Worker environment** — `nixConfig` for Nix packages
- **Verbose logging** — `verboseLogging` to show tool calls and reasoning
- **Template inheritance** — `templateAgentId` for settings fallback from a template agent

Allowed/disallowed tools are part of the `lobu.config.ts` operator surface — the agent `tools` field.

## How Settings Apply

- Gateway is the source of truth for settings.
- Worker fetches session context from gateway before execution.
- Tool policy is applied before tools are exposed to the model.

See [Tool Policy](/guides/tool-policy/) for the operator-facing config, and [`lobu.config.ts` reference](/reference/lobu-config/) for the exact schema.

## Practical Guidance

- Keep tool permissions minimal.
- Add only required domains/grants.
- Prefer explicit permission grants over broad access.

## Memory Plugins

Memory is pluggable. The gateway resolves the org from `defineConfig({ org })` in `lobu.config.ts`; any agent can still override the default via `pluginsConfig`.

### Defaults

| Effective config | Plugin used |
|---|---|
| No `org` set and no `MEMORY_URL` override | `@openclaw/native-memory` — files under the worker workspace. Not shared across threads. |
| `org` set | `@lobu/openclaw-plugin` — the OpenClaw memory plugin for Lobu. It translates OpenClaw memory calls into Lobu MCP requests via the gateway's `/mcp/lobu` proxy. Cross-session, shareable across agents. |
| `MEMORY_URL` set | Used as the base Lobu MCP endpoint before Lobu scopes it to the org from `defineConfig({ org })`. Useful for local or custom Lobu deployments. |

`lobu init` scaffolds the Lobu memory wiring for memory-enabled projects:

- `org` / `orgName` in `defineConfig` (`lobu.config.ts`)
- the entity, relationship, and watcher types declared with `defineEntityType` / `defineRelationshipType` / `defineWatcher`
- `data/`

For **Lobu Cloud**, Lobu can use the hosted default automatically. For **Lobu Local** and **Custom URL**, `MEMORY_URL` remains the base-endpoint override.

If the preferred plugin isn't installed, the gateway falls back to the other one (or to no memory if neither is installed).

### Per-agent override

A per-agent `pluginsConfig` **replaces** the default plugin list entirely — it does not merge. Include every plugin the agent should run.

Switch one agent to Lobu:

```json
{
  "pluginsConfig": {
    "plugins": [
      { "source": "@lobu/openclaw-plugin", "slot": "memory", "enabled": true }
    ]
  }
}
```

The gateway injects the internal `mcpUrl` and `gatewayAuthUrl` automatically — you don't need to hand-write them.

That means the plugin source is the only part you normally set yourself. OpenClaw loads `@lobu/openclaw-plugin` as the agent's `slot: "memory"` plugin, and Lobu fills in the proxy/auth details needed to reach Lobu safely.

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
