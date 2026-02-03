#!/bin/bash
set -e

# Bot testing script with multi-message and multi-platform support
# Usage: ./scripts/test-bot.sh "message 1" ["message 2"] ["message 3"] ...
# Or: ./scripts/test-bot.sh (uses default test message)
#
# Environment variables:
#   TEST_PLATFORM   - "slack" or "whatsapp" (default: auto-detect from enabled platforms)
#   TEST_CHANNEL    - Channel ID (Slack) or phone number (WhatsApp)
#   TEST_TIMEOUT    - Timeout in seconds (default: 30)
#
# Platform-specific:
#   Slack: QA_SLACK_CHANNEL, SLACK_BOT_TOKEN
#   WhatsApp: WHATSAPP_SELF_PHONE (defaults to bot's own number for self-chat)

# Load .env if it exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | grep -E 'SLACK_BOT_TOKEN|WHATSAPP_ENABLED|WHATSAPP_SELF_CHAT|QA_SLACK_CHANNEL|TEST_PLATFORM|TEST_CHANNEL' | sed 's/#.*//' | xargs)
fi

# Auto-detect platform if not specified
if [ -z "$TEST_PLATFORM" ]; then
    if [ "$WHATSAPP_ENABLED" = "true" ]; then
        TEST_PLATFORM="whatsapp"
    elif [ -n "$SLACK_BOT_TOKEN" ]; then
        TEST_PLATFORM="slack"
    else
        echo "❌ No platform configured. Set TEST_PLATFORM=slack or TEST_PLATFORM=whatsapp"
        exit 1
    fi
fi

TIMEOUT="${TEST_TIMEOUT:-30}"

# Platform-specific setup
case "$TEST_PLATFORM" in
    slack)
        if [ -z "$SLACK_BOT_TOKEN" ]; then
            echo "❌ SLACK_BOT_TOKEN environment variable is required for Slack"
            exit 1
        fi
        AUTH_TOKEN="$SLACK_BOT_TOKEN"
        CHANNEL="${TEST_CHANNEL:-$QA_SLACK_CHANNEL}"
        if [ -z "$CHANNEL" ]; then
            echo "❌ QA_SLACK_CHANNEL or TEST_CHANNEL environment variable is required for Slack"
            exit 1
        fi
        ;;
    whatsapp)
        # WhatsApp uses a simple auth token or empty (handled by gateway)
        AUTH_TOKEN="${WHATSAPP_AUTH_TOKEN:-whatsapp-test}"
        CHANNEL="${TEST_CHANNEL:-$WHATSAPP_SELF_PHONE}"
        if [ -z "$CHANNEL" ]; then
            # For self-chat mode, we can use "self" as a special channel
            if [ "$WHATSAPP_SELF_CHAT" = "true" ]; then
                CHANNEL="self"
            else
                echo "❌ TEST_CHANNEL or WHATSAPP_SELF_PHONE environment variable is required for WhatsApp"
                exit 1
            fi
        fi
        ;;
    *)
        echo "❌ Unknown platform: $TEST_PLATFORM. Use 'slack' or 'whatsapp'"
        exit 1
        ;;
esac

# Get messages from arguments or use default
if [ $# -eq 0 ]; then
    MESSAGES=("@me test message")
else
    MESSAGES=("$@")
fi

echo "🧪 Testing bot with ${#MESSAGES[@]} message(s)"
echo "📱 Platform: $TEST_PLATFORM"
echo "📍 Channel: $CHANNEL"
echo "⏱️  Timeout: ${TIMEOUT}s"
echo ""

LAST_THREAD_ID=""

# Send each message sequentially
for i in "${!MESSAGES[@]}"; do
    MESSAGE="${MESSAGES[$i]}"
    MSG_NUM=$((i + 1))

    echo "[$MSG_NUM/${#MESSAGES[@]}] 📤 Sending: $MESSAGE"

    # Escape message for JSON (handle newlines, quotes, backslashes)
    ESCAPED_MESSAGE=$(printf '%s' "$MESSAGE" | jq -Rs .)

    # Build request body using jq for proper JSON
    # Use TEST_AGENT_ID or generate a default test agent ID
    AGENT_ID="${TEST_AGENT_ID:-test-agent}"

    # Build base body
    if [ -n "$LAST_THREAD_ID" ]; then
        BODY=$(jq -n \
            --arg agentId "$AGENT_ID" \
            --arg platform "$TEST_PLATFORM" \
            --arg channel "$CHANNEL" \
            --argjson message "$ESCAPED_MESSAGE" \
            --arg threadId "$LAST_THREAD_ID" \
            '{agentId: $agentId, platform: $platform, channel: $channel, message: $message, threadId: $threadId}')
    else
        BODY=$(jq -n \
            --arg agentId "$AGENT_ID" \
            --arg platform "$TEST_PLATFORM" \
            --arg channel "$CHANNEL" \
            --argjson message "$ESCAPED_MESSAGE" \
            '{agentId: $agentId, platform: $platform, channel: $channel, message: $message}')
    fi

    # Add platform-specific routing info
    case "$TEST_PLATFORM" in
        whatsapp)
            BODY=$(echo "$BODY" | jq --arg chat "$CHANNEL" '. + {whatsapp: {chat: $chat}}')
            ;;
    esac

    # Send message
    RESPONSE=$(curl -s -X POST http://localhost:8080/api/messaging/send \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$BODY")

    # Check success
    if ! echo "$RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
        echo "   ❌ Failed to send message $MSG_NUM:"
        echo "$RESPONSE" | jq 2>/dev/null || echo "$RESPONSE"
        exit 1
    fi

    CHANNEL_ID=$(echo "$RESPONSE" | jq -r '.channel')
    THREAD_ID=$(echo "$RESPONSE" | jq -r '.threadId')
    MESSAGE_ID=$(echo "$RESPONSE" | jq -r '.messageId')
    QUEUED=$(echo "$RESPONSE" | jq -r '.queued')

    echo "   ✅ Sent: messageId=$MESSAGE_ID, queued=$QUEUED"

    # Save thread for subsequent messages
    LAST_THREAD_ID="$THREAD_ID"

    # Platform-specific response handling
    case "$TEST_PLATFORM" in
        slack)
            # For Slack, we can poll for responses via API
            if [ "$QUEUED" = "true" ]; then
                echo "   📋 Queued directly - checking logs..."
                sleep 2
            else
                echo "   ⏳ Waiting for bot response..."
                START_TIME=$(date +%s)

                while true; do
                    CURRENT_TIME=$(date +%s)
                    ELAPSED=$((CURRENT_TIME - START_TIME))

                    if [ $ELAPSED -ge $TIMEOUT ]; then
                        echo "   ❌ Timeout: No bot response within ${TIMEOUT}s"
                        exit 1
                    fi

                    # Check for replies in thread
                    REPLIES=$(curl -s -X POST https://slack.com/api/conversations.replies \
                        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
                        -H "Content-Type: application/x-www-form-urlencoded" \
                        -d "channel=$CHANNEL_ID&ts=$THREAD_ID&limit=20")

                    # Check if we got bot messages after our message
                    BOT_RESPONSE=$(echo "$REPLIES" | jq -r '.messages[]? | select(.bot_id != null) | select(.ts > "'"$MESSAGE_ID"'") | .text' | head -1)

                    if [ -n "$BOT_RESPONSE" ]; then
                        echo "   ✅ Bot responded:"
                        echo "      $(echo "$BOT_RESPONSE" | head -c 200)..."
                        break
                    fi

                    sleep 2
                done
            fi
            ;;
        whatsapp)
            # For WhatsApp, we can't poll for responses - just wait and check logs
            echo "   📋 Message sent to WhatsApp - check your phone for response"
            if [ "$QUEUED" = "true" ]; then
                echo "   ⏳ Waiting for processing..."
                sleep 5
            fi
            ;;
    esac

    echo ""
done

echo "🎉 All messages sent successfully!"
exit 0
