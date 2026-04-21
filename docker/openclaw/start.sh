#!/bin/sh
set -eu

OPENCLAW_HOME="${HOME:-/home/openclaw}/.openclaw"
DEFAULTS_DIR="/usr/local/share/openclaw"
EXTENSION_DIR="$OPENCLAW_HOME/extensions/openclaw-owletto"

mkdir -p "$OPENCLAW_HOME" "$EXTENSION_DIR/dist"

if [ ! -f "$OPENCLAW_HOME/openclaw.json" ]; then
  cp "$DEFAULTS_DIR/openclaw.json" "$OPENCLAW_HOME/openclaw.json"
fi

if [ ! -f "$EXTENSION_DIR/openclaw.plugin.json" ]; then
  cp "$DEFAULTS_DIR/openclaw-owletto/openclaw.plugin.json" "$EXTENSION_DIR/openclaw.plugin.json"
fi

if [ ! -e "$EXTENSION_DIR/dist/index.js" ]; then
  cp -R "$DEFAULTS_DIR/openclaw-owletto/dist/." "$EXTENSION_DIR/dist/"
fi

exec openclaw gateway --port "${OPENCLAW_GATEWAY_PORT:-18789}"
