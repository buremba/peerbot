---
title: Discord
description: Connect a Lobu agent to Discord servers via bot integration.
---

Lobu connects to Discord through the [Chat SDK](https://github.com/nicepkg/chat) Discord adapter, giving your agent access to direct messages and server channels.

## Setup

1. Create a Discord application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, create a bot and copy the **bot token**.
3. Copy the **Application ID** and **Public Key** from the General Information page.
4. Under **OAuth2 → URL Generator**, select the `bot` scope with `Send Messages`, `Read Message History`, and `Use Slash Commands` permissions. Use the generated URL to invite the bot to your server.
5. Add a connection in Lobu via the connections API or admin page:

```bash
curl -X POST https://your-gateway/api/v1/connections \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "discord",
    "templateAgentId": "your-agent-id",
    "config": {
      "platform": "discord",
      "botToken": "...",
      "applicationId": "...",
      "publicKey": "..."
    }
  }'
```

Or set environment variables and the adapter picks them up automatically:

```
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
DISCORD_PUBLIC_KEY=...
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `botToken` | Yes | Discord bot token |
| `applicationId` | Yes | Discord application ID |
| `publicKey` | Yes | Public key for webhook signature verification |
| `mentionRoleIds` | No | Role IDs that trigger the agent (in addition to direct @mentions) |

## Features

- **Direct messages** and **server channel mentions** trigger the agent.
- **Role-based triggers** — configure specific roles that activate the agent beyond direct mentions.
- **Streaming responses** with throttled message edits (updates every 2s).
- **Markdown formatting** — agent responses render as Discord-flavored markdown.
- **Interactive elements** — buttons and cards for user prompts, permission grants, and configuration.
- **Access control** — restrict which users or groups can interact with the agent.

## Typical Use Cases

- Team assistant in a Discord server (DevOps, support, knowledge base).
- Community bot that answers questions using your agent's skills and tools.
- Developer tool that runs commands or queries APIs on behalf of server members.
