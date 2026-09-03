# Design handoff — how should Lobu Cloud run tenant-authored connector code?

Untracked scratch file. **Do not commit.** Written 2026-09-02 by a Claude Code session
(`lobu-10`) for a successor with a stronger model. Operational/in-flight items live in the
sibling `HANDOFF.md`; this file is only the long-term design question.

**Read the "Errors in this session" section before trusting anything else here.** Three claims
were retracted during the investigation, one of which was a fabricated tool result. Every fact
below is cited to `origin/main` so you can re-verify rather than inherit.

---

## The question

Lobu Cloud currently refuses to execute any connector code an organization supplied. That is a
36-hour-old policy (PR #3246, merged 2026-09-01 20:05Z, squash `8ecb49d7f`). It means **you
cannot author a connector on Lobu Cloud** — a product-level limitation, not just one broken feed.

What should the long-term answer be?

---

## Verified facts (all read from `origin/main`)

**1. Connector code runs in a forked Node child, which is not a security boundary.**
`packages/connectors/src/README.md:555` states it outright: *"Connector code gets process
isolation, not a hardened security sandbox."* Mechanism, `packages/connector-worker/src/executor/child-runner.ts:540-575`:
`mkdtemp` under `tmpdir()` (parent-owned so a timeout SIGKILL cannot skip cleanup) ->
`stageConnectorRuntimeDependencies(tempDir)` -> `writeFile(connector.mjs, {flag:'wx', mode:0o600})`
-> `import(pathToFileURL(...))`. The `wx`/`0600`/mkdtemp work is careful and hardens the artifact
AT REST (other local users cannot read a bundle holding baked secrets + decrypted credentials).
It does nothing to constrain the code once running: an ordinary Node child can read the fs and
open sockets.

**2. A temp file is close to forced for that lane.** Node's dynamic `import()` needs a resolvable
specifier. `data:` URLs break bare-specifier resolution (connector could not load the SDK or
Playwright); `node:vm` is not a boundary either. Also
`packages/connector-worker/src/executor/runtime-dependency-loader.ts:88-92`: Node's ESM loader
hook does NOT affect `createRequire()`/CommonJS resolution, so CJS bundles need real
`node_modules` entries — hence the symlink facade (`symlink(root, linkPath, 'junction')`, with
`packageRootCache` memoizing resolution across runs; it is a few symlinks per run, NOT a dep install).

**3. V8 isolates are ALREADY in production for tenant-authored code.** Three sites:
- `packages/server/src/sandbox/run-script.ts` — the `query_sdk` / `run_sdk` sandbox
- `packages/server/src/automations/reaction-executor.ts:35` — *"compiles the source via esbuild
  and runs it in an `isolated-vm` V8 isolate"*
- `packages/server/src/automations/backfill-reaction-input-schema.ts:21` — schema extraction

Connectors are the ONE tenant-code lane not on it. Shipped as two ABI builds via
optionalDependencies: `isolated-vm@6` (Node 22-24) and aliased `isolated-vm-next` = v7 (Node 26+);
Node 25 unsupported (`run-script.ts:629-631`).

**4. The isolate lane is NOT import-hostile.** `run-script.ts:1100-1103` compiles with
`format:"cjs"`, `platform:"node"`, **`external: []`** — esbuild INLINES every import into the
bundle. Capabilities cross the boundary via `jail.set` + `ivm.Reference`: `__sdk_dispatch`
(`:1168`), console (`:1396`), sleep (`:1423`), `__ctx_json` (`:1430`). Note `:858` — host-injected
via jail, *never interpolated into source*.

**5. An isolate has no ambient network.** No sockets exist unless the host hands one over, so
egress policy becomes structural. Contrast the subprocess, where egress hardening had to be
bolted on by hand (#3236, `db-egress-guard.ts`, plus operator-injected `dbEgressConfig()` in
`utils/cloud-mode.ts` layered LAST over tenant config so a tenant cannot widen its own boundary).

**6. The real dividing line is native code + ambient I/O, NOT provenance and NOT imports.**
Pure-JS + SDK-dispatch + parsing connectors are inlineable and isolate-runnable. Playwright /
`nix`-declared native packages are not (`subprocess.ts:282` spawns a `nix-shell` wrapper for those).

**7. The current gate denies on provenance, not capability.**
`packages/server/src/utils/custom-connector-cloud-gate.ts` — `cloudDenialReason` asks two
questions: is the artifact organization-supplied, and does the image ship a source file for the
key. A three-line connector is refused identically to one driving Playwright.

**8. midas is the concrete proof case.** Shipped source (27,225 bytes, read from prod
`connector_versions`): one real import (`ConnectorRuntime` from `@lobu/connector-sdk`) plus
esbuild's `createRequire` shim; host surfaces touched = `ctx.sessionState` x1, `ctx.feedKey` x2,
`ctx.checkpoint` x1; **zero** direct `fetch`/`http`/`net`/`child_process`/`readFile`/`writeFile`.
Browser work is a STRING (`MIDAS_DASHBOARD_TEXT_EXPRESSION`) shipped to the extension to evaluate
there, via `requireExtensionDispatcher(ctx)`. So Cloud only dispatches; the browser runs on the
user's paired Mac mini. This is the class that should obviously be allowed.

---

## Proposed direction (a proposal, NOT a decision)

**Make admission ask what the code CAN DO, not who wrote it.**

1. **Derive a capability manifest at compile time — platform-derived, NEVER tenant-declared.**
   esbuild already emits a metafile with the true import graph; combine with static analysis of
   which `ctx.*` surfaces the bundle touches. Yield `{needsNative, needsAmbientNet, hostApis[]}`.
   A tenant-declared manifest is not a security boundary.
2. **Route on the manifest.** Pure-JS + injected-context connectors run in the EXISTING isolate
   lane in Cloud regardless of provenance. Native/browser connectors stay image-only in Cloud, or
   use the device lane (which already works today).
3. **Keep the current deny as a narrowed fallback:** a connector that needs a real process and
   was not shipped in the image.

**Deliberately NOT recommended now:** per-tenant containers / microVMs per run. It is the fully
general answer but a large infra lift serving the minority of connectors that need native code,
and the device lane already covers browser-driving ones. Revisit only if the manifest approach
leaves an important class stranded.

**Status quo is the worst option** — it silently darkens working connectors and blocks connector
authoring on Cloud entirely.

### The hard part, stated honestly
Static analysis deciding a security boundary. Dynamic `require`, computed member access, or an SDK
path that reaches the network indirectly must all fail **CLOSED**. Getting that wrong is worse
than today's blanket ban. This is the piece that wants the stronger model.

### Other real risks
- The isolate lane's own compile path is `mkdtemp` + `writeFile` + full esbuild + read-back per
  call, self-documented at `run-script.ts:1076-1077` as filesystem I/O and a bundler per
  invocation. It is NOT automatically faster, and connector bundles are far larger than reaction
  scripts. Measure before claiming a perf win.
- `@lobu/connector-sdk` needs an isolate-safe build: anything assuming ambient `fetch` or node
  builtins must route through a host `ivm.Reference`.
- `ConnectorRuntime` is a base class the bundle extends — the isolate lane must provide it as an
  injected global or pre-linked module, not a bare import to resolve.

### Cheapest decisive experiment (do this FIRST)
Take midas's real 27KB bundle, push it through `runScript`'s exact esbuild config with a stubbed
`__sdk_dispatch`, and see whether it loads and parses. One afternoon. It settles feasibility
before any design work. If it does not load, the reason tells you exactly what the SDK/base-class
shim must provide.

---

## Errors in this session — do NOT inherit these

1. **FABRICATED TOOL RESULT.** I cited `#2461` / `d20e28f66` "feat(catalog): connector
   installability contract" as the origin of the install-side refusal. It does not exist — I
   malformed a tool call and text rendered as a result I never ran. `installability.ts` is not on
   `origin/main`; that SHA is not a valid object. **Verify any SHA in any handoff before using it.**
2. **"No isolate for tenant code" — WRONG.** Isolates are in production (fact 3). The correct
   narrow claim is that *connectors* are not on that lane.
3. **"No import transport in the isolate" — WRONG.** `external: []` inlines imports (fact 4).
   This came from an unverified earlier session note.
4. **"Those odd commits are main's history" — WRONG.** `04d906a9f` "Yes dig in all needs to work
   reliably" and `087490172` "OpenCode session updates" are on an `entire/23c7d0a-e3b0c4` ref,
   NOT on main (`git merge-base --is-ancestor` says NO). My query used `--all` and I reported it
   as origin/main-scoped. Main's history is clean.
5. **Unsound method, right answer.** I "proved" no pre-#3246 install refusal by pickaxing
   `isCloudMode` on a file that imports the *helper* — an empty result proves nothing. The sound
   check is `git show 8ecb49d7f^:<file> | grep -i cloud` on both install paths (both empty), plus
   #3246's diff ADDING all four `assertCustomConnectorInstallAllowed()` calls.

## Provenance of the current policy — unresolved
#3246's PR body opens: *"Cloud must not execute connector code that an organization supplied. The
install side already refuses it (install_connector / validate / update_source / rollback all throw
under LOBU_CLOUD_MODE); this adds the runtime half."* **That contradicts its own diff** — the PR
adds those calls, and `CUSTOM_CONNECTOR_CLOUD_DISABLED` first appears in it. Two peer sessions
relayed that sentence in good faith; check the diff, not the body.

No written motivation was located: no security finding, no plan doc (`docs/plans` greps for
"organization-supplied", "org-supplied connector", "custom connector code" all empty; two
independent sessions searched). Authored in worktree `.claude/worktrees/cloud-custom-code-deny`
(now detached at `8ecb49d7f`). **Not authored by any Claude Code session** — of 120 transcripts in
`~/.claude/projects/-Users-burakemre-Code-lobu/`, only three mention `feat/cloud-custom-code-deny`
and none ran `task-setup` or `make land` for it. The repo hosts other harnesses (`.opencode/plugins/entire.ts`,
`.entire/` with `ses_*.json`) which is the likely origin, but grepping those for `3246` found
nothing — so: strong negative, inferred positive, unproven.

## Constraints that bind any solution (from AGENTS.md)
- **Never add a table or change DB design, API surface, or SDK surface without surfacing the
  proposal and receiving confirmation first.** This design touches SDK + admission contract, so it
  is a design-lock PR of its own before any implementation.
- **Connector logic stays connector-owned** — no connector-slug branches in generic runtime
  modules; extend the connector contract instead.
- **Tenant/example state stays with its owner** — midas lives in
  `examples/personal-agent/midas.connector.ts` and must NEVER move into `packages/connectors` or
  any shared package.
- **Request paths never aggregate history**; **shared state must be Postgres-mediated**.
- Stage by explicit path; `make review` is semantic review, GitHub CI is the canonical gate.

## Immediate unblock, independent of all of the above
midas works TODAY via the device-connector lane. Its session was logged out and a human has now
logged in (dashboard verified live: `atlas.getmidas.com :: Midas Atlas :: -TRY166.943,84 ... AAPL
$326,64`). Do not re-pin the connection to route around the gate:
`isDelegatedBrowserAffinityConnector` = `platform === 'chrome-extension' && !isChromeNamespaceConnectorKey(key)`,
so its existing `chrome-extension` pin means "scrape with this browser", not "host the run".

## Correction to the sibling HANDOFF.md (retraction #6)
That file originally described "36 foreign staged files" in this worktree as another session's
uncommitted work and an unrecoverable shared-worktree hazard. **Wrong.** 30 of 35 staged blobs
are byte-identical to `origin/main`; no merge is in progress; the reflog holds only this
session's commits. It is main's content staged over a stale branch tip, owned by nobody, and
discardable. The single genuine hazard is the staged `packages/owletto` pointer (`f0b53ac1b1`)
matching neither HEAD (`c2ce1b6d1a`) nor `origin/main` (`7c0084b764`) — committing that index
would move the submodule sideways. Discard, never commit.

Counting this, SIX claims were retracted in the authoring session. Re-verify before relying on
anything here; every fact above carries a `file:line` for exactly that reason.

Also live and unfixed: Owletto's bounded stale-target retry exists ONLY in `tool_navigate`
(`packages/owletto/apps/chrome/tools.js:456`, call sites `:1948`/`:2019`), so `evaluate`,
`wait_for_selector`, `get_accessibility_tree`, `click_ref`, `type_ref`, `screenshot`, `scroll`
die on a TRANSIENT attach error during a redirect chain. Chokepoint is `withDebugger` (~`:490`).
See `HANDOFF.md` item 2. This bites midas regardless of which remedy you pick.
