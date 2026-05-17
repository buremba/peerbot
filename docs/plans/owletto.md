# Owletto

Local-first, proactive personal agent app — a consumer surface powered by
Lobu. Wraps a user's existing local CLI agent (Claude Code / Codex / Gemini
CLI / OpenCode) with goals, watchers, personal-context ingestion, and a
menubar canvas. Owletto's job is to make the CLI agent **proactive**;
Lobu's job is the trigger fabric and the eventual org-tier upgrade target.

## TL;DR

- **Product:** Mac menubar app + Chrome extension. User sets goals; goals
  install watchers; watchers fire and the user's existing local CLI agent
  runs against personal context. Surface: ambient menubar canvas; opt-in
  per-watcher OS notifications with cooldown-based rate limits.
- **Architecture:** owletto embeds a Lobu gateway in local-only mode
  (PGlite store, auto-provisioned single user + single default agent, no
  signup). Watchers don't call Anthropic — they spawn `claude -p` /
  `codex` / `gemini` with the local gateway pre-configured as their MCP
  host. The CLI uses the user's own API key; owletto passes zero
  inference cost.
- **Filesystem:** local Lobu DB stays source of truth; auto-syncs to
  `~/lobu/` (a standard Lobu project layout) via `lobu pull` after every
  mutation. `~/lobu/` becomes the share unit, the git unit, and the
  upgrade-to-org unit (`lobu apply --org acme` against the same dir).
- **Repo:** new public `lobu-ai/owletto` repo. The existing
  `apps/mac/Lobu/` in this repo (already 70% of what owletto needs) moves
  over wholesale. Cloud signin becomes optional "Connect to a team Lobu
  org" rather than a mandatory entry point.
- **Moat:** vendor-neutral integration & trigger fabric for whatever
  local CLI agent the user happens to run. Arms-dealer position; orthogonal
  to which CLI vendor wins. Compounds via open-source contributions to the
  connector library (Home Assistant playbook).
- **Funnel:** owletto is closed-source but free (binary distribution).
  Lobu engine underneath stays OSS. Lobu org tier (multi-device, team
  workflows, audit) is the monetized upgrade path. "Powered by Lobu"
  footer only — no hard push inside owletto.
- **Marketing positioning:** *"Make your local CLI agent proactive."*
  Not an "AI assistant," not a "personal AI." Dev-tool framing for a
  dev-first wedge audience.

## What we are building

### V1 product scope

Minimum shippable Show-HN-able product. The discipline: every "nice to
have" idea that surfaced during planning got pushed to v1.1, gated on
real user signal rather than our prediction of it.

- macOS app (SwiftUI, native). Menubar canvas only — no pop-out window
  in v1.
- Chrome extension (white-labeled, pointed at local gateway).
- Auto-detect installed local CLI agents at first launch.
- **Claude Code: deep integration** (the v1 quality bar).
  Codex / Gemini CLI / OpenCode: best-effort wrappers, marketing message
  still claims breadth, depth comes in v1.1.
- One default agent, auto-provisioned. User never sees the word "agent" in
  v1 — they see goals and watchers.
- Goals via **5 curated templates** (not freeform LLM translation, not
  10). Each template installs a known watcher set; demo quality > count.
- Ingestion: browser activity (extension) + Mac app/focus state (Mac
  app). Re-use the existing sync services already in `apps/mac/Lobu/`
  (Screen Time, Photos, HealthKit, browser profiles, etc.) selectively.
- **Per-watcher OS notification opt-in with cooldown-based rate limits**
  (per-watcher cooldown + daily global interrupt budget). No LLM
  interrupt gate in v1.
- Clicking a notification deep-links into the canvas with the relevant
  event focused.
- Local user is a real UUID from day one (not hardcoded `local-user`) —
  required for the eventual upgrade bridge to a Lobu org.
- **Auto-sync DB → `~/lobu/`** after every mutation, via existing
  `lobu pull` writer. `~/lobu/` is the standard Lobu project layout;
  trivially `lobu apply`-able against any other gateway.
- **Diagnostics panel** (gateway status, CLI detected, last watcher run,
  logs, permissions). Will save us in user reports.
- **Privacy copy** in onboarding: explicit about what stays local, what
  the user's CLI may send to its vendor, what owletto never sees.
- **Watcher import/export format** seeded from day one — even if it's
  just "drop a YAML in `~/lobu/agents/<id>/watchers/` and click Reload."
  No marketplace UI; the file format **is** the share format.

### V1 out of scope — explicitly v1.1

These are good ideas. They are not v1 ideas.

- **iCloud-by-default sync.** Default to `~/lobu/` on local
  filesystem. Users can move the dir into iCloud Drive themselves if
  they want; document the recipe. Default iCloud + NSFileCoordinator +
  conflict policy is 1–2 weeks for a demo nicety; ship after we have
  users asking for it.
- **The "should this interrupt" LLM gate.** Per-watcher cooldowns +
  daily interrupt budget fix 80% of the spam problem deterministically.
  Add the gate in v1.1 if precision is still bad with real usage.
- **Multi-CLI depth.** Marketing says "works with Claude Code, Codex,
  Gemini, OpenCode." Claude Code ships deep; rest are best-effort
  wrappers with "contributions welcome." Don't pretend all four are
  equal at launch.
- **Menubar pop-out window.** Menubar dropdown only for v1. Pop-out for
  marketing screenshots can come with v1.1.
- **Folder picker UI for sync destination.** Status indicator yes;
  destination picker no.
- **Cross-device sync of any kind** (the upgrade-to-org story).
- **Team / multi-tenant features.**
- **Freeform LLM goal→watcher translation** (v2).
- **Multi-agent** (v2 power-user feature).
- **iOS app.**
- **Marketplace UI for watchers** (v2; v1 is files in `~/lobu/`).
- **Mandatory cloud signup** — gone. Optional "Connect to a Lobu org" in
  Advanced settings only.

## Architecture

### Runtime topology

```
┌────────────────────────────────────────────────────────────────┐
│  macOS app (SwiftUI)                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Menubar canvas + native notification center handler     │  │
│  │  Goal/watcher UI, CLI auto-detect, extension installer   │  │
│  └─────────────────────────┬────────────────────────────────┘  │
│                            │ HTTP / native messaging           │
│  ┌─────────────────────────▼────────────────────────────────┐  │
│  │  Embedded Lobu gateway (Node, child_process.spawn)       │  │
│  │   - PGlite store                                         │  │
│  │   - Local-mode bootstrap (single user + default agent)   │  │
│  │   - Watchers / scheduler                                 │  │
│  │   - MCP host (events, memory, knowledge tools)           │  │
│  │   - macOS chat-platform renderer                         │  │
│  └─────────┬────────────────────────────────────┬───────────┘  │
└────────────┼────────────────────────────────────┼──────────────┘
             │ spawn on watcher fire              │ MCP over stdio/HTTP
   ┌─────────▼──────────┐               ┌─────────▼──────────┐
   │  Local CLI worker  │               │  Local CLI         │
   │  (`claude -p ...`) │◄──────────────┤  (Claude Code /    │
   │  shells out, no    │   tool calls  │  Codex / Gemini)   │
   │  Anthropic from    │               │  uses user's       │
   │  Lobu side         │               │  own API key       │
   └────────────────────┘               └────────────────────┘

   ┌────────────────────┐
   │  Chrome extension  │──── HTTP ────► local gateway (browser events)
   │  (white-labeled    │
   │   Lobu extension)  │
   └────────────────────┘
```

### Lobu codebase changes (additive, gated on local-mode)

1. **Local-CLI executor worker type.** Today's worker calls the LLM
   directly (OpenClaw runtime → Anthropic). Add a parallel executor that
   shells out to the user's chosen CLI. Selected per-agent (and
   overridable per-watcher).
2. **Local-mode bootstrap.** `LOBU_MODE=local` flag: skip org/auth
   flows, auto-provision one user (real UUID) + one default agent at
   first launch. Persist across restarts. **Discipline:** treat this as a
   deployment profile, not a fork — same primitives (org, user,
   connection, agent), just auto-created and hidden. Don't let
   `if (LOBU_MODE === 'local')` branches metastasize through the gateway.
3. **`LocalSurface` adapter (not a chat-platform connection).** Mac
   canvas + native notifications are an event/UI bus, not a chat
   transport. Forcing them through the existing chat-platform connection
   abstraction would leak chat assumptions (channels, replies,
   histories) into the surface. Define a parallel `LocalSurface`
   adapter alongside `packages/server/src/gateway/connections/` —
   filters on its own surface identity, no chat-shaped contract.
4. **PGlite production store path.** Already used in tests (per repo
   memory). Promote to a supported production target for embedded
   single-binary distribution.
5. **`lobu pull --local` mode.** Same `lobu pull` writer already
   planned (`docs/plans/lobu-pull.md`), pointed at the locally
   auto-provisioned org. Triggered by the embedded gateway after every
   mutation. Output: a Lobu project layout in `~/lobu/`.
6. **Schema additions:**
   - `agents.executor_kind` (`anthropic` | `local-cli`), plus `local_cli_kind`
     (`claude-code` | `codex` | `gemini-cli` | `opencode`).
   - `watchers.notification_channel` (`canvas` | `notification` | `both`),
     `watchers.notification_cooldown_seconds`,
     `watchers.notification_priority`.

### Goals → watchers translation

- v1 = curated templates only. Each template is a Lobu watcher YAML +
  goal metadata + suggested CLI prompts. Examples:
  - "Ship one PR per week" → cron Fri 16:00 + GitHub-events watcher
  - "Don't doomscroll during focus hours" → browser-focus watcher,
    threshold on time-on-site, focus-block calendar integration
  - "Reply to every email within 24h" → Gmail watcher, age threshold
- v2 = LLM-assisted goal definition that *picks* from existing
  templates, then *parametrizes* them. Freeform watcher synthesis stays
  out until precision is good enough that users trust it.

### Proactive precision: the "should this interrupt" gate

- A watcher firing ≠ a surface event. Between watcher-fire and
  canvas/notification, run an **LLM gate** that judges: is this
  worth surfacing now, given recent context and user-stated goals?
- First-class step, not a heuristic. The proactive-personal-AI
  category dies on false-positive notifications; this gate is the
  hard differentiator.
- Default model: small + cheap (Haiku-tier, or the user's local model
  if one is configured). The expensive CLI agent only runs *after*
  the gate decides surfacing matters and an action is warranted.

### Chrome extension

- **Same codebase as Lobu's existing extension**, white-labeled at
  build time: brand assets (logo, name) + target URL (local gateway
  `http://127.0.0.1:<port>` vs cloud Lobu) chosen by build flag.
- Mac app handles install: Chrome Web Store deep-link + post-install
  confirmation via native messaging. Same UX as 1Password / Loom /
  Granola.

## Filesystem sync (`~/lobu/`)

Local Lobu DB stays source of truth. After every UI-driven mutation
(create/edit/delete goal, watcher, agent, skill), the embedded gateway
runs `lobu pull --local` to write the current state out as files at
`~/lobu/` in the standard Lobu project layout.

### Why this matters

`~/lobu/` collapses three otherwise-separate features into one
artifact:

1. **"Share my watcher"** — the v1 form is: paste a folder/gist into
   your `~/lobu/`, click Reload (or `lobu apply`). No marketplace UI
   needed for v1; the file format **is** the share format. Directly
   addresses the moat concern that ecosystem can't wait until v2.
2. **Version-controlled personal AI config** — devs love their
   dotfiles. `~/lobu/` is git-init-able by the user; community-shared
   "owletto configs" live on GitHub naturally.
3. **Upgrade bridge to Lobu org** — no special migration code. Same
   folder, `lobu apply --org acme`. The hand-off is a one-liner.

### Mechanics

- **Default location:** `~/lobu/`. Not `~/owletto/` — the folder is a
  Lobu project, not an owletto-specific format. Owletto branding lives
  in the app, not the config dir. Future Lobu-powered products
  share the convention.
- **Sync trigger:** mutation-driven. UI write → DB write → enqueue
  `lobu pull --local` (debounced ~500ms). Cheaper than watching every
  DB write.
- **Editor edits:** manual `lobu apply` for now. No file watcher in
  v1; one-way DB→files is enough for v1's use cases.
- **Menubar surface:** small "Synced ~/lobu" indicator + "Sync now"
  button. **No folder picker UI in v1** (users move the dir
  themselves; iCloud users symlink). Picker is v1.1 if requested.
- **Emergent multi-device sync:** if a user parks `~/lobu/` in iCloud
  Drive / Dropbox / a synced git repo, they get multi-device config
  sync for free (each Mac runs its own local owletto + own local
  event store; only the config files sync). Document this as the
  recipe for cross-device use until we ship native sync in v1.1.

### Why not file-as-source-of-truth

Memory: Lobu's gateway moved *away* from boot-time file reading
earlier this year (`docs/plans/lobu-apply.md` is the writer, gateway
reads from DB). Owletto should not re-introduce file-first behavior
for local mode — that backslides the architecture and creates a
second mode of operation. Keep DB-as-source-of-truth, files as a
mirror written by `lobu pull`.

## Repository layout & migration

### Private repo: `lobu-ai/owletto`

Closed-source product surface (Mac app + Chrome extension + web admin
SPA). Free to use; binaries shipped from this (public) lobu repo's
Releases so anonymous users can download.

```
owletto/                   # private; renamed from owletto-web
├── apps/mac/              # SwiftUI Mac app (was apps/mac/ in lobu)
├── apps/chrome/           # MV3 Chrome extension (was apps/chrome/ in lobu)
├── src/                   # web SPA (the existing React app)
├── public/                # web SPA static assets (icons, favicon, etc.)
├── deploy/                # K8s/Flux manifests for app.lobu.ai
├── goals/                 # curated goal templates (future)
└── skills/                # bundled skills (future)
```

### Lobu repo (`lobu-ai/lobu`) — additive changes only

Local-mode bootstrap, local-CLI executor, `LocalSurface` adapter,
PGlite production path, `lobu pull --local`, schema fields. Zero
impact on existing org/team paths — all gated.

### Migration: what moves from this repo to owletto

`apps/mac/Lobu/` already exists in this repo (Lobu's Mac app — most
recent commit 2 weeks ago). It contains roughly 70% of what owletto
needs:

- ✅ Menubar UI surface (`MenuBarContent.swift`).
- ✅ Embedded Lobu runner (`LocalLobuRunner.swift`).
- ✅ Sync services: `ScreenTimeSyncService`, `PhotosSyncService`,
  `HealthKitSyncService`, `WhatsAppLocalSyncService`,
  `LocalDirectorySyncService`, `ObsidianVaultManager`,
  `BrowserProfileManager`.
- ✅ `KeychainTokenStore`, Sparkle update framework.
- ⚠️ `OAuthClient` — currently mandatory cloud-Lobu signin. **Becomes
  optional** ("Connect to a Lobu org" in Advanced); local mode is the
  default.
- ❌ Missing: goal/watcher UI, CLI auto-detect, canvas surface for
  watcher output, notification center handler, `lobu pull` trigger
  wiring.
- 🎨 Rebrand: app name, bundle identifier, icon, in-app strings
  from "Lobu" → "Owletto."

**Migration steps:**

1. Cut a branch in *this* repo that completes the unmandatory-signin
   work (local mode runs cleanly, OAuth becomes optional). Land it.
2. `git filter-repo` (or manual copy) `apps/mac/` → owletto repo,
   preserving commit history.
3. Delete `apps/mac/` from this repo with a CODEOWNERS-style stub
   pointing at the new location.
4. Rebrand pass in owletto repo (app name, bundle id, icon, strings).
5. Add the missing pieces (goals UI, CLI detection, notification
   handler).
6. Initial owletto release tag once Lobu's local-mode plumbing is
   merged.

The Chrome extension follows the same pattern but is simpler — owletto's
extension is a white-labeled build of Lobu's existing extension. The
sources can stay in the lobu repo if shared via workspace package /
submodule; or fork to owletto if branding/codebase divergence becomes
real. **Default: keep sources in lobu, owletto produces a branded
build.** Re-evaluate if it starts hurting.

### Why this split

- Mac app is the consumer product surface — its release cadence,
  brand, packaging, and code-signing pipeline belong in one place.
- Lobu engine (gateway, CLI, SDK) stays the platform. Other
  Lobu-powered consumer products can ship later without forking the
  Mac app code.
- Gateway-side connector adapters that *receive* events from the
  Mac app stay in Lobu. Reusable for any future org/team Lobu
  customer wanting personal-context ingestion. Don't pull them into
  owletto — that creates a backwards dependency.

## Brand and design

- **Owletto = distinct consumer brand.** Owl mark, separate wordmark,
  own homepage. Reads as a polished product, not an OSS admin UI.
- **Mac app:** SF Pro, native macOS controls, no embedded shadcn
  webview for primary surfaces.
- **Chrome extension:** system fonts, owletto-branded.
- **Lobu kinship:** footer "Powered by Lobu" + shared accent color.
  Subtle — discovery, not co-branding.
- **Lobu admin UI reuse** only for power-user "Advanced" views (raw
  watcher YAML editor, MCP config, provider registry). Can be an
  embedded webview tab.

## License and IP

- **Lobu engine** (gateway, agent-worker, core, CLI, SDK, connectors):
  stays Apache-2.0 OSS. That's where the community moat lives — every
  contributed connector compounds the surface across all consumers.
- **Owletto product** (Mac app, Chrome extension, web SPA): closed
  source, private repo. Free to use, binary distribution from lobu's
  Releases. Rationale: SwiftUI/extension/SPA is product surface code,
  not platform; SwiftUI contributors are rare; brand differentiation
  beats forkability here.
- **Trademark the brand:** "owletto" name + owl mark stay protected
  regardless of source-availability. Same Mozilla / Home Assistant
  Inc model.
- **Boundary is structural, not feature-gated:**
  - Lobu OSS engine — what makes everything run; community contributions
    welcome.
  - Owletto closed product — the polished, brand-controlled local
    surface. Same engine underneath as any Lobu org deployment.
  - Lobu org tier (commercial) — networked / multi-tenant slice
    (multi-device sync, team org, audit logs, hosted gateway).

## Moat

- **Vendor-neutral integration & trigger fabric** for whatever local
  CLI wins the market. Anthropic and OpenAI will both ship memory,
  triggers, and personal context inside their CLIs — neither will
  make their tool work equally well with the *other guy's* CLI.
  Owletto/Lobu is structurally the only player who can.
- **Connector breadth × CLI compatibility** is the cross-product
  that compounds weekly. Open-source contributions add connectors
  the core team doesn't pay to build (Home Assistant model).
- **Events schema** for "personal agent context" becomes a de facto
  standard. Late lock-in.
- **Lobu org-tier upgrade path** is the business model — no
  consumer-only competitor can offer it.

What is **not** the moat: the Mac app UI, the goals→watchers
mapping, the proactive notification logic, any single connector.
All reproducible in a quarter; lean on the compounding axes instead.

## Marketing

### Positioning

- One-liner: *"Make your local CLI agent proactive."*
- Tagline variant: *"Goals and watchers for Claude Code, Codex,
  Gemini CLI, and OpenCode."*
- Avoid "AI assistant" / "personal AI" — category graveyard.

### Lead asset

One screenshot of a specific, relatable proactive moment in the
menubar canvas. Not a feature tour, not a homepage video. Candidates:

- "You've been on Twitter for 90 min during your focus block. Close it?"
- "Three meetings tomorrow conflict with your gym goal. Reschedule?"
- "It's Thursday and you said you'd ship one PR this week. Draft one?"

### Above-the-fold messages

- **$0. BYO-LLM.** Your existing Claude Code / Codex subscription is
  all you need.
- **Local-only. Open source. No signup.**
- **Works with Claude Code, Codex, Gemini CLI, OpenCode.** Logos.

### Channels, in order of leverage

1. **Show HN** — strong fit (local-first, dev tool, free, BYO-LLM,
   BYO-LLM). Land with binary + README + demo GIF.
2. **Dev Twitter** — AI-coding-tools cluster.
3. **Reddit:** r/LocalLLaMA, r/ClaudeAI, r/MacApps.
4. **YouTube AI-tool reviewers** with a custom watcher pre-loaded.
5. **GitHub trending** — natural if HN lands.

Skip: Product Hunt, LinkedIn, generic tech press.

### V2 marketing feature

**"Share my watcher"** — export a watcher as a YAML/JSON snippet,
share on Twitter or r/LocalLLaMA, importable by anyone. Same model
as Home Assistant blueprints, Raycast extensions, Obsidian plugins,
Cursor rules. UGC becomes free distribution; network effect kicks
in. Single highest-leverage product decision for marketing.

### Lobu funnel

- "Powered by Lobu" footer in owletto; nothing more inside the app.
- Hard org-tier conversion only after 30+ day owletto users.
- Conversion path is self-selecting and high-trust because the
  technical audience inspects what's running.

## Milestones

Re-estimated for leaner v1. Rough; refine after M0 lands.

- **M0** (1–2 wk) — *Lobu side, this repo*. Local-mode bootstrap +
  local-CLI executor + PGlite production path + `lobu pull --local`.
  Verifiable from CLI. **Unblocks all owletto work.**
- **M1** (1 wk) — *This repo*. Make cloud signin optional in
  `apps/mac/Lobu/` (OAuth becomes "Advanced → Connect to org"). Local
  mode runs cleanly end-to-end. **Last work in this repo before
  migration.**
- **M2** (3–4 days) — Repo migration. `apps/mac/` → new
  `lobu-ai/owletto` repo with history preserved. Rebrand pass.
  CODEOWNERS stub in this repo pointing at owletto.
- **M3** (2–3 wk) — *Owletto repo*. Add missing pieces: goal/watcher
  UI, CLI auto-detect, canvas surface, notification handler
  (cooldown-based rate limit), diagnostics panel, privacy
  onboarding copy.
- **M4** (1 wk) — 5 curated goal templates with watcher YAMLs.
  Chrome extension white-label build. Mac→Chrome install flow.
- **M5** (1 wk) — Polish, code-signing + notarization, owletto repo
  public, README + landing site, Show HN.

Rough total: **6–9 weeks** from green-light to Show HN, with M0
unblocking everything else and the migration (M2) being the gate
between this repo's work and the new repo's work.

## Decisions (resolved)

- **Node runtime:** **bundle** a Node binary inside the Mac app.
  Requiring system Node would destroy first-run UX and supportability.
- **PGlite vs SQLite:** **PGlite.** Preserves pgvector + full SQL
  surface; don't create a parallel data layer.
- **Goal template count for v1:** **5.** Demo quality > count.
- **Watcher firing rate:** **per-watcher cooldown + daily global
  interrupt budget.** Deterministic. No LLM interrupt gate in v1.
- **Canvas pop-out window:** **menubar only in v1.** Pop-out can come
  in v1.1 if needed for marketing assets.
- **When does Lobu org-tier surface in owletto:** **settings-only,
  specific copy.** "Sync your goals across devices / share with your
  team via Lobu" — not generic "Connect to org."
- **Default sync folder:** **`~/lobu/`.** Not `~/owletto/`. The folder
  is a Lobu project, not an owletto-specific format.
- **Sync trigger:** mutation-driven, debounced ~500ms. Not on every
  DB write.
- **iCloud as default sync location:** **no, v1.1.** Default to local
  filesystem. Users can move dir into iCloud Drive manually; document
  the recipe.
- **macOS surface abstraction:** **`LocalSurface` adapter**, not a
  chat-platform connection. Don't leak chat-shape contracts into a
  canvas/event surface.

## Open decisions (still need answers)

- **Chrome extension repo split:** keep sources in lobu repo (shared
  via workspace/submodule, owletto produces branded build) or fork to
  owletto repo? **Default: keep in lobu.** Re-evaluate if divergence
  becomes painful.
- **Existing Mac app sync services** — Photos, HealthKit, WhatsApp,
  Obsidian, Screen Time. Which ship enabled by default in v1? Each
  adds permissions/privacy load. Suggest: **Screen Time + browser
  profiles + local directories** on by default; others off, surface
  in settings.
- **Owletto release channel & code signing.** Mac App Store vs direct
  distribution + Sparkle? Existing `apps/mac/sparkle/` suggests
  direct distribution is already the path. Confirm before M2.
- **Bundled CLIs:** if user has none of Claude Code / Codex / Gemini
  / OpenCode installed, what does owletto do? Offer to install
  Claude Code (Anthropic's installer) during onboarding? Or refuse
  to proceed and surface a docs link? Suggest: refuse + docs link
  for v1 (clean failure mode; no scope creep into agent installation).
