---
title: Telegram
description: Telegram integration capabilities for Lobu agents.
---

Lobu connects to Telegram through the [Chat SDK](https://github.com/vercel/chat) Telegram adapter (`@chat-adapter/telegram`), using the Telegram Bot API directly.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and copy the bot token.
2. Open the admin page at `{PUBLIC_GATEWAY_URL}/agents`.
3. Click **Add Connection**, select **Telegram**, and paste the bot token.
4. The bot starts receiving messages immediately.

## Features

- **Long-polling or webhook handling** for receiving messages.
- **Inline keyboard interactions** for structured choices and approvals.
- **Platform-scoped settings links** for authentication and configuration flows.
- **Thread/context routing** across DMs and group chats.
- **File handling** for documents and media attached in Telegram messages.

## Typical Use Cases

- Personal AI assistant in Telegram DMs.
- Group copilots with mention-based interaction patterns.
