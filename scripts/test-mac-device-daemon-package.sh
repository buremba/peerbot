#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(uname -s)" == "Darwin" ]] || { echo "error: Mac packaging smoke requires macOS" >&2; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || { echo "error: Mac packaging smoke requires arm64" >&2; exit 1; }

WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lobu-device-daemon-smoke.XXXXXX")"
WORK="$WORK_ROOT/work with spaces"
mkdir -p "$WORK"
trap 'rm -rf "$WORK_ROOT"' EXIT
ARTIFACT="$WORK/build/lobu-device-daemon"
CLEAN="$WORK/clean"
mkdir -p "$CLEAN"

OUTPUT="$ARTIFACT" "$ROOT/scripts/build-mac-device-daemon.sh" >"$WORK/build.log"
cp "$ARTIFACT" "$CLEAN/lobu-device-daemon"
chmod 0755 "$CLEAN/lobu-device-daemon"

file "$CLEAN/lobu-device-daemon" | grep -q 'Mach-O 64-bit executable arm64'
[[ "$(find "$CLEAN" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" == 1 ]]

SAFE_ENV=(env -i PATH=/usr/bin:/bin HOME="$WORK/home" TMPDIR="$WORK/tmp")
mkdir -p "$WORK/home" "$WORK/tmp"

run_clean() (
  cd "$CLEAN"
  "${SAFE_ENV[@]}" "$@"
)

run_clean_with_token() (
  cd "$CLEAN"
  "${SAFE_ENV[@]}" WORKER_API_TOKEN=not-a-pat ./lobu-device-daemon "$@"
)

VERSION_JSON="$(run_clean ./lobu-device-daemon --version)"
case "$VERSION_JSON" in
  *'"name":"lobu-device-daemon"'*'"protocol":"device-daemon/v1"'*'"platform":"macos"'*) ;;
  *) echo "error: --version did not emit expected metadata: $VERSION_JSON" >&2; exit 1 ;;
esac

run_clean ./lobu-device-daemon --help | grep -q 'Usage:'

if run_clean ./lobu-device-daemon >/dev/null 2>"$WORK/missing-config.err"; then
  echo "error: missing launch configuration unexpectedly succeeded" >&2
  exit 1
fi
grep -q -- '--api-url or API_URL is required' "$WORK/missing-config.err"

if run_clean_with_token --api-url https://example.test >/dev/null 2>"$WORK/invalid-token.err"; then
  echo "error: invalid PAT unexpectedly succeeded" >&2
  exit 1
fi
grep -q 'owl_pat_' "$WORK/invalid-token.err"

NO_POLL_JSON="$(run_clean ./lobu-device-daemon --no-poll)"
[[ "$NO_POLL_JSON" == "$VERSION_JSON" ]]

echo "Mac device-daemon package smoke passed"
echo "$VERSION_JSON"
stat -f 'artifact_bytes=%z' "$CLEAN/lobu-device-daemon"
