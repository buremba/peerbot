# Slack Integration Setup

This guide covers setting up the Slack integration for the Claude Code Bot, including app configuration, permissions, and user experience.

## Slack App Creation

### 1. Create a New Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Select **"From scratch"**
4. Enter app details:
   - **App Name**: `Claude Code Bot` (or your preferred name)
   - **Development Slack Workspace**: Select your workspace

### 2. Configure Basic Information

In your app's **Basic Information** page:

1. Set **Display Name**: `Claude Code Bot`
2. Set **Short Description**: `AI-powered coding assistant with persistent conversations`
3. Set **Long Description**: 
   ```
   Claude Code Bot brings AI-powered coding assistance directly to Slack with:
   - Thread-based persistent conversations
   - Individual GitHub repositories for each user
   - Real-time progress updates
   - 5-minute focused work sessions
   - Automatic code commits and PR creation
   ```
4. Upload an **App Icon** (512x512px)
5. Set **Background Color**: `#FF6B35` (Claude's brand color)

## App Configuration

### 3. OAuth & Permissions

Navigate to **OAuth & Permissions** and add these **Bot Token Scopes**:

```
app_mentions:read      # Respond to @mentions
channels:history       # Read channel message history
channels:read          # Get basic channel information
chat:write            # Send messages as the bot
files:read            # Read file contents when shared
reactions:write       # Add reactions to messages
users:read           # Get user information
```

### 4. Event Subscriptions

Navigate to **Event Subscriptions** and:

1. **Enable Events**: Toggle to `On`
2. **Request URL**: `https://your-domain.com/slack/events` (if using HTTP mode)
3. **Subscribe to Bot Events**:
   ```
   app_mention          # When bot is mentioned
   message.channels     # Messages in channels (optional)
   message.im          # Direct messages to bot
   ```

### 5. Socket Mode (Recommended)

Navigate to **Socket Mode** and:

1. **Enable Socket Mode**: Toggle to `On`
2. **Event Subscriptions**: Will automatically switch to Socket Mode
3. **Generate App Token**: Create token with `connections:write` scope
4. **Save App Token**: Store as `SLACK_APP_TOKEN` environment variable

### 6. Install App to Workspace

1. Navigate to **Install App**
2. Click **"Install to Workspace"**
3. Review permissions and click **"Allow"**
4. **Copy Bot User OAuth Token**: Starts with `xoxb-`
5. **Store Token**: Save as `SLACK_BOT_TOKEN` environment variable

## Bot Configuration

### 7. App Manifest (Optional)

For consistent configuration, use this app manifest:

```yaml
display_information:
  name: Claude Code Bot
  description: AI-powered coding assistant with persistent conversations
  background_color: "#ff6b35"
features:
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: true
  bot_user:
    display_name: Claude Code Bot
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - files:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.im
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## User Experience

### Conversation Flow

The bot supports two main interaction patterns:

#### 1. Channel Mentions

Users mention the bot in any channel:

```
@peerbotai can you help me create a React component for user authentication?
```

**Bot Response:**
```
🤖 Claude is working on your request...

Worker Environment:
• Pod: claude-worker-auth-abc123
• CPU: 2000m Memory: 4Gi
• Timeout: 5 minutes
• Repository: user-john

GitHub Workspace:
• Repository: user-john
• 📝 Edit on GitHub.dev
• 🔄 Create Pull Request

Progress updates will appear below...
```

#### 2. Direct Messages

Users can send direct messages for private conversations:

```
DM: I need help debugging this Python script (shares file)
```

### Thread-Based Conversations

**Key Feature**: Each Slack thread becomes a persistent conversation.

- **New Thread**: Creates new Claude session
- **Reply to Thread**: Resumes existing conversation
- **Context Preservation**: Previous messages and code changes are remembered
- **5-Minute Sessions**: Each interaction gets a dedicated container

### Example Conversation Flow

```
User: @peerbotai Create a simple REST API in Python

Bot: 🤖 Claude is working on your request...
     [Shows worker details and GitHub links]

Bot: 🔧 Worker starting...
     Setting up workspace...

Bot: 📁 Workspace ready
     Repository cloned to /workspace/user-alice
     Starting Claude session...

Bot: 🔄 Working...
     Creating Flask API structure...

Bot: ✅ Session completed successfully!
     Duration: 45s
     
     I've created a simple REST API using Flask with:
     - User model and database setup
     - CRUD endpoints for users
     - Error handling and validation
     - Docker configuration
     
     📝 View changes on GitHub.dev
     🔄 Create Pull Request

User: (in same thread) Can you add authentication to this API?

Bot: 🤖 Resuming conversation...
     [Loads previous context and continues work]
```

## Advanced Configuration

### User Permissions

Control who can use the bot:

```yaml
# Helm values
slack:
  allowedUsers:
    - "U123456789"  # Slack user ID
    - "U987654321"
  allowedChannels:
    - "C123456789"  # Channel ID
    - "general"     # Channel name
  blockedUsers:
    - "U999999999"
```

### Custom Trigger Phrases

Change the trigger phrase:

```yaml
slack:
  triggerPhrase: "@codebot"  # Custom trigger
```

### Feature Toggles

Control bot features:

```yaml
slack:
  allowDirectMessages: true      # Enable DMs
  allowPrivateChannels: false    # Disable private channels
  enableStatusReactions: true    # Add emoji reactions
  enableProgressUpdates: true    # Stream progress updates
```

## User Onboarding

### Welcome Message

Create a welcome message for new users:

```markdown
👋 Welcome to Claude Code Bot!

**How to use:**
1. Mention @peerbotai in any channel or send a DM
2. Each thread becomes a persistent conversation
3. Your code is automatically saved to your GitHub repository
4. Continue conversations by replying to existing threads

**Example:**
@peerbotai help me create a React component for user authentication

**Your Resources:**
• GitHub Repository: https://github.com/peerbot-community/user-yourname
• Edit online: https://github.dev/peerbot-community/user-yourname

**Tips:**
- Sessions last 5 minutes with automatic timeout
- All changes are committed and can be reviewed via PR
- Share files by uploading them to Slack
- Ask follow-up questions in the same thread
```

### User Repository Setup

When a user first interacts with the bot:

1. **Repository Creation**: Automatic repository created as `user-{username}`
2. **Initial Structure**: README and basic project structure
3. **Permissions**: User gets admin access to their repository
4. **GitHub.dev Link**: Direct link for online editing

## Troubleshooting

### Common Issues

#### 1. Bot Not Responding

**Symptoms**: Bot doesn't respond to mentions
**Solutions**:
- Check bot is online in Slack workspace
- Verify `SLACK_BOT_TOKEN` is correct
- Check dispatcher pod logs: `kubectl logs deployment/peerbot-dispatcher`
- Ensure bot has required permissions

#### 2. Permission Errors

**Symptoms**: Bot responds with permission error
**Solutions**:
- Check OAuth scopes are correctly configured
- Verify bot is added to the channel
- Check user is in allowed users list (if configured)

#### 3. Worker Jobs Not Starting

**Symptoms**: Bot acknowledges request but no worker starts
**Solutions**:
- Check Kubernetes RBAC permissions
- Verify worker image exists and is accessible
- Check resource quotas in namespace
- View job creation logs in dispatcher

#### 4. GitHub Integration Issues

**Symptoms**: Repository creation or access errors
**Solutions**:
- Verify `GITHUB_TOKEN` has correct permissions
- Check GitHub organization exists and is accessible
- Ensure token has repo creation permissions

### Debug Commands

For debugging Slack integration:

```bash
# Check Slack app configuration
curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  https://slack.com/api/auth.test

# Test bot permissions
curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  https://slack.com/api/users.info?user=U123456789

# View recent messages (for debugging)
curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.history?channel=C123456789&limit=10"
```

### Log Analysis

Useful log patterns to watch for:

```bash
# Successful message handling
kubectl logs deployment/peerbot-dispatcher | grep "Handling request for session"

# Worker job creation
kubectl logs deployment/peerbot-dispatcher | grep "Created worker job"

# Slack API errors
kubectl logs deployment/peerbot-dispatcher | grep "Slack.*error"

# Session timeouts
kubectl logs deployment/peerbot-dispatcher | grep "timed out"
```

## Monitoring and Analytics

### Key Metrics

Track these metrics for Slack integration:

- **Message Volume**: Messages per hour/day
- **User Engagement**: Unique users per day
- **Session Duration**: Average worker execution time
- **Error Rate**: Failed requests vs successful
- **Thread Usage**: New threads vs continued conversations

### Slack Analytics

Monitor through Slack's built-in analytics:

1. Go to your app's **Analytics** page
2. Track **API calls** and **error rates**
3. Monitor **user engagement** metrics
4. Review **permission** usage patterns

### Custom Dashboards

Create monitoring dashboards tracking:

```yaml
# Prometheus metrics examples
peerbot_slack_messages_total{type="mention"}
peerbot_slack_messages_total{type="dm"}
peerbot_worker_jobs_created_total
peerbot_worker_jobs_completed_total
peerbot_session_duration_seconds
peerbot_github_repos_created_total
```

## Best Practices

### User Guidelines

Share these guidelines with your team:

1. **Use Threads**: Always reply in threads for context continuity
2. **Be Specific**: Provide clear, detailed requests
3. **Share Files**: Upload relevant files to Slack for Claude to analyze
4. **Review Changes**: Check the GitHub PR before merging
5. **Ask Follow-ups**: Continue the conversation in the same thread

### Channel Management

- **Dedicated Channel**: Consider a `#claude-code` channel for bot usage
- **Training Sessions**: Hold team training on effective bot usage
- **Guidelines Pinned**: Pin usage guidelines in relevant channels
- **Feedback Channel**: Create a feedback channel for bot improvements

### Security Considerations

- **Private Channels**: Be cautious with sensitive code in public channels
- **User Repositories**: Ensure users understand their repository visibility
- **Access Control**: Use allowedUsers for sensitive environments
- **Audit Logs**: Regularly review bot usage and access patterns

This integration provides a seamless experience for team-based AI-assisted coding with full conversation persistence and individual workspaces.