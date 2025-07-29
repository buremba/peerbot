# Slack Token Rotation Implementation

## Overview
Implemented automatic token rotation for Slack bot tokens that expire every 12 hours. The implementation includes:

1. **SlackTokenManager Class** (`packages/dispatcher/src/slack/token-manager.ts`)
   - Handles automatic token refresh 30 minutes before expiration
   - Uses refresh token to obtain new access tokens
   - Supports manual refresh and automatic scheduling

2. **Dispatcher Integration** (`packages/dispatcher/src/index.ts`)
   - Initializes token manager when refresh token is available
   - Uses dynamic token authorization instead of static tokens
   - Falls back to static token if refresh token not available

3. **Worker Integration** (`packages/worker/src/index.ts`)
   - Receives refresh token credentials via environment variables
   - Creates own token manager instance for independent token management
   - Updates Slack client to use dynamic tokens

4. **Kubernetes Integration** (`packages/dispatcher/src/kubernetes/job-manager.ts`)
   - Passes refresh token credentials to worker pods via Kubernetes secrets
   - Added environment variables: SLACK_REFRESH_TOKEN, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET

## Environment Variables Required

### For Token Rotation
- `SLACK_REFRESH_TOKEN` - OAuth refresh token from Slack
- `SLACK_CLIENT_ID` - Slack app client ID
- `SLACK_CLIENT_SECRET` - Slack app client secret
- `SLACK_BOT_TOKEN` - Initial bot token (optional if using refresh token)

### Kubernetes Secrets
The following secrets need to be added to the `claude-secrets` secret:
- `slack-refresh-token`
- `slack-client-id`
- `slack-client-secret`

## How It Works

1. **Initial Token**: If no bot token is provided but refresh credentials are available, the system obtains an initial token
2. **Automatic Refresh**: Token manager schedules refresh 30 minutes before token expiration
3. **Dynamic Authorization**: Slack clients use an `authorize` function that always returns a valid token
4. **Error Recovery**: If refresh fails, system retries after 5 minutes
5. **Worker Independence**: Each worker manages its own token lifecycle

## Testing

Use the provided test script to verify the implementation:
```bash
node tmp/test-token-rotation.js
```

## Security Considerations

- Refresh tokens and client secrets are stored in Kubernetes secrets
- Tokens are never logged in full (only first 20 characters for debugging)
- Each component manages its own token lifecycle independently
- Automatic cleanup on shutdown prevents token leaks