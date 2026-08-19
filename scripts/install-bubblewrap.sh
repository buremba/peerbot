#!/usr/bin/env bash
# Install bubblewrap for the worker exec-sandbox and prove it delivers real
# isolation on this runner.
#
# Why this is a script and not an inline `run:` block: the unit job runs the
# escape matrix under LOBU_REQUIRE_EXEC_SANDBOX=1 (a missing bwrap is a test
# failure, not a silent skip), so the retry policy and the AppArmor workaround
# have to live in one place.
#
# Install strategy is layered, cheapest first, because apt is the ONLY step
# here that can fail and it fails by HANGING. #2894 made the stalled azure
# mirror fail fast, and it worked — but apt then fell through to
# archive.ubuntu.com, which stalled MID-TRANSFER on 126 kB InRelease files.
# `Acquire::http::Timeout` is a connect/response timeout; it does not abort a
# connection that is still trickling. So each attempt burned its full timeout
# and the retry loop simply did that three times: a 12m37s red build that never
# reached a test. Retrying harder cannot fix a hang — the fix is to stop
# needing the network at all.
set -euo pipefail

CACHE_DIR="${BWRAP_DEB_CACHE:-$HOME/.cache/lobu-bwrap}"
# Overridable so the stash path is reachable from the test suite; apt itself
# always writes here.
APT_ARCHIVES="${APT_ARCHIVES_DIR:-/var/cache/apt/archives}"
mkdir -p "$CACHE_DIR"

have_bwrap() { command -v bwrap >/dev/null 2>&1; }

# --- Layer 1: already installed -------------------------------------------
# Runner images change; if a future one ships bubblewrap we should pay nothing.
if have_bwrap; then
  echo "bwrap already present at $(command -v bwrap) — no install needed"
fi

# --- Layer 2: cached .deb (the steady state: NO network at all) ------------
if ! have_bwrap; then
  cached=$(find "$CACHE_DIR" -maxdepth 1 -name 'bubblewrap_*.deb' 2>/dev/null | head -1)
  if [ -n "$cached" ]; then
    echo "installing bwrap from cached $(basename "$cached") (no network)"
    sudo dpkg -i "$cached" || echo "cached .deb rejected; falling through to apt"
  fi
fi

# --- Layer 3: apt, and stash the .deb so layer 2 wins next time ------------
# Timeouts are per-attempt and deliberately tighter than the old 240s/300s: a
# stalled mirror should cost seconds of the budget, not minutes. Three attempts
# at 90s+90s caps the worst case near 9 minutes of the old 12m37s, and the
# cache means the common run never gets here.
if ! have_bwrap; then
  APT_FLAGS="-o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o Acquire::ftp::Timeout=15"
  for attempt in 1 2 3; do
    if sudo timeout 90 apt-get update $APT_FLAGS \
        && sudo timeout 90 apt-get install $APT_FLAGS -y --no-install-recommends bubblewrap; then
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      echo "apt-get failed (attempt $attempt/3); retrying in $((attempt * 5))s"
      sleep $((attempt * 5))
    fi
  done

  # Best-effort: keep the .deb for the next run. apt may have auto-cleaned it,
  # which is why this never gates the install.
  # The stash is an optimisation and must never turn a SUCCESSFUL install into a
  # red build. Note `set -e` alone does NOT give you that: POSIX exempts every
  # command in an `&&` list except the last, so a failing `cp && chown` does not
  # abort — but a bare `sudo cp` on its own line WOULD. Guarding explicitly means
  # the property survives someone later unfolding this into simple commands, and
  # keeps a permission error out of the log where it reads as a real failure.
  for deb in "$APT_ARCHIVES"/bubblewrap_*.deb; do
    [ -e "$deb" ] || continue
    if sudo cp "$deb" "$CACHE_DIR/" 2>/dev/null; then
      sudo chown "$(id -u):$(id -g)" "$CACHE_DIR/$(basename "$deb")" 2>/dev/null || true
      echo "cached $(basename "$deb") for future runs"
    fi || true
  done
fi

if ! have_bwrap; then
  echo "::error::bubblewrap unavailable after cache and 3 apt attempts"
  exit 1
fi

# `coreutils` used to be installed alongside; it is present on every Ubuntu
# runner image, so asking apt for it only widened the window this script exists
# to close.

# Only flip the AppArmor userns restriction when the runner kernel exposes it.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi

bwrap --version

# The userns probe is opt-in ($1 == "probe"). Only the unit job runs the escape
# matrix, and only it probed before this script existed; the deep-smoke job just
# needs the binary present. Enabling the probe there would newly fail it on any
# runner where unsharing is restricted — a runtime change
# this refactor has no business making.
if [ "${1:-}" = "probe" ]; then
  # Same unshare flags production uses (exec-sandbox.ts), so a runner that can
  # install bwrap but not actually unshare fails here — loudly — rather than
  # inside the escape matrix.
  bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-net \
    --ro-bind / / \
    --proc /proc --dev /dev \
    -- /usr/bin/true && echo "bwrap userns OK"
fi
