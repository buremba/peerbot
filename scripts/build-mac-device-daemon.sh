#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/packages/connector-worker/src/mac-device-daemon.ts"
OUTPUT="${OUTPUT:-$ROOT/.tmp/mac-device-daemon/lobu-device-daemon}"

mkdir -p "$(dirname "$OUTPUT")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"

die() { echo "error: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "Mac device-daemon builds require macOS"
[[ "$(uname -m)" == "arm64" ]] || die "Mac device-daemon builds require an arm64 Mac mini"
command -v bun >/dev/null 2>&1 || die "bun is required only while building the standalone artifact"

BUILD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/lobu-device-daemon-build.XXXXXX")"
ARTIFACT_TMP="$OUTPUT.tmp.$$"
trap 'rm -rf "$BUILD_TMP" "$ARTIFACT_TMP"' EXIT
META="$BUILD_TMP/metafile.json"
GRAPH_BUNDLE="$BUILD_TMP/graph.js"

(
  cd "$BUILD_TMP"
  bun build "$ENTRY" \
    --target=bun \
    --metafile="$META" \
    --outfile="$GRAPH_BUNDLE"
)

bun "$ROOT/scripts/check-mac-device-daemon-graph.mjs" "$META"

(
  cd "$BUILD_TMP"
  bun build "$ENTRY" \
    --compile \
    --target=bun-darwin-arm64 \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --no-compile-autoload-package-json \
    --outfile="$ARTIFACT_TMP"
)

chmod 0755 "$ARTIFACT_TMP"
mv -f "$ARTIFACT_TMP" "$OUTPUT"
file "$OUTPUT"
stat -f 'artifact_bytes=%z' "$OUTPUT"
echo "artifact=$OUTPUT"
