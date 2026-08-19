#!/usr/bin/env bash
#
# Regression tests for scripts/install-bubblewrap.sh.
#
# The script guards a security control: `unit` runs the exec-sandbox escape
# matrix under LOBU_REQUIRE_EXEC_SANDBOX=1, so a bwrap that quietly fails to
# install must turn the build RED. The layered install added for the apt-mirror
# hang gave that property three new ways to regress silently — a cache path
# that swallows a failure, or a best-effort stash that sinks a good install —
# so each layer is pinned here.
#
# Everything runs against stubs on PATH. Nothing here touches apt or the
# network, which is the same property the script is trying to buy in CI.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="$repo_root/scripts/install-bubblewrap.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

# A sandbox with stub bin/ and cache/ per case, so cases cannot leak into
# each other through an installed binary or a left-over .deb.
setup_case() {
  work="$(mktemp -d)"
  mkdir -p "$work/bin" "$work/cache" "$work/real" "$work/archives"
  cat > "$work/real/bwrap" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "bubblewrap 0.0.0 (stub)"; exit 0; }
exit 0
EOF
  chmod +x "$work/real/bwrap"
  cat > "$work/bin/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
  cat > "$work/bin/timeout" <<'EOF'
#!/usr/bin/env bash
shift; exec "$@"
EOF
  # A test must never flip a real kernel sysctl. On Linux the apparmor flag
  # EXISTS, so the script takes that branch and `sudo sysctl` would run for
  # real — stub it, and point the script at a fake flag file so the branch is
  # exercised identically on macOS and Linux.
  cat > "$work/bin/sysctl" <<'EOF'
#!/usr/bin/env bash
echo "sysctl(stub) $*"
EOF
  chmod +x "$work/bin/sudo" "$work/bin/timeout" "$work/bin/sysctl"
  : > "$work/apparmor_flag"
}

run_script() {
  set +e
  out="$(PATH="$work/bin:/usr/bin:/bin" BWRAP_DEB_CACHE="$work/cache" \
    APT_ARCHIVES_DIR="$work/archives" APPARMOR_USERNS_FLAG="$work/apparmor_flag" \
    bash "$script" probe 2>&1)"
  rc=$?
  set -e
}

# --- 1. bwrap already on PATH: install must be skipped entirely -------------
setup_case
cp "$work/real/bwrap" "$work/bin/bwrap"
cat > "$work/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo "REACHED_APT"; exit 0
EOF
chmod +x "$work/bin/apt-get"
run_script
[ "$rc" -eq 0 ] || fail "preinstalled: expected pass, got $rc: $out"
case "$out" in *"already present"*) ;; *) fail "preinstalled: no skip message: $out";; esac
case "$out" in *REACHED_APT*) fail "preinstalled: apt was invoked anyway: $out";; esac
# The apparmor branch is Linux-only in production; assert it ran here so the
# seam cannot rot into an untested path again.
case "$out" in *"sysctl(stub)"*) ;; *) fail "preinstalled: apparmor branch never ran: $out";; esac
echo "ok: a preinstalled bwrap skips the install"

# --- 2. cached .deb: dpkg installs it and apt is never reached --------------
# This is the steady state the cache exists to produce. If apt is reached here,
# the mirror hang is back in the critical path and the fix is worthless.
setup_case
echo "stub" > "$work/cache/bubblewrap_1.2.3_amd64.deb"
cat > "$work/bin/dpkg" <<EOF
#!/usr/bin/env bash
[ "\$1" = "-i" ] && { cp "$work/real/bwrap" "$work/bin/bwrap"; exit 0; }
exit 1
EOF
cat > "$work/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo "REACHED_APT"; exit 0
EOF
chmod +x "$work/bin/dpkg" "$work/bin/apt-get"
run_script
[ "$rc" -eq 0 ] || fail "cached: expected pass, got $rc: $out"
case "$out" in *"no network"*) ;; *) fail "cached: did not use the cache: $out";; esac
case "$out" in *REACHED_APT*) fail "cached: apt reached despite a cache hit: $out";; esac
echo "ok: a cached .deb installs without touching apt"

# --- 3. nothing works: must FAIL CLOSED -------------------------------------
# The whole point. A green job with no bwrap means the escape matrix
# describe.skip()s itself and containment stops being verified, unnoticed.
setup_case
cat > "$work/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo "simulated mirror failure" >&2; exit 1
EOF
chmod +x "$work/bin/apt-get"
run_script
[ "$rc" -ne 0 ] || fail "exhausted: expected FAILURE, got pass — bwrap would silently vanish: $out"
case "$out" in *"::error::"*) ;; *) fail "exhausted: no ::error:: annotation: $out";; esac
echo "ok: an unavailable bwrap fails the build closed"

# --- 4. apt succeeds but the cache is unwritable: install must still pass ----
# The stash is an optimisation. `set -e` on a bare `cp && chown` would let a
# read-only cache dir turn a perfectly good install red.
setup_case
# Without a .deb here the stash loop never runs and this case asserts nothing —
# it passed against a deliberately reverted `cp && chown` until this line existed.
echo "stub" > "$work/archives/bubblewrap_1.2.3_amd64.deb"
chmod 500 "$work/cache"
cat > "$work/bin/apt-get" <<EOF
#!/usr/bin/env bash
[ "\$1" = "update" ] && exit 0
cp "$work/real/bwrap" "$work/bin/bwrap"
exit 0
EOF
chmod +x "$work/bin/apt-get"
run_script
chmod 700 "$work/cache"
[ "$rc" -eq 0 ] || fail "unwritable cache: a best-effort stash failed the install: $out"
echo "ok: a failed cache stash does not fail a good install"

echo "install-bubblewrap.test.sh: all cases passed"
