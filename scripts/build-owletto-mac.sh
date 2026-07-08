#!/usr/bin/env bash
# Build Owletto.app with the same Developer ID identity as mac-release CI.
# TCC grants (Screen Recording, Accessibility, etc.) then match the notarized
# release — unlike a default Xcode Debug build (Apple Development cert).
#
# Usage:
#   make owletto-mac                  # build → /tmp/owletto-build/.../Owletto.app
#   make owletto-mac INSTALL=1        # also replace /Applications/Owletto.app
#   make owletto-mac INSTALL=1 OPEN=1 # install and launch
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/scripts/sync-owletto-submodule.sh"
MAC="$ROOT/packages/owletto/apps/mac"
DERIVED="${DERIVED:-/tmp/owletto-build}"
TEAM_ID="CCV9Q352W3"
SIGN_ID="Developer ID Application"

die() { echo "error: $*" >&2; exit 1; }

[ -f "$MAC/Owletto.xcodeproj/project.pbxproj" ] \
  || die "packages/owletto not initialized — run: git submodule update --init packages/owletto"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  die "$(cat <<EOF
No Developer ID Application cert in your login keychain.
  • Keychain Access → import the Developer ID .p12 (same cert as CI), or
  • Download it from developer.apple.com (team $TEAM_ID), or
  • For prod E2E only: install the release DMG instead of building locally
    https://github.com/lobu-ai/lobu/releases/latest/download/Owletto.dmg
EOF
)"
fi

echo ">> Building Owletto (Release, $SIGN_ID)..."
(
  cd "$MAC"
  xcodebuild -scheme Owletto -configuration Release \
    -derivedDataPath "$DERIVED" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="$SIGN_ID" \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    ENABLE_HARDENED_RUNTIME=YES \
    build
)

APP="$DERIVED/Build/Products/Release/Owletto.app"
[ -d "$APP" ] || die "build succeeded but $APP is missing"

# Xcode + SPM Sparkle: re-seal nested helpers (same leaf-first order as CI).
echo ">> Re-signing Sparkle helpers..."
SPARKLE="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
OPTS=(--force --options runtime --timestamp --sign "$SIGN_ID")

resign_xpc() {
  local name="$1"
  local dir="$SPARKLE/XPCServices/${name}.xpc"
  [ -d "$dir" ] || return 0
  codesign "${OPTS[@]}" "$dir/Contents/MacOS/$name"
  codesign "${OPTS[@]}" "$dir"
}

resign_xpc Downloader
resign_xpc Installer
if [ -d "$SPARKLE/Updater.app" ]; then
  codesign "${OPTS[@]}" "$SPARKLE/Updater.app/Contents/MacOS/Updater"
  codesign "${OPTS[@]}" "$SPARKLE/Updater.app"
fi
[ -f "$SPARKLE/Autoupdate" ] && codesign "${OPTS[@]}" "$SPARKLE/Autoupdate"
codesign "${OPTS[@]}" "$APP/Contents/Frameworks/Sparkle.framework"
codesign "${OPTS[@]}" "$APP"
codesign --verify --deep --strict "$APP"

echo ">> Built: $APP"

if [ "${INSTALL:-}" = "1" ]; then
  echo ">> Installing to /Applications/Owletto.app (quit Owletto first if it's running)"
  osascript -e 'tell application "Owletto" to quit' 2>/dev/null || true
  sleep 1
  rm -rf /Applications/Owletto.app
  cp -R "$APP" /Applications/Owletto.app
  echo ">> Installed: /Applications/Owletto.app"
fi

if [ "${OPEN:-}" = "1" ]; then
  if [ "${INSTALL:-}" = "1" ]; then
    open /Applications/Owletto.app
  else
    open "$APP"
  fi
fi