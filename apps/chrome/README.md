# Owletto for Chrome

Chrome extension (MV3) that lets Owletto agents see and act on the user's
Chrome profile — tabs, optionally history and bookmarks, and (with the
`debugger` permission) CDP-level page control on user-approved tabs.

This is one of three Owletto device clients alongside `apps/mac/` and
`apps/ios/`. The gateway treats it like any other device: it polls
`/api/workers/poll` with `platform: "chrome-extension"`, advertises a
capability set, and is gated by the platform allowlist in
`@lobu/core/capabilities`.

## Layout

| File             | Purpose                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `manifest.json`  | MV3 manifest. `debugger`/`tabs`/`scripting`/`activeTab` baseline, `history`/`bookmarks` opt-in. |
| `config.js`      | Build-time-ish constants (gateway URL, native host name, embedded app URL).               |
| `background.js`  | Service worker: pairing, poll loop, token storage.                                        |
| `bridge.js`      | Typed postMessage broker between the sidepanel iframe and the service worker.             |
| `sidepanel.html` | Shell. Mounts owletto-web `/embedded` in an iframe when paired.                           |
| `sidepanel.js`   | Iframe ↔ service-worker bridge with origin checks and correlation IDs.                    |
| `pairing.html`   | Device-code/QR pairing fallback when no Mac bridge is present.                            |
| `pairing.js`     | OAuth device-authorization polling loop.                                                  |

## Setup + pairing flow

Lobu/Owletto is self-hosted, so the extension does not ship with a fixed
gateway URL. First-run setup has two steps:

1. **Pick a server.** The user enters their Lobu/Owletto URL. The extension
   requests an origin-scoped Chrome host permission for that URL, then
   verifies the server speaks Owletto by fetching
   `/.well-known/oauth-authorization-server`. The URL is persisted to
   `chrome.storage.local` under `owletto.gatewayUrl`.

2. **OAuth device-authorization pairing** (standard RFC 8628, identical to
   what the Mac app does in `apps/mac/Lobu/OAuthClient.swift`):
   - GET `/.well-known/oauth-authorization-server` → discovery doc.
   - POST `registration_endpoint` → dynamic client registration.
   - POST `device_authorization_endpoint` → `device_code` + `user_code`.
   - Open the verification URI in a tab; poll `token_endpoint` until it
     returns an `access_token`.
   - Persist `{workerId, accessToken, refreshToken, clientId,
     clientSecret?}` in `chrome.storage.local`. The service worker drives
     the poll loop with `{worker_id, bearer access_token,
     platform: "chrome-extension"}` from there.

The permissions page (`permissions.html`) shows the configured server and
exposes a "Change" action that clears the URL + credentials and re-runs
setup.

Native-messaging SSO with the Mac bridge (skip the second login when Mac is
installed) is a v2 backlog item — see `SCOPE.md`.

## Capabilities

Baseline (declared in `manifest.json`):

- `browser.tabs`
- `browser.scripting`
- `browser.debugger`

Opt-in via `chrome.permissions.request()` at runtime (and only declared once
granted, so the install-time consent string stays short):

- `browser.history` (requires the `history` Chrome permission)
- `browser.bookmarks` (requires the `bookmarks` Chrome permission)

The gateway re-authorizes the advertised set against the platform allowlist
in `@lobu/core/src/capabilities.ts`. Anything outside is dropped on the
server side regardless of what the extension claims.

## Local development

This scaffold is not packaged for the Web Store yet. To load it unpacked:

1. `chrome://extensions` → "Developer mode" → "Load unpacked" →
   `apps/chrome/`.
2. Click the toolbar icon → "Pair this profile". On first run the pairing
   page prompts for the gateway URL — `http://localhost:8787` is pre-filled
   for local dev.

## See also

- `SCOPE.md` — what's in v1 vs. backlog.
- `packages/core/src/capabilities.ts` — server-side capability allowlist.
- `packages/server/src/worker-api.ts` — `/api/workers/poll` handshake.
