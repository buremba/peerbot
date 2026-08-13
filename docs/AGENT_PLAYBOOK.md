# Agent playbook

Supporting rationale, incident history, and exact flags for the root and package agent rules.

The root `AGENTS.md` is loaded into agent sessions (`CLAUDE.md` inlines it for Claude), so it carries concise rules. Package `AGENTS.md` files add local rules; this file carries supporting context for both. Read the relevant section when a rule looks arbitrary, when you are about to argue yourself out of one, or when you need the full command.

Mechanical traps (build, SQL, testing, submodule, browser) live in `docs/GOTCHAS.md` instead.

## Workspace

**Explicit-path staging.** A commit is a snapshot of the index, not a diff of your intentions. A worktree that hosted earlier work still holds those files; `git add -A` commits the stale copies, which silently reverts already-merged PRs. Verify a "reverts merged work" review finding by diff direction against `origin/main` — never dismiss it as merge-base noise.

**One branch = one concern** means one concern, not one file. Split only for genuinely independent concerns or when the diff would be unreviewable.

**Conflict resolution.** Never resolve conflicts in the GitHub UI. Rebase ordinary branches locally against `origin/main`, then diff against the last real feature commit before squashing so a resolution cannot silently drop work. Submodule-pointer branches merge instead; follow `docs/GOTCHAS.md`.

## Data

**Request paths never aggregate history.** History only grows, so read-time aggregation cost grows with it while the answer stays bounded — the query gets slower every day for a result that does not change shape. Materialize the row or counter at write time and read it back by index. Run the one-time backfill in a migration, never per request.

**`events.id` is a stored-version id.** Connector resyncs supersede a row and allocate a new id for the same source item, so any identity or dedupe keyed on `events.id` breaks silently on the next resync.

**Organization rows.** Empty-looking orgs are frequently real human signups that have not been used yet. There is no bulk-delete that is safe, including "zero activity" filters.

## Runtime

**Dynamic-import exceptions.** Two call sites are grandfathered because they gate on the Node version before loading a large graph, and both must stay dependency-free until their checks pass:
- `packages/cli/bin/lobu.js` defers the existing CLI graph without duplicating it.
- `packages/server/src/server-entry.ts` runs the gate before dynamically loading the separate server bundle.

**Fail closed on durable state.** The failure mode this prevents: an operation that may already have succeeded is retried as if nothing happened, or an error is read as "safe to skip" and a delivery is dropped. Treat ambiguity as failure and reconcile idempotently.

**Coordination design brake.** If a change needs a second lock, a second retry budget, or a prose argument for why it terminates, the check is in the wrong place. Re-derive where the decision belongs before adding mechanism.

**Page-activated browser drafts.** Persist the draft operation and its normal Lobu notification. The generic extension badges exact pending URLs and activates the run only when the user visits one in a user-owned tab. Connector/reaction code owns the URL and page interaction, but no layer auto-submits — neither core nor connector nor extension code pushes a user-owned tab or submits the draft on the user's behalf.

## Evidence

**Red→fix→green.** Both outputs belong in the PR body. If you cannot reproduce the bug, that is a reportable dead end — a speculative fix costs more than the bug.

**Mutation checks.** A test that passes after you break the code proves nothing. Assert the old pattern exists, make a countable source change, confirm the focused test fails, then restore and rerun green.

**Absence needs `origin/main`.** A working-tree grep proves nothing about what exists — your tree is stale by definition. `git fetch -q origin && git grep <pattern> origin/main`; the fetch is load-bearing because `origin/main` itself goes stale.

**Never done off a typecheck.** Boot it, exercise every branch you touched, clean up test data you created. "It compiles" is a legitimate report only if you say that is all you ran.

**Deletion evidence.** Trace the full workflow, not only the import graph. Low production usage is not evidence that code is safe to delete, and docs and help text are load-bearing too.

## Gates

| Command | What it actually does |
|---|---|
| `make pre-pr-remote` | Full Linux CI graph on Depot against the **staged** tree; builds before checks that consume dist, which is what protects against a stale-dist false green. Fails closed on untracked/unstaged changes so the tree attestation survives the following commit. |
| `make pre-pr-remote-fast` | Broad interim confidence, remote. Never substitutes for the final gate. |
| `make pre-pr` | CPU-heavy local fallback for when Depot is unavailable. |
| `make review` | Handles the review verdict/status or safe-class skip. Runs no typecheck, knip, or tests — **not** proof CI will pass. |
| `make review-fix` | Unposted fixer pass. Edits the working tree; re-read files before trusting them. |
| `make ui-review` | Records exact UI proof for Owletto pointer changes; passes other changes as not applicable. |

The macOS app lane stays on GitHub/Mac hardware. Subset runs (`make pre-pr-remote REMOTE_JOBS=unit`) rerun one lane but never attest. A fresh full `make review` requires the matching Depot tree attestation and refuses a surprise local build; safe-class skips and cached verdicts do not rebuild. Only a documented Depot outage permits `REVIEW_ALLOW_LOCAL_BUILD=1 make review`.

**Depot serializes org-wide.** A newer dispatch silently cancels the older run, and `gh run rerun` counts as a dispatch — re-running an *old* commit's CI cancels the run for the current HEAD. Check `pgrep -f "make pre-pr-remote"` immediately before dispatching.

**`make review` skip rule.** Small safe-class diffs (docs, renames, generated, additive tests; under 100 lines) skip the cross-harness reviewer by default. `REVIEWER_MODE=full make review` forces the independent review; `REVIEWER_SHADOW=1` measures the skip rule instead of trusting it.

**UI proof.** `gh` cannot upload images inline. Capture before shots from the unmodified branch and after shots from the same booted app (auth recipe in `docs/BROWSER_TESTING.md`), base64-embed the PNGs into one self-contained HTML comparison page, host it at an HTTPS URL, and pass that URL as `ARTIFACT` to `make ui-review`. The gate records it on the exact merged Owletto PR, links it from the parent, and binds the evidence to that parent-base and Owletto-pointer pair for normal PR review. A rerun may reuse an exact proof already recorded for that pointer pair; otherwise no `ARTIFACT` means no proof and no pass.

## Post-merge rollout verification

For a prod-visible surface, schedule a follow-up around 25 minutes later. If the deploy is still stale, reschedule instead of polling in the foreground. Once it lands, run:

```sh
MERGE_SHA=$(gh pr view <n> --json mergeCommit --jq .mergeCommit.oid)
git merge-base --is-ancestor "$MERGE_SHA" "$DEPLOYED_SHA"
```

Two ways this gate silently never opens:
- **Gating on the branch head instead of the squash commit.** A squash merge writes a new commit with no ancestry link to the branch, so the branch head cannot prove the rollout.
- **Reversing the argument order.** Merge commit first; reversed, it accepts a stale deploy.

Record the result when it lands.

## Session efficiency

- Exact local tests remain the fastest red-green loop; Depot owns CPU-heavy breadth. Never start a local full gate alongside a remote one.
- `make dev-remote` syncs committed code to private Daytona compute by default, resumes or starts Lobu, and prints a signed preview URL. Commit first. Run `make dev-remote-pause` when finished, and keep it private — no hooks, public preview, or custom proxy.
- `gh pr checks <n> --required` plus `gh pr view <n> --json number,title,isDraft,mergeStateStatus,reviewDecision` is the compact status read; avoid the much larger `statusCheckRollup` payload.
- Delegated CLIs (OpenCode, Claude CLI) get polled at most once per 4.5 minutes unless they finish, request input or approval, or the user asks for an immediate update. Read only output since the last cursor. Ask them to persist detailed evidence to files and return compact status, counts, failures, and exit codes; never replay a full session or stream verbose diffs into the supervising context.
- Screenshots are the single largest context-bloat source. Prefer `get_page_text` / `read_page` / `javascript_tool`, and screenshot only when visual layout itself is under test.
- For a one-line or config-only change, take one CI snapshot and move on.
