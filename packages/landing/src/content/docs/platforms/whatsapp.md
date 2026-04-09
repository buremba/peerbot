---
title: WhatsApp
description: WhatsApp integration capabilities for Lobu agents.
---

Lobu's WhatsApp adapter uses the WhatsApp Business Cloud API for reliable, production-grade messaging.

## Setup

1. Obtain a WhatsApp Business **access token**, **phone number ID**, **app secret**, and **verify token** from the [Meta Developer Portal](https://developers.facebook.com/).
2. Open the admin page at `{PUBLIC_GATEWAY_URL}/agents`.
3. Click **Add Connection**, select **WhatsApp**, and fill in the required fields.
4. Configure the webhook URL in the Meta Developer Portal to point to your gateway's webhook endpoint.
5. The bot starts handling messages on the configured phone number.

## Features

- **Cloud API integration** via the WhatsApp Business Platform.
- **Group controls** with allow/deny behavior and optional mention requirement.
- **Typing indicator status** while responses are being generated.
- **File/media support** for inbound and outbound attachments.
- **Conversation history window** with configurable retention limits.

## Typical Use Cases

- Personal assistant over WhatsApp chats.
- Group assistant that only responds when mentioned.
- Media-aware workflows (voice notes, files, images).
