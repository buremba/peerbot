---
title: Microsoft Teams
description: Connect a Lobu agent to Microsoft Teams as a bot.
---

Lobu connects to Microsoft Teams through the [Chat SDK](https://github.com/nicepkg/chat) Teams adapter, using Azure Bot Framework under the hood.

## Setup

1. Register a bot in the [Azure Portal](https://portal.azure.com) under **Azure Bot** (or **Bot Framework Registration**).
2. Note the **App ID**, **App Password** (client secret), and **Tenant ID**.
3. In the Azure Bot's **Channels** section, enable the **Microsoft Teams** channel.
4. Add a connection in Lobu:

```bash
curl -X POST https://your-gateway/api/v1/connections \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "teams",
    "templateAgentId": "your-agent-id",
    "config": {
      "platform": "teams",
      "appId": "...",
      "appPassword": "...",
      "appTenantId": "..."
    }
  }'
```

Or set environment variables:

```
TEAMS_APP_ID=...
TEAMS_APP_PASSWORD=...
TEAMS_APP_TENANT_ID=...
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `appId` | Yes | Azure Bot / Microsoft App ID |
| `appPassword` | Yes | App password (client secret) |
| `appTenantId` | Conditional | Required for SingleTenant apps |
| `appType` | No | `"MultiTenant"` (default) or `"SingleTenant"` |

## Authentication

The adapter supports two authentication modes:

- **Password auth** (default) — provide `appPassword` directly. Simplest setup.
- **Managed Identity (MSI)** — when `appPassword` is omitted, the adapter uses Azure Managed Identity. Useful for Azure-hosted deployments.

## Features

- **Direct messages** and **channel @mentions** trigger the agent.
- **Streaming responses** with throttled message edits.
- **Adaptive Cards** for interactive elements (permission grants, user prompts, configuration).
- **Access control** — restrict which users or groups can interact.
- **Multi-tenant and single-tenant** deployment modes.

## Typical Use Cases

- Internal assistant for engineering, HR, or IT teams.
- Workflow automation triggered by team conversations.
- Knowledge base bot accessible from Teams channels.
