# Owletto for Chrome — v1 scope

## In v1

- **OAuth device-authorization pairing.** Same RFC 8628 flow the Mac app uses
  (`apps/mac/Lobu/OAuthClient.swift`). No new gateway endpoint required.
- **`chrome.tabs` connector.** Minimal end-to-end demo: lists the tabs
  currently open in the paired Chrome profile as `tab_snapshot` events. Single
  batch per run, no heartbeat. Cloud-side definition in
  `packages/connectors/src/chrome_tabs.ts`; extension-side executor in
  `apps/chrome/background.js:executeRun`.
- **Per-Chrome-profile device.** Each Chrome profile is its own paired device
  in the gateway, with its own scoped token and connection-pinning eligibility
  (`connections.device_worker_id`).
- **`browser.tabs` capability.** Tab listing, opening, closing, focusing,
  visible-tab screenshot.
- **`browser.scripting` capability.** `chrome.scripting.executeScript` for
  the active tab (gated by `activeTab` consent — no `<all_urls>` baseline).
- **`browser.debugger` capability.** `chrome.debugger.attach` per-tab CDP
  control for the active/approved tab. Detaches immediately after each
  command.
- **`browser.history` (opt-in).** Backfill + `onVisited` live sync into the
  Owletto events stream. Requested at runtime via
  `chrome.permissions.request()` — not in the static manifest.
- **`browser.bookmarks` (opt-in).** Same shape as history.
- **iframe sidepanel.** Embeds `https://owletto.ai/embedded`. No native chat
  UI in the extension; the embedded app drives the conversation.
- **Typed postMessage bridge.** Named ops only, origin-checked, deny-by-default.
- **Toolbar icon → open sidepanel** for the current window.
- **Repair / re-pair flow** triggered by gateway 401.

## Backlog (v2+)

- **Real run executor.** The v1 executor handles a single connector
  (`chrome.tabs`), one batch per run, no heartbeat or partial-progress
  reporting, no action runs, no checkpointing. v2 needs:
  * Heartbeat loop (`/api/workers/heartbeat`) so long-running streams don't
    get reclaimed.
  * Multi-batch streaming for connectors that emit > N items.
  * Action-run dispatch (`action_key` + `action_input` → `/api/workers/complete-action`).
  * Checkpointing for incremental sync.
  * Error classification (transient vs. terminal) and retry hints.
- **Connectors using debugger / scripting capabilities.** With the v1
  `browser.scripting` and `browser.debugger` caps already advertised, the
  natural next connectors are `chrome.page_text` (active-tab DOM scrape),
  `chrome.page_screenshot`, and `chrome.fill_form`. Each needs its own
  definition file and executor branch.
- **Native-messaging SSO with the Mac bridge.** First cut landed:
  * Gateway: `POST /api/me/devices/mint-child-token` mints a PAT bound to a
    new `chrome-extension` worker_id (auth: caller's bearer).
  * Mac app: `ChromeBridgeHost.swift` — `runHostIfRequested()` runs the
    native-messaging stdin/stdout cycle on `--owletto-bridge`,
    `installManifests(...)` drops `ai.owletto.bridge.json` into each
    Chromium-family browser's `NativeMessagingHosts` dir. Reads existing
    Mac creds from `KeychainTokenStore`.
  * Extension: `pairing.js` attempts `chrome.runtime.connectNative` on
    first run; succeeds → stores `{gateway_url, worker_id, access_token}`
    and skips OAuth. Falls back to the URL + OAuth flow when native
    messaging times out or returns an error.
  * **Outstanding (next slice):** `ChromeBridgeHost.swift` needs to be
    added to the Xcode project's Lobu target (drag-and-drop in Xcode).
    Until then `LobuApp.swift`'s `init()` won't compile.
  * **Outstanding:** Web Store extension ID isn't known yet; only the
    `LOBU_OWLETTO_CHROME_EXTENSION_ID` env override drives the manifest's
    `allowed_origins`. Once the extension is published we hardcode that ID
    too.
- **`browser.cookies` permission.** High-trust, low-ROI. Owletto-web has its
  own session — we don't need to forward the user's Chrome cookies to the
  agent.
- **Other Chromium browsers** (Edge, Brave, Arc). Same architecture; per-
  browser external-extensions paths in the Mac bridge installer.
- **Firefox / Safari.** Different extension model. Wait for demand.
- **Per-tab automation UI overlay.** Visible "agent is working on this tab"
  indicator + stop button injected via `scripting.executeScript`.
- **Stealth / scrape mode.** Stays out of the extension. The agent's own
  headless browser is the Playwright skill on the worker host — separate
  product surface entirely.
- **Multi-window orchestration UI.** Group/ungroup tabs, snap windows.

## Known follow-ups (security review)

- **Native host argv check is necessary but not sufficient.** Any local
  process running as the same user can exec the Mac binary with
  `chrome-extension://…` as `argv[1]` and ask for a child token. Chrome's
  `allowed_origins` only guards `connectNative` — not the binary's own
  surface. Mitigations to evaluate: (a) extension-side nonce stored in
  `chrome.storage.session` proven via a follow-up native-messaging round,
  (b) require an in-app UI confirmation in the Mac app for each new pair,
  (c) bind the minted PAT to the extension ID via a server-side check at
  first poll.
- **Worker tokens not yet bound to `worker_id`.** The mint endpoint
  returns a fresh `worker_id` + PAT, but `/api/workers/poll` accepts any
  `worker_id` posted by a valid bearer. A leaked child PAT can impersonate
  arbitrary `worker_id`s under the same user. Add a `worker_id` claim to
  the PAT (or a separate `device_worker_tokens` row) and enforce it in
  worker-auth.
- **Extension advertises capabilities ahead of executors.** `manifest.json`
  declares `scripting` + `debugger` at install time and
  `DEFAULT_CAPABILITIES` includes them, but `executeRun()` only handles
  `chrome.tabs`. A connector that requires `browser.scripting` or
  `browser.debugger` would be claimed and immediately fail. Either drop
  the advertised set to `["browser.tabs"]` until the executors land, OR
  ship per-cap executors before declaring them.

## Known risks

- **Web Store review on `debugger`.** Chrome scrutinizes this; have a clear
  privacy-policy line and demo video explaining "AI agent automation on
  user-approved tabs." Precedent exists (the Peerbot/termos-sandbox extension
  cleared the same set).
- **MV3 remote-code policy on the iframe.** The sidepanel iframe loads
  owletto-web's `/embedded` route. This is allowed (we're framing a web app,
  not loading executable extension code from the network) but reviewers
  sometimes flag it. The defense is that all privileged behavior is local in
  `bridge.js`, gated by a fixed allowlist of named ops, and the iframe is
  treated as untrusted on every message.
- **Service worker lifecycle.** MV3 service workers can be evicted; the poll
  loop is re-armed on `onStartup`, but long-running CDP attaches need to be
  resilient to eviction. v1 detaches immediately after each command to avoid
  this.
- **No silent install.** `External Extensions` JSON triggers Chrome's
  "External program installed this extension. Enable?" prompt — the Mac
  bridge can't bypass it. Document the one-click confirm in the Mac app's
  installer copy.
- **Multi-profile UX.** Users with several profiles get one device per
  profile. The Mac bridge menu bar exposes per-profile state; we need to
  guard against confusing "Default / Profile 1 / Profile 2" labels and show
  friendly account-email labels instead.
