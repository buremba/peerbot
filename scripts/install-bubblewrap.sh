#!/usr/bin/env bash
# Install bubblewrap for the worker exec-sandbox and prove it delivers real
# isolation on this runner.
#
# Why this is a script and not three inline `run:` blocks: the `unit`,
# `sdk-e2e`, and `cli-smoke` jobs all need bwrap, and the unit job now runs the
# escape matrix under LOBU_REQUIRE_EXEC_SANDBOX=1 (a missing bwrap is a test
# failure, not a silent skip). Keeping one copy means the retry policy and the
# AppArmor workaround can't drift apart between jobs.
set -euo pipefail

# apt mirrors flake. Because a failed install is now a RED build rather than a
# silent skip, retry to keep that rare — then fail loudly instead of falling
# through to the test steps with no sandbox.
installed=""
for attempt in 1 2 3; do
  if sudo apt-get update && sudo apt-get install -y bubblewrap coreutils; then
    installed=1
    break
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "apt-get failed (attempt $attempt/3); retrying in $((attempt * 5))s"
    sleep $((attempt * 5))
  fi
done
if [ -z "$installed" ]; then
  echo "::error::bubblewrap install failed after 3 attempts"
  exit 1
fi

# Only flip the AppArmor userns restriction when the kernel exposes it
# (GitHub-hosted ubuntu-24.04). Blacksmith's Firecracker microVMs don't
# restrict unprivileged user namespaces and lack this sysctl key.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi

bwrap --version

# The userns probe is opt-in ($1 == "probe"). Only the unit job runs the escape
# matrix, and only it probed before this script existed; sdk-e2e and cli-smoke
# just need the binary present. Enabling the probe everywhere would newly fail
# those jobs on any runner where unsharing is restricted — a behaviour change
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
