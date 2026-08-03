#!/bin/sh
set -eu

chart_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
orchestrator="$chart_dir/files/migrate-upgrade.sh"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

command_log="$test_dir/kubectl.log"
migration_log="$test_dir/migration.log"
cat >"$test_dir/kubectl" <<'KUBECTL'
#!/bin/sh
set -eu
if [ "${1:-}" = '--namespace' ]; then
  shift 2
fi
printf '%s\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  "get deployment lobu-app --ignore-not-found --output jsonpath={.spec.replicas}")
    if [ "${FAIL_DEPLOYMENT_LOOKUP:-0}" -eq 1 ]; then
      exit 19
    fi
    printf '2'
    ;;
  "get deployment lobu-worker --ignore-not-found --output jsonpath={.spec.replicas}") printf '3' ;;
  get\ pods*)
    if [ "${FAIL_POD_LOOKUP:-0}" -eq 1 ]; then
      exit 17
    fi
    ;;
esac
KUBECTL
chmod +x "$test_dir/kubectl"

cat >"$test_dir/migrate" <<'MIGRATE'
#!/bin/sh
printf 'migrate\n' >>"$MIGRATION_LOG"
exit "${MIGRATION_EXIT_CODE:-0}"
MIGRATE
chmod +x "$test_dir/migrate"

set +e
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
MIGRATION_EXIT_CODE=42 \
  sh "$orchestrator" "$test_dir/migrate"
failure_status=$?
set -e

test "$failure_status" -eq 42
grep -Fxq 'scale deployment lobu-app --replicas=0' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=0' "$command_log"
grep -Fxq 'scale deployment lobu-app --replicas=2' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=3' "$command_log"

: >"$command_log"
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
MIGRATION_EXIT_CODE=0 \
  sh "$orchestrator" "$test_dir/migrate"

grep -Fxq 'scale deployment lobu-app --replicas=0' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=0' "$command_log"
if grep -Eq -- '--replicas=[23]$' "$command_log"; then
  echo 'successful migration unexpectedly restored old replicas' >&2
  exit 1
fi

: >"$command_log"
set +e
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
FAIL_POD_LOOKUP=1 \
  sh "$orchestrator" "$test_dir/migrate"
lookup_status=$?
set -e

test "$lookup_status" -eq 17
grep -Fxq 'scale deployment lobu-app --replicas=2' "$command_log"
grep -Fxq 'scale deployment lobu-worker --replicas=3' "$command_log"

: >"$command_log"
: >"$migration_log"
set +e
COMMAND_LOG="$command_log" \
MIGRATION_LOG="$migration_log" \
KUBECTL_BIN="$test_dir/kubectl" \
NAMESPACE=lobu \
APP_DEPLOYMENT=lobu-app \
APP_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=api' \
WORKER_DEPLOYMENT=lobu-worker \
WORKER_SELECTOR='app.kubernetes.io/instance=lobu,app.kubernetes.io/component=worker' \
FAIL_DEPLOYMENT_LOOKUP=1 \
  sh "$orchestrator" "$test_dir/migrate"
lookup_status=$?
set -e

test "$lookup_status" -eq 19
test ! -s "$migration_log"
if grep -q '^scale deployment' "$command_log"; then
  echo 'deployment lookup failure unexpectedly scaled a deployment' >&2
  exit 1
fi

echo 'migration upgrade failure recovery passed'
