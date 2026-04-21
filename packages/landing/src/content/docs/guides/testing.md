---
title: Testing
description: How to test your agent locally with the CLI, REST API, and platform connections.
---

Lobu provides multiple ways to test your agent during development.

## CLI chat

Send a prompt and stream the response in your terminal.

```bash
# Basic test
npx @lobu/cli@latest chat "Hello, what can you do?"

# Multi-turn conversation
npx @lobu/cli@latest chat "What's on my calendar?" --thread my-test
npx @lobu/cli@latest chat "Cancel the 3pm meeting" --thread my-test

# Target a specific agent (if you have multiple in lobu.toml)
npx @lobu/cli@latest chat "Hello" --agent support

# Dry run (no history persisted)
npx @lobu/cli@latest chat "Test prompt" --dry-run

# Force a fresh session
npx @lobu/cli@latest chat "Start over" --new
```

This uses **API mode** — the agent runs and responds directly to your terminal. No platform connection needed.

## Testing through a platform

Route messages through a connected platform to test the full end-to-end flow.

### Using the CLI

The `--user` flag routes your message through a platform connection:

```bash
# Send as a Telegram user
npx @lobu/cli@latest chat "Hello" --user telegram:12345

# Send to a Slack channel
npx @lobu/cli@latest chat "Hello" --user slack:C0123ABCD

# Send to Discord
npx @lobu/cli@latest chat "Hello" --user discord:987654321
```

The response appears on the platform **and** streams to your terminal.

### Using the test script

The `test-bot.sh` script automates platform testing with automatic response polling:

```bash
# Auto-detect platform from active connections
./scripts/test-bot.sh "Hello, test message"

# Send multiple messages in sequence
./scripts/test-bot.sh "First question" "Follow-up" "Third message"

# Explicit platform
TEST_PLATFORM=telegram ./scripts/test-bot.sh "Hello"
TEST_PLATFORM=slack ./scripts/test-bot.sh "Hello"
```

#### Telegram testing

For Telegram, the script sends messages **as your real user account** using `tguser`, so the bot sees a real user message:

```bash
# Uses the active Telegram bot connection from the gateway
./scripts/test-bot.sh "Hello bot"

# Target a specific bot
TEST_CHANNEL=@mybot ./scripts/test-bot.sh "Hello"
```

Requirements: `tguser` installed, `TG_API_ID` and `TG_API_HASH` set in `.env`.

#### Slack testing

```bash
TEST_PLATFORM=slack QA_SLACK_CHANNEL=C0123ABCD ./scripts/test-bot.sh "Hello"
```

Set `SLACK_BOT_TOKEN` in `.env` to enable automatic reply polling.

#### WhatsApp testing

```bash
TEST_PLATFORM=whatsapp TEST_CHANNEL=+1234567890 ./scripts/test-bot.sh "Hello"
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `TEST_PLATFORM` | Force platform: `telegram`, `slack`, `whatsapp` (auto-detected if unset) |
| `TEST_CHANNEL` | Channel/chat ID for the target platform |
| `TEST_TIMEOUT` | Response timeout in seconds (default: 120) |
| `TEST_AGENT_ID` | Agent ID to test (default: `test-{platform}`) |
| `GATEWAY_URL` | Gateway URL (default: `http://localhost:8080`) |

## REST API

Send messages directly to the gateway HTTP API:

```bash
curl -X POST http://localhost:8080/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "api",
    "content": "Hello!"
  }'
```

Route through a platform by adding platform-specific fields:

```bash
# Through Slack
curl -X POST http://localhost:8080/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "slack",
    "content": "Hello!",
    "slack": { "channel": "C0123ABCD" }
  }'

# Through Telegram
curl -X POST http://localhost:8080/api/v1/agents/{agentId}/messages \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "telegram",
    "content": "Hello!",
    "telegram": { "chatId": "12345" }
  }'
```

Browse all available endpoints at `/api/docs` on your running gateway.

## Testing against remote environments

Use named contexts to test against staging or production:

```bash
# Add a staging context
npx @lobu/cli@latest context add staging --api-url https://staging.example.com/api/v1
npx @lobu/cli@latest login -c staging

# Chat with the staging agent
npx @lobu/cli@latest chat "Hello" -c staging
```

## Resetting conversation state

If the agent gives stale or incorrect responses, clear the chat history in Redis:

```bash
# Find chat history keys
docker compose -f docker/docker-compose.yml exec redis redis-cli KEYS 'chat:history:*'

# Delete a specific conversation
docker compose -f docker/docker-compose.yml exec redis redis-cli DEL 'chat:history:{key}'
```

## Agent evaluations

For automated quality checks, use the `eval` command:

```bash
npx @lobu/cli@latest eval                           # run all evals
npx @lobu/cli@latest eval basic-qa                  # run a specific eval
npx @lobu/cli@latest eval --model claude/sonnet     # eval with a specific model
npx @lobu/cli@latest eval --list                       # list available evals
npx @lobu/cli@latest eval --ci --output results.json  # CI mode
```

Eval files live in the agent directory and define test cases with expected outcomes. Use `--ci` for non-zero exit codes on failure in CI/CD pipelines.
