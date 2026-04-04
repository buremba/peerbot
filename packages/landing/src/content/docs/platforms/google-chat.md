---
title: Google Chat
description: Connect a Lobu agent to Google Chat as a Workspace app.
---

Lobu connects to Google Chat through the [Chat SDK](https://github.com/vercel/chat) Google Chat adapter (`@chat-adapter/gchat`), using the Google Chat API and Workspace Events for real-time messaging.

## Setup

1. Create a Google Cloud project and enable the **Google Chat API** and **Workspace Events API**.
2. Create a **service account** with the Chat Bot role, and download the JSON key file.
3. In the [Google Chat API configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat), configure the app:
   - Set the **App URL** to your gateway's webhook endpoint: `https://your-gateway/api/v1/webhooks/{connectionId}`
   - Enable **Interactive features** and configure the connection settings.
4. Add a connection in Lobu:

```bash
curl -X POST https://your-gateway/api/v1/connections \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "gchat",
    "templateAgentId": "your-agent-id",
    "config": {
      "platform": "gchat",
      "credentials": "{...service account JSON...}",
      "endpointUrl": "https://your-gateway/api/v1/webhooks/{connectionId}"
    }
  }'
```

Or set environment variables:

```
GOOGLE_CHAT_CREDENTIALS={"type":"service_account",...}
GOOGLE_CHAT_PROJECT_NUMBER=123456789
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `credentials` | Conditional | Service account JSON string. Required unless using ADC. |
| `useApplicationDefaultCredentials` | Conditional | Use ADC instead of service account JSON. Works with `GOOGLE_APPLICATION_CREDENTIALS`, Workload Identity, or `gcloud auth`. |
| `endpointUrl` | Recommended | Full webhook URL for button click actions. |
| `googleChatProjectNumber` | No | GCP project number for webhook JWT verification. |
| `impersonateUser` | No | User email for domain-wide delegation (Workspace Events). |
| `pubsubAudience` | No | Expected audience for Pub/Sub push JWT verification. |

## Authentication

The adapter supports three authentication modes:

- **Service account JSON** (default) — provide `credentials` with the JSON key contents.
- **Application Default Credentials (ADC)** — set `useApplicationDefaultCredentials: true`. Works with GCE, Cloud Run, Workload Identity Federation, or local `gcloud auth application-default login`.
- **Custom auth client** — for advanced use cases (programmatic only via the SDK).

## Features

- **Direct messages** and **space @mentions** trigger the agent.
- **Streaming responses** with throttled message edits.
- **Google Chat Cards v2** for interactive elements (buttons, permission grants, configuration).
- **Workspace Events integration** — subscribes to spaces for real-time message delivery.
- **Pub/Sub support** — receive events via Google Cloud Pub/Sub push subscriptions.
- **Access control** — restrict which users or groups can interact.

## Typical Use Cases

- Internal assistant accessible from Google Workspace.
- Workflow automation triggered by team conversations in Google Chat spaces.
- Knowledge base bot for organizations using Google Workspace.
