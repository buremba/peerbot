# review-skip.sh — safe-class diff classifier for the cross-harness review.
# shellcheck shell=bash
#
# REVIEWER_MODE=light (default) skips the cross-harness reviewer when the diff
# is small AND every changed file is in a class where an independent LLM review
# adds near-zero signal: docs, CI-verified generated output, exact renames
# between safe-class paths, or additive-only test changes. Everything else —
# non-test source, migrations,
# lockfiles, config, submodule pointer bumps, and the gate/CI machinery
# itself — forces the full review regardless of size.
#
# The classifier is deterministic and path-gated. The driving agent may only
# escalate (REVIEWER_MODE=full), never skip on self-assessed confidence: the
# whole point of the cross-harness review is independence from the authoring
# model's blind spots, and confidence is anti-correlated with exactly those.

# Output contract read by review.sh and the tests.
# shellcheck disable=SC2034
REVIEW_SKIP_REASON=""

# Any diff that touches these paths must run the full review, no matter how
# small. Submodule pointer bumps are escalated because a 2-line SHA delta can
# import an unbounded amount of behavior; lockfiles and config control the same
# subsystems (auth, queues, deps) that a src change would escalate on; and the
# gate machinery itself must never be reviewed by its own skip rule.
review_skip_hard_escalate() {
  local path="$1" mode
  case "$path" in
    scripts/review*|scripts/lib/review*|Makefile|makefile|.github/*) return 0 ;;
    db/migrations/*|db/schema.sql) return 0 ;;
    bun.lock|package-lock.json|yarn.lock|pnpm-lock.yaml|*.lock) return 0 ;;
    package.json) return 0 ;;
    *.toml|*.yaml|*.yml|config/*|.env*|.gitmodules) return 0 ;;
  esac
  # Submodule pointer: the stage entry carries mode 160000. git diff reports the
  # submodule path like any other file, so classify it from the index.
  mode="$(git ls-files --stage -- "$path" 2>/dev/null | awk 'NR==1 {print $1}')"
  if [ "$mode" = "160000" ]; then
    return 0
  fi
  return 1
}

review_skip_is_test_path() {
  case "$1" in
    *__tests__*) return 0 ;;
  esac
  case "$1" in
    *.test.ts) return 0 ;;
    *.test.tsx) return 0 ;;
    *.test.js) return 0 ;;
    *.test.jsx) return 0 ;;
  esac
  return 1
}

# review_classify_diff <base>
# Returns 0 when the cross-harness review may be skipped, setting
# REVIEW_SKIP_REASON; returns 1 when the full review is required.
review_classify_diff() {
  local base="$1" total status p1 p2 path del saw_file exact_rename
  REVIEW_SKIP_REASON=""
  saw_file=0

  # -M100% pins rename detection to exact content matches regardless of the
  # user's diff.renames config, so the line count is deterministic.
  total="$(git diff --numstat -M100% "$base"...HEAD 2>/dev/null | awk '{a+=$1; d+=$2} END {print a+d}')"
  [ -n "$total" ] || total=0
  if [ "$total" -ge 100 ]; then
    REVIEW_SKIP_REASON="diff too large ($total lines)"
    return 1
  fi

  # --name-status with exact-only rename detection (-M100%): a rename reports
  # BOTH sides, and both must be safe-class — otherwise `git mv src/x.ts x.md`
  # would hide a source deletion behind a docs-looking destination. NOTE:
  # -M100 without the % is a ~10% similarity threshold, which would also pair
  # a mostly-rewritten delete/add across classes; exact-only keeps every
  # content change visible under its real path.
  while IFS=$'\t' read -r status p1 p2; do
    [ -n "$p1" ] || continue
    saw_file=1
    exact_rename=0
    case "$status" in
      R*) exact_rename=1 ;;
    esac

    for path in "$p1" ${p2:+"$p2"}; do
      if review_skip_hard_escalate "$path"; then
        REVIEW_SKIP_REASON="touches '$path'"
        return 1
      fi

      case "$path" in
        *.md|README*|LICENSE|docs/*) continue ;;                               # docs: safe
        packages/owletto/src/routeTree.gen.ts|*/dist/*) continue ;;            # generated: safe
      esac
      if review_skip_is_test_path "$path"; then
        # An exact rename changes no content, so no assertion can have moved.
        if [ "$exact_rename" = "1" ]; then
          continue
        fi
        # Additive-only tests are safe; a test change that deletes or rewrites
        # assertions is exactly where regressions hide, so it escalates.
        del="$(git diff --numstat "$base"...HEAD -- "$path" 2>/dev/null | awk 'NR==1 {print $2}')"
        if [ "${del:-0}" -eq 0 ]; then
          continue
        fi
        REVIEW_SKIP_REASON="test change deletes/changes assertions in '$path'"
        return 1
      fi
      REVIEW_SKIP_REASON="unclassified file '$path'"
      return 1
    done
  done < <(git diff --name-status -M100% "$base"...HEAD 2>/dev/null)

  if [ "$saw_file" = "0" ]; then
    REVIEW_SKIP_REASON="no diff against $base"
  else
    REVIEW_SKIP_REASON="small safe-class diff ($total lines, docs/renames/generated/additive-tests only)"
  fi
  return 0
}
