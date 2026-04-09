---
title: Architecture
description: End-to-end request flow across gateway, worker, tools, and platforms.
---

Lobu runs as a gateway + worker architecture.

## Request Flow

1. User sends a message from Slack, Telegram, WhatsApp, or API.
2. Gateway receives it, resolves agent settings, and routes a job.
3. A worker executes the prompt using OpenClaw runtime.
4. Worker uses tools/MCP through gateway-controlled paths.
5. Gateway streams output back to the platform thread.

## Runtime Boundaries

- **Gateway**: orchestration, OAuth, secrets, domain policy, routing.
- **Worker**: model execution, tools, workspace state.
- **Redis**: queue/state backing for job flow.

## Persistent Memory

The default memory plugin depends on the `MEMORY_URL` environment variable:

- **`MEMORY_URL` not set** (default): uses `@openclaw/native-memory` (filesystem-based).
- **`MEMORY_URL` set**: uses `@lobu/owletto-openclaw`, falling back to native memory if the Owletto plugin is not installed.

Memory plugins are configurable per agent through `pluginsConfig` in agent settings.

### How It Works

1. Gateway selects the default memory plugin based on `MEMORY_URL` and sets it in `agentDefaults.pluginsConfig`.
2. Worker fetches session context from gateway and passes `pluginsConfig` into OpenClaw runtime startup.
3. OpenClaw loads enabled plugins for that agent session.
4. The memory plugin handles persistent memory operations so context can be reused across future runs.

## Security-Critical Path

- Workers do not directly own global provider secrets.
- Outbound access is controlled via gateway proxy and domain policy.
- MCP credentials are resolved by the gateway proxy. Integration auth is handled by Owletto.
