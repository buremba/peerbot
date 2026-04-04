# Testing Your Lobu

This bot provides HTTP APIs for testing and automation. These endpoints allow AI agents and developers to interact with your bot programmatically.

## 1. Messaging API

Send messages to your bot with optional file uploads.

### Endpoint
```
POST http://localhost:8081/api/v1/agents/{agentId}/messages
```

### Authentication

**Bearer Token in Header:**
```
Authorization: Bearer xoxb-your-bot-token
```

The bot token must be provided in the `Authorization` header, not in the request body.

### Request Format

#### JSON Request (Simple Message)
```bash
curl -X POST http://localhost:8081/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer xoxb-your-bot-token" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "slack",
    "channel": "general",
    "message": "what is 2+2?"
  }'
```

#### Multipart Request (With File Upload)
```bash
curl -X POST http://localhost:8081/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer xoxb-your-bot-token" \
  -F "platform=slack" \
  -F "channel=C12345678" \
  -F "message=please review this file" \
  -F "file=@/path/to/document.pdf"
```

### Parameters

| Field | Required | Description |
|-------|----------|-------------|
| `platform` | Yes | Platform name (`api`, `slack`, `telegram`, `discord`, etc.) |
| `channel` | Yes | Channel ID (e.g., `C12345678`) or name (e.g., `general`, `#general`) |
| `message` | Yes | Message text to send (use `@me` to mention the bot) |
| `threadId` | No | Thread ID to reply to (for thread continuity) |
| `files` | No | File attachments (multipart/form-data, up to 10 files) |

### Response Format

```json
{
  "success": true,
  "channel": "C12345678",
  "messageId": "1234567890.123456",
  "threadId": "1234567890.123456",
  "threadUrl": "https://app.slack.com/client/T12345/C12345678/thread/1234567890.123456"
}
```

**Note about `threadId`:**
- When posting a new message (no `threadId` parameter), `threadId` equals `messageId`
- When replying to a thread (with `threadId` parameter), `threadId` is the original thread's ID

### Bot Mentions

Use the `@me` placeholder to mention the bot in a platform-agnostic way:

```json
{
  "message": "@me what is 2+2?"
}
```

The API automatically replaces `@me` with the correct bot mention for the platform:
- **Slack**: `<@U12345>` 
- **Discord** (future): `<@123456>`
- **Telegram** (future): `@botname`

If you don't want to mention the bot, simply omit `@me` from your message.

### Example: Simple Text Message (with @me)

```bash
curl -X POST http://localhost:8081/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer xoxb-your-bot-token" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "slack",
    "channel": "general",
    "message": "@me what is 2+2?"
  }'
```

### Example: Without Bot Mention

```bash
curl -X POST http://localhost:8081/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer xoxb-your-bot-token" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "slack",
    "channel": "general",
    "message": "just a regular message"
  }'
```

### Example: Thread Reply

```bash
curl -X POST http://localhost:8081/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer xoxb-your-bot-token" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "slack",
    "channel": "C12345678",
    "message": "tell me more about that",
    "threadId": "1234567890.123456"
  }'
```

### Example: Single File Upload

```bash
curl -X POST http://localhost:8081/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer xoxb-your-bot-token" \
  -F "platform=slack" \
  -F "channel=dev-channel" \
  -F "message=@me analyze this CSV" \
  -F "files=@data.csv"
```

### Example: Multiple File Upload

```bash
curl -X POST http://localhost:8081/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer xoxb-your-bot-token" \
  -F "platform=slack" \
  -F "channel=dev-channel" \
  -F "message=@me review these documents" \
  -F "files=@document1.pdf" \
  -F "files=@document2.pdf" \
  -F "files=@spreadsheet.xlsx"
```

### Channel Name Resolution

The API automatically resolves channel names to IDs:
- `"general"` → `"C12345678"`
- `"#general"` → `"C12345678"`
- `"C12345678"` → `"C12345678"` (already an ID)

### Error Handling

```json
{
  "success": false,
  "error": "Failed to send message",
  "details": "Channel \"nonexistent\" not found"
}
```

Common errors:
- `400`: Missing required fields (`platform`, `channel`, or `message`)
- `401`: Missing or invalid `Authorization` header
- `404`: Platform not found
- `500`: Platform API error (invalid token, channel not found, etc.)
- `501`: Platform doesn't support `sendMessage`

### Platform-Agnostic Design

The messaging API works across all supported platforms. The `@me` placeholder is automatically replaced with the correct bot mention for each platform.

---

## 2. Complete E2E Testing Example

Testing a full conversation:

```bash
# Step 1: Send initial message
RESPONSE=$(curl -s -X POST http://localhost:8081/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "slack",
    "channel": "test-channel",
    "message": "@me give me three options"
  }')

THREAD_ID=$(echo $RESPONSE | jq -r '.threadId')
echo "Thread ID: $THREAD_ID"

# Step 2: Verify bot response
# (Check thread for follow-up message)
```

---

## 4. Notes for AI Agents

These APIs enable your AI agents to:
- **Test connectivity**: Verify bot deployment is working
- **E2E testing**: Automate full conversation flows
- **CI/CD integration**: Run automated tests before deployment
- **Development**: Quickly test bot behavior without manual Slack interaction

The messaging endpoint is **platform-agnostic** — the same API structure works across Slack, Telegram, Discord, and other supported platforms.
