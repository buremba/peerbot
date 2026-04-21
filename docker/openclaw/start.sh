#!/bin/sh
set -eu

OPENCLAW_HOME="${HOME:-/home/openclaw}/.openclaw"
DEFAULTS_DIR="/usr/local/share/openclaw"
EXTENSION_DIR="$OPENCLAW_HOME/extensions/openclaw-owletto"

mkdir -p "$OPENCLAW_HOME" "$EXTENSION_DIR/dist"

if [ ! -f "$OPENCLAW_HOME/openclaw.json" ]; then
  cp "$DEFAULTS_DIR/openclaw.json" "$OPENCLAW_HOME/openclaw.json"
fi

# Apply the configured gateway token to the persisted config on every startup
# so compose/env rotations actually reach the running gateway.
if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  python3 - "$OPENCLAW_HOME/openclaw.json" "$OPENCLAW_GATEWAY_TOKEN" <<'PY'
import json, sys
path, token = sys.argv[1], sys.argv[2]
with open(path) as fh:
    cfg = json.load(fh)
cfg.setdefault("gateway", {}).setdefault("auth", {})["token"] = token
cfg["gateway"]["auth"].setdefault("mode", "token")
with open(path, "w") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")
PY
fi

# Always refresh plugin manifest + dist from the image so rebuilds ship new
# plugin code even though ../data/openclaw is a persistent bind mount.
cp "$DEFAULTS_DIR/openclaw-owletto/openclaw.plugin.json" "$EXTENSION_DIR/openclaw.plugin.json"
rm -rf "$EXTENSION_DIR/dist"
mkdir -p "$EXTENSION_DIR/dist"
cp -R "$DEFAULTS_DIR/openclaw-owletto/dist/." "$EXTENSION_DIR/dist/"

exec openclaw gateway --port "${OPENCLAW_GATEWAY_PORT:-18789}"
