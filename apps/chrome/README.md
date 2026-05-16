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

## Pairing flow

Standard RFC 8628 OAuth device-authorization, identical to what the Owletto
Mac app does (`apps/mac/Lobu/OAuthClient.swift` + `AppState.swift:signIn`).
No new gateway endpoint required — the extension is just another OAuth
public client.

1. GET `/.well-known/oauth-authorization-server` → discovery doc.
2. POST `registration_endpoint` → dynamic client registration.
3. POST `device_authorization_endpoint` → `device_code` + `user_code`.
4. Open the verification URI in a tab; poll `token_endpoint` until it
   returns an `access_token`.
5. Persist `{workerId, accessToken, refreshToken, clientId, clientSecret?}`
   in `chrome.storage.local`. The service worker drives the poll loop with
   `{worker_id, bearer access_token, platform: "chrome-extension"}` from
   there.

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

1. Build a sibling `dist/` if/when we add a bundler (none today — the source
   is hand-rolled MV3-friendly JS).
2. `chrome://extensions` → "Developer mode" → "Load unpacked" →
   `apps/chrome/`.
3. Point `config.js` at a local gateway URL (`http://localhost:8787`) and the
   matching `EMBEDDED_APP_URL`.
4. Either run the Owletto Mac bridge for SSO, or trigger the device-code
   fallback by clicking the toolbar icon → "Pair this profile".

## See also

- `SCOPE.md` — what's in v1 vs. backlog.
- `packages/core/src/capabilities.ts` — server-side capability allowlist.
- `packages/server/src/worker-api.ts` — `/api/workers/poll` handshake.
