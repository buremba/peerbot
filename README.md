# Claude Code Slack

A powerful [Claude Code](https://claude.ai/code) Slack application that brings AI-powered programming assistance directly to your Slack workspace. Claude can answer questions, implement code changes, provide code reviews, and help with technical problems through natural Slack conversations.

## Features

- 🤖 **Interactive Code Assistant**: Claude can answer questions about code, architecture, and programming
- 🔍 **Code Review**: Analyzes code snippets and suggests improvements
- ✨ **Code Implementation**: Can implement fixes, refactoring, and new features
- 💬 **Slack Integration**: Works seamlessly with channels, threads, and direct messages
- 🛠️ **Flexible Tool Access**: Access to file operations and development tools
- 📋 **Real-time Updates**: Messages update in real-time as Claude works on your request
- 🎯 **Status Indicators**: Emoji reactions show work status (⏳ working, ✅ completed, ❌ error)
- 🧵 **Thread Support**: Maintains context in threaded conversations

## Quick Start

### Prerequisites

- A Slack workspace where you can install apps
- [Anthropic API key](https://console.anthropic.com/) for Claude access
- [Bun](https://bun.sh/) runtime installed

### 1. Create a Slack App

The easiest way is to use our pre-configured app manifest:

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"** → **"From an app manifest"**
3. Select your workspace
4. Copy the contents of [`examples-slack/app-manifest.json`](./examples-slack/app-manifest.json) and paste it
5. Review the configuration and click **"Create"**

### 2. Get Your Tokens

After creating the app:

1. **Bot User OAuth Token**: Go to **"OAuth & Permissions"** → copy the **"Bot User OAuth Token"** (starts with `xoxb-`)
2. **App-Level Token**: Go to **"Basic Information"** → **"App-Level Tokens"** → **"Generate Token and Scopes"**
   - Name: `socket_mode`
   - Scopes: `connections:write`
   - Copy the generated token (starts with `xapp-`)
3. **Signing Secret**: Go to **"Basic Information"** → copy the **"Signing Secret"**

### 3. Install the App

1. Go to **"OAuth & Permissions"** → **"Install to Workspace"**
2. Review permissions and click **"Allow"**
3. Invite the bot to channels where you want to use it: `/invite @Claude Code`

### 4. Set Up the Application

1. **Clone this repository:**
   ```bash
   git clone https://github.com/anthropics/claude-code-slack.git
   cd claude-code-slack
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and fill in your values:
   ```env
   SLACK_BOT_TOKEN=xoxb-your-bot-token-here
   SLACK_APP_TOKEN=xapp-your-app-token-here  
   SLACK_SIGNING_SECRET=your-signing-secret-here
   ANTHROPIC_API_KEY=sk-ant-your-anthropic-api-key-here
   ```

4. **Start the application:**
   ```bash
   bun run dev:slack
   ```

### 5. Test It Out

In any channel where the bot is present:

- **Mention the bot**: `@Claude Code help me debug this function`
- **Use trigger phrase**: `@claude can you review this code?`
- **Direct message**: Send a DM to the bot

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token from Slack |
| `SLACK_APP_TOKEN` | ✅ | App-Level Token for Socket Mode |
| `SLACK_SIGNING_SECRET` | ✅ | Signing Secret for request verification |
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `SLACK_TRIGGER_PHRASE` | ❌ | Custom trigger phrase (default: `@claude`) |
| `ENABLE_STATUS_REACTIONS` | ❌ | Enable emoji status indicators (default: `true`) |
| `ENABLE_PROGRESS_UPDATES` | ❌ | Enable real-time message updates (default: `true`) |

See [`.env.example`](./.env.example) for all available configuration options.

### Permissions and Access Control

Control who can use the bot and where:

```env
# Allow only specific users
SLACK_ALLOWED_USERS=U1234567890,U0987654321

# Block specific users
SLACK_BLOCKED_USERS=U1111111111

# Allow only specific channels
SLACK_ALLOWED_CHANNELS=C1234567890,C0987654321

# Block specific channels
SLACK_BLOCKED_CHANNELS=C1111111111

# Disable private channels (default: disabled)
SLACK_ALLOW_PRIVATE_CHANNELS=false

# Disable direct messages (default: enabled)
SLACK_ALLOW_DIRECT_MESSAGES=false
```

## How It Works

### Message Flow

1. **User mentions the bot** or uses the trigger phrase
2. **Status reaction** (⏳) is added to the user's message
3. **Initial response** is posted in thread with progress indicator
4. **Claude processes** the request with real-time updates
5. **Final result** is posted with cost/duration info
6. **Status emoji** changes to ✅ (success) or ❌ (error)

### Example Conversation

```
👤 User: @Claude Code can you help me optimize this Python function?

def slow_function(data):
    result = []
    for item in data:
        if item > 0:
            result.append(item * 2)
    return result

🤖 Claude Code: I'm working on your request... ⏳

[Real-time updates as Claude analyzes...]

🤖 Claude Code: I can help optimize that function! Here's an improved version:

```python
def optimized_function(data):
    return [item * 2 for item in data if item > 0]
```

This uses a list comprehension which is more pythonic and typically faster. For large datasets, you could also consider using NumPy:

```python
import numpy as np

def numpy_optimized(data):
    arr = np.array(data)
    return (arr[arr > 0] * 2).tolist()
```

✅ **Completed** | **Cost:** $0.0023 | **Duration:** 3.2s
```

## Advanced Usage

### Custom Instructions

Add custom behavior with the `CUSTOM_INSTRUCTIONS` environment variable:

```env
CUSTOM_INSTRUCTIONS="Always explain your reasoning and provide code examples. Focus on performance and best practices."
```

### Tool Configuration

Control what Claude can do:

```env
# Additional tools
ALLOWED_TOOLS=WebSearch,WebFetch

# Restricted tools  
DISALLOWED_TOOLS=Bash

# Enable GitHub file operations for code projects
INCLUDE_GITHUB_FILE_OPS=true
GITHUB_TOKEN=ghp_your-github-token-here
```

### Deployment Options

#### Development Mode
```bash
bun run dev:slack
```

#### Production Mode
```bash
bun run start:slack
```

#### HTTP Mode (instead of Socket Mode)
```env
SLACK_HTTP_MODE=true
PORT=3000
```

#### Docker Deployment
```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install
COPY . .

EXPOSE 3000
CMD ["bun", "run", "start:slack"]
```

## Troubleshooting

### Common Issues

**Bot doesn't respond to mentions:**
- Check that the bot is invited to the channel
- Verify `SLACK_BOT_TOKEN` is correct
- Ensure the app has `app_mentions:read` scope

**Socket Mode connection fails:**
- Verify `SLACK_APP_TOKEN` is set and valid
- Check that Socket Mode is enabled in your app settings
- Try HTTP mode as fallback with `SLACK_HTTP_MODE=true`

**Permission denied errors:**
- Review your app's OAuth scopes
- Check channel-specific permissions
- Verify the bot is properly installed in your workspace

### Debug Mode

Enable verbose logging:

```env
LOG_LEVEL=DEBUG
NODE_ENV=development
```

### Support

- 📚 [Slack API Documentation](https://api.slack.com/)
- 🔧 [Claude Code Documentation](https://docs.anthropic.com/claude/docs/claude-code)
- 🐛 [Report Issues](https://github.com/anthropics/claude-code-slack/issues)

## Migration from GitHub Actions

If you're migrating from the GitHub Actions version of Claude Code:

1. The core Claude functionality remains the same
2. Replace GitHub-specific triggers with Slack mentions
3. Update environment variables to use Slack tokens instead of GitHub tokens
4. Thread-based conversations replace PR comment chains
5. Emoji reactions replace GitHub status indicators

See the [migration guide](./docs/migration.md) for detailed steps.

## Contributing

We welcome contributions! Please see our [contributing guidelines](./CONTRIBUTING.md) for details.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.