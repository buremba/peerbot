#!/usr/bin/env node
/**
 * Prove that a PR GitHub calls "merged" actually reached `main`.
 *
 * PR #2273 ("fix(agent-worker): match package installs only at a command
 * position") was opened against `feat/nix-deny-list-gap` rather than `main`.
 * When that base branch was squashed away, GitHub marked #2273 MERGED and
 * deleted the branch — so the PR reads as shipped, the fix is absent from
 * `main`, and issue #2279 stayed open describing the exact bug the PR claimed
 * to fix. Every required check was green; none of them ask the one question
 * that mattered.
 *
 * Two complementary gates, because prevention and detection fail differently:
 *
 *   base    a PR whose base is not `main` cannot be trusted to land on `main`.
 *           Blocks pre-merge. Escape hatch: the `stacked-pr` label, which
 *           forces a human to say "yes, I know this stacks".
 *   reach   after a merge, assert the merge commit is an ancestor of
 *           origin/main. Catches whatever the base gate did not.
 *
 * The classification is pure and takes an `isAncestor` predicate so the
 * decision table is unit-testable without git or network.
 *
 * Usage:
 *   check-merge-integrity.mjs base   --base <ref> [--labels-json '["name"]']
 *   check-merge-integrity.mjs reach  --pr <number>
 *   check-merge-integrity.mjs reach  --sweep [--limit 100]
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STACKED_PR_LABEL = "stacked-pr";

export const CANONICAL_BASE = "main";

/**
 * Decide whether a PR's base branch is acceptable.
 *
 * @param {string} baseRef branch the PR merges INTO
 * @param {string[]} labels labels currently on the PR
 * @returns {{ok: boolean, reason: string}}
 */
export function checkBaseBranch(baseRef, labels = []) {
  if (baseRef === CANONICAL_BASE) {
    return { ok: true, reason: `base is ${CANONICAL_BASE}` };
  }
  if (labels.includes(STACKED_PR_LABEL)) {
    return {
      ok: true,
      reason: `base is '${baseRef}' but '${STACKED_PR_LABEL}' label acknowledges the stack`,
    };
  }
  return {
    ok: false,
    reason:
      `base is '${baseRef}', not '${CANONICAL_BASE}'. When the base branch is ` +
      `squashed away, GitHub marks this PR MERGED while its commits never ` +
      `reach ${CANONICAL_BASE} (see #2273).`,
  };
}

/**
 * Classify merged PRs and decide whether every merge commit is provably
 * reachable from main.
 *
 * @param {Array<{number:number,title:string,baseRefName:string,mergeCommit:{oid:string}|null}>} prs
 * @param {(sha: string) => boolean} isAncestor
 */
export function classifyMergedPrs(prs, isAncestor) {
  const lost = [];
  const ok = [];
  const unknown = [];
  for (const pr of prs) {
    const sha = pr.mergeCommit?.oid;
    if (!sha) {
      // A merged PR with no merge commit predates the data or was merged by
      // a path the API does not record. Surface it rather than pass it.
      unknown.push(pr);
      continue;
    }
    (isAncestor(sha) ? ok : lost).push({ ...pr, sha });
  }
  return {
    lost,
    ok,
    unknown,
    passed: lost.length === 0 && unknown.length === 0,
  };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** git merge-base --is-ancestor exits 1 for "not an ancestor" — not an error. */
function makeIsAncestor(ref) {
  return (sha) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, ref], {
        stdio: "ignore",
      });
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 1
      ) {
        return false;
      }
      throw error;
    }
  };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function runBase(argv) {
  const baseRef = arg(argv, "base");
  if (!baseRef) {
    console.error("::error::--base <ref> is required");
    process.exit(2);
  }
  let labels;
  try {
    labels = JSON.parse(arg(argv, "labels-json") ?? "[]");
  } catch {
    console.error("::error::--labels-json must be a JSON array of strings");
    process.exit(2);
  }
  if (
    !Array.isArray(labels) ||
    labels.some((label) => typeof label !== "string")
  ) {
    console.error("::error::--labels-json must be a JSON array of strings");
    process.exit(2);
  }

  const { ok, reason } = checkBaseBranch(baseRef, labels);
  if (ok) {
    console.log(`Base branch OK — ${reason}`);
    return;
  }
  console.error(`::error::PR ${reason}`);
  console.error("");
  console.error("Fix: retarget this PR at main.");
  console.error("  git rebase --onto origin/main <old-base> <this-branch>");
  console.error(`  gh pr edit <n> --base ${CANONICAL_BASE}`);
  console.error("");
  console.error(
    `If the stack is deliberate, add the '${STACKED_PR_LABEL}' label and ` +
      "confirm the parent lands first."
  );
  process.exit(1);
}

function runReach(argv) {
  const single = arg(argv, "pr");
  const sweep = argv.includes("--sweep");
  if (Boolean(single) === sweep) {
    console.error("::error::reach requires exactly one of --pr or --sweep");
    process.exit(2);
  }

  // origin/main goes stale in a shallow CI checkout; the fetch is load-bearing.
  git(["fetch", "--quiet", "origin", CANONICAL_BASE]);
  const isAncestor = makeIsAncestor(`origin/${CANONICAL_BASE}`);

  const limit = arg(argv, "limit") ?? "100";
  let prs;
  if (single) {
    const pr = JSON.parse(
      gh([
        "pr",
        "view",
        single,
        "--json",
        "number,title,baseRefName,mergeCommit,state",
      ])
    );
    if (pr.state !== "MERGED") {
      console.error(`::error::#${single} is ${pr.state}, not MERGED`);
      process.exit(2);
    }
    prs = [pr];
  } else {
    prs = JSON.parse(
      gh([
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        limit,
        "--json",
        "number,title,baseRefName,mergeCommit",
      ])
    );
  }

  const { lost, ok, unknown, passed } = classifyMergedPrs(prs, isAncestor);
  console.log(
    `Checked ${prs.length} merged PR(s): ${ok.length} on ${CANONICAL_BASE}, ` +
      `${lost.length} missing, ${unknown.length} without a merge commit.`
  );

  for (const pr of unknown) {
    console.error(
      `::error::#${pr.number} is merged but records no merge commit, so its ` +
        `presence on ${CANONICAL_BASE} cannot be verified.`
    );
  }
  if (passed) {
    return;
  }
  for (const pr of lost) {
    console.error(
      `::error::#${pr.number} reads MERGED but ${pr.sha} is not reachable from ` +
        `origin/${CANONICAL_BASE} (base was '${pr.baseRefName}') — ${pr.title}`
    );
  }
  console.error("");
  console.error(
    "These PRs are not proven present on main. Investigate missing merge " +
      "commits and re-open absent changes against main."
  );
  process.exit(1);
}

function main() {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === "base") return runBase(argv);
  if (mode === "reach") return runReach(argv);
  console.error("Usage: check-merge-integrity.mjs <base|reach> [options]");
  process.exit(2);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
