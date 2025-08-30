#!/bin/bash

set -e

# Peerbot Integration Feature Installation Script

echo "Installing Peerbot Worker Integration..."

# Install Claude Code CLI globally
echo "Installing Claude Code CLI..."
npm install -g "@anthropic-ai/claude-code@${VERSION:-latest}"

# Verify installation
if ! command -v claude >/dev/null 2>&1; then
    echo "❌ Error: Claude CLI installation failed"
    exit 1
fi

# Setup git configuration for peerbot workers
echo "Configuring git for Peerbot workers..."
git config --global user.name "Claude Code Worker" 2>/dev/null || true
git config --global user.email "claude-code-worker@noreply.github.com" 2>/dev/null || true
git config --global init.defaultBranch main 2>/dev/null || true
git config --global pull.rebase false 2>/dev/null || true
git config --global safe.directory '*' 2>/dev/null || true

# Create peerbot directories
mkdir -p /app/packages
mkdir -p /home/${_REMOTE_USER:-vscode}/.claude

echo "✅ Peerbot Integration feature installed successfully"