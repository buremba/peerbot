# Owletto for Chrome — v1 scope

## In v1

- **OAuth device-authorization pairing.** Same RFC 8628 flow the Mac app uses
  (`apps/mac/Lobu/OAuthClient.swift`). No new gateway endpoint required.
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

- **Native-messaging SSO with the Mac bridge.** When the Owletto Mac app is
  installed, skip the device-code typing step by minting a scoped child
  worker token through `chrome.runtime.connectNative`. Adds one
  gateway endpoint (mint-child-token) and a native-messaging host in the Mac
  bundle. Re-add the `nativeMessaging` permission and `ai.owletto.bridge`
  host name in `config.js` when this lands.
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
