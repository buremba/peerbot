#!/bin/bash
set -e

echo "🚀 Setting up Claude Code Slack Bot development environment..."

# Install Bun JavaScript runtime
echo "📦 Installing Bun..."
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Add Bun to PATH for current session
export PATH="$HOME/.bun/bin:$PATH"

# Install Claude Code CLI
echo "🤖 Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# Verify installations
echo "✅ Verifying tool installations..."
echo "  Node.js: $(node --version)"
echo "  npm: $(npm --version)"
echo "  Bun: $(bun --version)"
echo "  Python: $(python3 --version)"
echo "  uv: $(uv --version)"
echo "  Git: $(git --version)"

# Check if Claude Code CLI is available
if command -v claude &> /dev/null; then
    echo "  Claude Code CLI: $(claude --version)"
else
    echo "  ⚠️  Claude Code CLI installation may need manual setup"
fi

# Install project dependencies
echo "📦 Installing project dependencies..."
bun install

# Install git hooks if script exists
if [ -f "./scripts/install-hooks.sh" ]; then
    echo "🔧 Setting up git hooks..."
    bash ./scripts/install-hooks.sh
fi

# Configure git for container
echo "🔧 Configuring git for container environment..."
git config --global --add safe.directory /workspaces/*
git config --global init.defaultBranch main

# Create useful aliases
echo "🛠️  Creating development aliases..."
cat >> ~/.bashrc << 'EOF'

# Claude Code Slack Bot development aliases
alias ll='ls -la'
alias ..='cd ..'
alias dev='make dev'
alias test='bun test'
alias fmt='bun run format'
alias typecheck='bun run typecheck'
alias slack='bun run dev:slack'

# Helpful function to rebuild core-runner when needed
rebuild-core() {
    echo "Rebuilding core-runner..."
    cd packages/core-runner && bun run build && cd ../..
}
EOF

echo "🎉 Development environment setup complete!"
echo ""
echo "📚 Quick commands:"
echo "  make dev          - Start Skaffold in development mode"
echo "  bun test          - Run tests"
echo "  bun run typecheck - Type check"
echo "  bun run format    - Format code"
echo "  ./test-bot.js     - Test bot functionality"
echo ""
echo "📖 See .devcontainer/README.md for detailed documentation"