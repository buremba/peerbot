# Handoff — Cloud connector gate / midas

Untracked scratch file. **Do not commit.** Delete when the work below closes.

Worktree: `.claude/worktrees/cloud-gate-shadow-row`
Local branch: `feat/cloud-gate-shadow-row` @ `c863bc2c1` (pre-squash; the PR landed as a squash)

---

## CLOSED — do not redo

**PR #3285**, squash `6e8b110504b7b17f6d64f54daad46bf4ba44ee11`, merged 2026-09-02 04:33Z.
Deployed: image `20260902-093009-002557` (= `e098dbe134`). Gate passed:
`git merge-base --is-ancestor 6e8b1105 e098dbe134` → true.

What it did: the Cloud artifact gate denied connectors the image *does* ship, because the
`organization` provenance branch returned before the image check. Readers select
`ORDER BY organization_id NULLS LAST`, so an org-scoped copy shadows the shared row —
the ordinary state of a long-lived workspace, since `apply` wrote org copies for years.
Fixed at all three fences (queue admission, worker poll, compilation), plus the silent
failure: `trigger_feed` skips now return `triggered:false` + `reason` and carry the
gate's own remedy sentence through `detail`.

Files (12): `packages/server/src/utils/custom-connector-cloud-gate.ts`,
`utils/ensure-connector-installed.ts`, `worker-api/poll.ts`, `runs/queue-service.ts`,
`tools/admin/manage_feeds.ts`, `connect/routes.ts`,
`packages/core/src/contracts/tools/manage-feeds.ts`,
`packages/client/src/generated/types.gen.ts`, + 4 test files.

**Prod-verified (all read/exercised live, not inferred):**
- feed 550 (hackernews, buremba) — the exact repro that returned
  `"This connector cannot run on Lobu Cloud yet"` → now `triggered:true`, run 1323789 `completed`.
- feed 441 (midas) — still denied, with `reason:"cloud_restricted"` + the MCP/device/self-hosted remedy.
- 12 feeds triggered (buremba 550, 389; lobu-team 342,344,346,347,349,350,351,352,354,355)
  → runs 1323999, 1324000, 1324004–1324013: **12/12 completed, 0 failed**.
- 153 runs on shadow-row connectors since deploy, 0 failed.
- Fable review: bug_free 88, simplicity 80, slop 8, 0 bugs, 0 blockers. All 10 required checks green.

**Exact blast radius** (rebuilt from `scheduled/check-due-feeds.ts` — the term to keep is
`cv.version = COALESCE(f.pinned_version, cd.version)`; an approximation that drops it is wrong):
- Unblocked: github 10, reddit 8, slack 7, hackernews 3, rss 1, x 1 = **30 feeds / 6 orgs**
  (buremba, community, lobu-team, market, umit-unal). **All unscheduled** — which is why nothing
  alerted: they were dark only to manual `trigger_feed` from an agent/CLI.
- Correctly denied (not in image): website 41, spotify 4, revolut 2, midas 1, loki.activity 1, linkedin 1.
- The slack ones return `Feed does not support sync` — the gate never applied to them.

15 probe tabs closed via `close_user_tabs` (own ids only).

---

## OPEN

### 1. midas — login DONE; now blocked by the Cloud gate, which is CORRECT
**Corrected 2026-09-02.** An earlier version of this file said "log in and trigger 441 and it
works". That was wrong — it conflated two independent blockers.

**Blocker A (logged-out session): FIXED.** The Midas session had expired;
`atlas.getmidas.com/dashboard` OAuth-redirected to `sso.getmidas.com/giris`. After a human
logged in, the dashboard loads with live data:
`atlas.getmidas.com :: Midas Atlas :: -TRY166.943,84 -%0,33 ... AAPL $326,64 (%0,46)`.

*The trap that hid this:* `navigate` reports `current_url: .../dashboard` because it reads
`location.href` right after `Page.frameStoppedLoading`, BEFORE the redirect fires. Read the real
URL out-of-band — trigger the `open_tabs` feed 439 on chrome connection 432, then
`events WHERE feed_id=439` -> `source_url` (uses `chrome.tabs`, no debugger, so it is immune to
the retry gap in item 2).

**Blocker B (Cloud gate): STILL DENIES, and must.** `trigger_feed` on 441 returns
`triggered:false`, `reason:"cloud_restricted"` — midas is organization-supplied code that the
image does not ship. Logging in cannot change that, and per explicit owner instruction this
denial is correct and stays. Do NOT weaken it, and do NOT re-pin the connection to a device to
route around it: `isDelegatedBrowserAffinityConnector` is
`platform === 'chrome-extension' && !isChromeNamespaceConnectorKey(key)`, so midas's existing
`chrome-extension` pin means "scrape with this browser", not "host the run" — the sync stays
fleet-hosted by design.

**Timeline that settles it** (the gate is NOT why midas went quiet):
- 2026-08-11..13 — intermittent failures from the item-2 retry gap.
- 2026-08-13 02:39 — last success, runs 936071/936076, 23 real events.
- after 2026-08-13 — **no runs at all**: feed 441 has no schedule, so it only fires on a manual
  trigger, and nobody triggered it for ~3 weeks.
- 2026-09-01 20:05 — Cloud gate #3246 (`8ecb49d7f0`) merged, turning a manual trigger into a refusal.

**To actually make midas sync again**, pick one of the denial's own three remedies: re-express it
as an MCP server, ship it as a device connector from a paired device, or run it self-hosted.
The owner has previously indicated the device-connector path is the intended destination.
Note the connector source lives in `examples/personal-agent/midas.connector.ts` — it is
tenant/example state and must NOT be moved into `packages/connectors` or any shared package.

### 2. Owletto: bounded retry only exists in `tool_navigate`  (real bug, not written)
`packages/owletto/apps/chrome/tools.js:456` defines `isStaleDebuggerTargetError`, documented
as "recoverable ... (bounded retry)". Verified on the submodule's `origin/main`, its only two
call sites are **both inside `tool_navigate`** (lines 1948, 2019). `evaluate`,
`wait_for_selector`, `get_accessibility_tree`, `click_ref`, `type_ref`, `screenshot`, `scroll`
have no retry, so a transient attach failure during a redirect chain kills the whole flow.

Proven transient by A/B: identical call failed 3 runs, then succeeded on attempt #1 of a 4th;
`example.com` (no redirect) passed every time. Accounts for 4 of midas's 8 recent failures
(`Cannot access a chrome-extension:// URL of different extension` ×3, `Detached while handling command` ×1).

**Chokepoint is `withDebugger`** (`tools.js` ~line 490) — every failing op routes through it.
Suggested shape: retry the attach/`Page.enable` a bounded number of times when
`isStaleDebuggerTargetError` fires **and** `chrome.tabs.get(tabId).url` is still `http(s)`;
throw immediately if the tab really is another extension's page (permanent). Do NOT recreate
tabs here — `tool_navigate` owns that.

Separate Owletto-repo PR + pointer bump. Note this does **not** unblock midas on its own (login does).

### 3. The staged files in this worktree are DISCARDABLE (corrected)
**Corrected 2026-09-02.** An earlier version of this file called these "36 foreign staged files"
and "another session's uncommitted work", citing the shared-worktree hazard. **That was wrong.**

Measured: 30 of the 35 staged files are byte-identical to `origin/main`. The 5 that differ
(`bun.lock`, `docs/GOTCHAS.md`, `examples/personal-agent/docs/one-off-context-sources.md`,
`packages/cli/package.json`, `packages/server/package.json`) differ only because main advanced
afterwards. No `MERGE_HEAD`, no rebase dir; `ORIG_HEAD` is this branch's own base `630dd21a3`;
the reflog holds only this session's four commits (last 09-02 05:07). Four peer sessions and all
120 Claude transcripts disclaim it, and none staged here — they were telling the truth.

So it is `origin/main` content staged over a stale post-squash branch tip by a
checkout-or-merge that was never committed. **No one owns it and it can be discarded.** The risk
is not losing work; it is creating a junk commit on a branch whose PR already merged.

**The one real hazard, which does stand:** the staged `packages/owletto` pointer is
`f0b53ac1b1`, while HEAD has `c2ce1b6d1a` and `origin/main` has `7c0084b764` — three different
pointers, the staged one matching neither. Committing this index would move the submodule
sideways to a commit main does not reference, the shape that silently reverts merged submodule
work (`docs/GOTCHAS.md`). **Discard the index; never commit it.**

### 4. Shadow-row cleanup — operational script, NOT a migration
106 org-scoped `connector_versions` rows with bytes on image-shipped keys
(x 42, github 18, reddit 9, hackernews 6, youtube/gmail/rss/slack 4 each, market.quotes 2).

**Do not write a migration.** It would run on self-hosted deployments too, where those org rows
are legitimate overrides the resolver deliberately prefers — it would destroy real customer code.
Post-fix the rows are inert in Cloud (`resolveConnectorCode` compiles the image regardless), so
this is hygiene, not a fix. Correct vehicle: an operational script with explicit inputs.

### 5. 8 untriggered feeds in other tenants
reddit/rss/hackernews feeds in `community` (37, 98), `market` (3, 4, 5, 35, 36, 38),
`umit-unal` (540, 541, 542). Left alone deliberately: triggering writes events into other
tenants' data at an unexpected time. Trigger only if the owner says so.

### 6. Device-connector predicate — low impact, probably leave it
`IS_DEVICE_CONNECTOR_SQL` (`utils/device-autowire-suppression.ts`) returns false for the 3
`*.takeout` connections (google/instagram/twitter) in buremba — **all paused**.
`whatsapp.local` classifies correctly. Only consumer is `manage_connections/handlers/crud.ts:2198`
(`handleDelete`, autowire suppression marker), so the risk is a paired device re-creating a
deleted connection. Not worth a speculative predicate change.

### 7. Minor
- Fable's only suggestion: three copies of the image-first rationale (`cloudDenialReason`,
  `poll.ts`, `ensure-connector-installed.ts`) will drift; trim to ~5 lines total.
- `scripts/dev-native.sh` Node guard is stale: rejects Node 26 with "Unsupported Node.js runtime",
  but `run-script.ts` already resolves `isolated-vm-next` for Node 26+. The `-lt 25` bound wants
  `-lt 27`. Workaround used: a temp copy of the script (deleted after).

---

## Recipes worth keeping

**Prod DB read** (`-h 127.0.0.1` prompts for a password — omit it and use the local socket):
```bash
kubectl exec -i -n summaries-prod lobu-db-prod-1 -c postgres -- \
  psql -U postgres -d owletto -t -A -F'|' < query.sql
```
Table is `runs`, not `sync_runs`. Events columns: `source_url`, `title`, `payload_data` (no `data`).
`runs.feed_id` is NULLable → `NOT IN (SELECT feed_id …)` silently returns nothing; use `NOT EXISTS`.

**Read live browser tab URLs without the debugger:** trigger feed 439 (`open_tabs`, chrome
connection 432), then read `events WHERE feed_id=439` — `origin_id` is `tab-<id>`, `source_url`
is the real URL. `read_feeds` on it fails with "does not support source reads".

**Live browser probe:** `lobu call run_sdk --context prod --org buremba --input-file <file>`
where the file is `{"script": "<js>"}`. Contract: `export default async (ctx, client) => {}`,
`client.operations.execute({connection_id, operation_key, input})`, no `setTimeout`, **60s wall
clock** (batch ≤12 ops/run). Result shape is `r.output`, **not** `r.observation`.
Thread `tab_id` explicitly — scratch tabs are run-scoped, so each `execute` is its own flow and
a later run cannot `close_tab` an earlier run's tab (`close_user_tabs` with explicit own ids can).

**zsh gotcha:** unquoted `$var` does not word-split. `set -- $spec` silently keeps one field;
use `printf '%s\n' … | while read -r A B`.

**Deployed SHA:** image tag `YYYYMMDD-HHMMSS-NNNNNN` where `NNNNNN` is the "Build and Push
Images" run number; map it via `gh run list --workflow "Build and Push Images"`. Always gate on
the **squash** commit: `git merge-base --is-ancestor "$MERGE_SHA" "$DEPLOYED_SHA"`.
