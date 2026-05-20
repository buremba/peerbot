---
title: REST API
description: Programmatic access to Lobu agents through HTTP endpoints.
---

Lobu exposes HTTP APIs so you can trigger agents and integrate with external systems.

## Features

- **Messaging endpoint** to send messages to agents over `api`, `slack`, `telegram`, and internal platform routes.
- **Bearer token authentication** for API access control.
- **Multipart file upload support** with per-file and total-size limits.
- **OpenAPI-documented routes** for schema-driven integrations.
- **Platform-aware routing fields** (for example Slack channel/thread metadata).

## Interactive API Reference

Browse all endpoints, try requests, and see response schemas in the [full API reference](/reference/api-reference/).

The reference is auto-generated from the gateway's OpenAPI spec and always reflects the latest routes.

For TypeScript SDKs used inside Lobu projects rather than over the wire, see:

- [`@lobu/connector-sdk`](/reference/connector-sdk/) — write connectors that emit events into the stream.
- [Reactions](/reference/reaction-sdk/) — the typed hook (part of `@lobu/connector-sdk`) for code that runs after a watcher extracts data.

## Quick Start

```bash
# Send a message to an agent
curl -X POST http://localhost:8787/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer $LOBU_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "api",
    "content": "Hello!"
  }'
```

To route the message into a Slack workspace instead, set `platform` to `slack` and include a `slack` routing object:

```bash
curl -X POST http://localhost:8787/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer $LOBU_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "slack",
    "slack": { "channel": "C0123456789", "thread": "1700000000.000100" },
    "content": "Hello!"
  }'
```

## Typical Use Cases

- Connect backend workflows to an agent programmatically.
- Trigger agent tasks from webhooks, cron jobs, or internal services.
- Build custom UI clients on top of Lobu's gateway API.
