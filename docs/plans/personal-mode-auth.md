# Personal-mode auth for the Mac menu bar app

> **Note:** The Mac app + Chrome extension live in `lobu-ai/owletto` as of
> #TBD. Mac-side changes specified in this plan happen in that repo;
> server/gateway/auth changes (the majority of this plan) still happen here
> in lobu. Cross-repo paths below reference `lobu-ai/owletto: apps/mac/…`.

## Goal

When the macOS menu bar app starts the embedded Lobu server on this Mac, replace the OAuth device flow with a frictionless local-only auth model. The Mac user becomes the Lobu user automatically. No sign-in screen, no device code, no email entry.

## Non-goals

- Multi-user / org / team auth on the same install. If a user wants that, they run Lobu directly (`lobu run`, Docker, K8s) and the Mac app's "Remote" field points at it.
- Replacing Better Auth / OAuth in the gateway. This work *adds* a local-mode path that integrates with existing auth, not replaces it.
- Migrating a personal-mode install into a cloud account. Treated as a one-way choice for v1; export/import is a follow-up.

## What already exists in `main` (audit results)

This section anchors the design to actual code so we don't propose duplicates.

| Concern | Existing code | Reuse / extend? |
|---|---|---|
| Loopback validation | `packages/server/src/start-local.ts:82` checks `127.0.0.1` / `localhost` / `::1` | **Extend** — add bind+verify semantics, refuse `0.0.0.0`/external. |
| Localhost URL validation | `packages/server/src/gateway/auth/oauth/utils.ts` | **Reuse** — same helper. |
| User + org auto-provision | `ensurePersonalOrganization()` (in `personal-org-provisioning.ts`) — idempotent, slug collision + reserved names handled, anchors via `personal_org_for_user_id` metadata | **Reuse** — call from local-mode bootstrap with a synthesized user record instead of a Better-Auth-issued one. |
| Keychain | `lobu-ai/owletto: apps/mac/Lobu/KeychainTokenStore.swift` — service `ai.lobu.mac`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | **Extend** — add a separate Keychain account key for the personal-mode secret, same service. |
| CORS / cookie credentials | `packages/server/src/index.ts:266` — `isAllowedCorsOrigin()` checks localhost variants, `credentials: true` | **Extend** — fold CSRF middleware (Sec-Fetch-Site / Host / Content-Type / custom-header) into the same chain. |
| Data dir | `LOBU_DATA_DIR` env (defaults `~/.lobu/data`), set by `LocalLobuRunner.swift:74` | **Extend** — switch menu bar to per-user subdir (`~/.lobu-menubar/<NSUserName>/data`). |
| Bind port | `LocalLobuRunner` hardcodes `:8787` | **Replace** — per-user free port discovery. |
| Better Auth sessions | Used by the web SPA | **Integrate** — local-mode bootstrap mints a Better Auth session for the local user, so the SPA needs zero changes. |

Genuinely missing (the surface this doc specifies):
- Secret bootstrap channel (stdin handshake) and `LOBU_PERSONAL_MODE=1` env.
- `personal.marker` data-dir file + startup refusal logic.
- `personalAuth` middleware (Bearer + `X-Lobu-Client`).
- Bootstrap-token endpoints (`/__local/bootstrap`, `/__local/exchange`).
- Tunnel detection.
- Per-user free port allocation.
- Reset / desync recovery path.

---

## Auth model

Two distinct authenticated paths, each fit for purpose.

### 1. Menu bar app ↔ embedded server

**Secret provisioning at server startup — stdin handshake.** No env var (leaks via same-user `/proc` or `ps auxe` on Linux; even on macOS it's a softer surface than stdin). No argv (visible in `ps`). No disk artifact (extra surface to manage).

Sequence:

1. Menu bar app generates a 32-byte random secret (base64).
2. Menu bar app writes Keychain entry: service `ai.lobu.mac`, account `personal-auth-token`, accessibility `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
3. Menu bar app spawns `lobu run` with stdin attached, `LOBU_PERSONAL_MODE=1` + `LOBU_DATA_DIR=<per-user>` + `--bind 127.0.0.1` + `--port 0` (request a free port).
4. Menu bar app writes a single JSON line to stdin and closes the write half:
   ```json
   {
     "secret": "<base64-secret>",
     "identity": {
       "handle":       "<NSUserName()>",
       "display_name": "<NSFullUserName()>",
       "hostname":     "<Host.current().localizedName>"
     }
   }
   ```
5. Server reads the line on boot, validates personal mode, stores the secret in memory, and:
   - Reads/writes `personal.marker` in the data dir (see §Boundaries).
   - Calls `ensurePersonalOrganization()` with the supplied identity (synthesized email = `<handle>@<hostname>.local`, `auth_provider="local"`).
   - Binds the listener and verifies `server.address()` is loopback (see §Boundaries).
   - Prints `LOBU_LISTEN_PORT=<port>` to stdout as the first line, terminated with `\n`.
6. Menu bar app reads that line to learn the actual port and persists it to `~/.lobu-menubar/<NSUserName>/port`.

Why stdin: it's not visible to `ps`, doesn't land on disk, and the parent-child pipe is exclusive — no other process can read it. Same-user processes with `ptrace`/`task_for_pid` can still attach and read the running server's memory, but at that point the whole user account is compromised; same threat boundary as the Keychain itself.

**Steady-state auth (after first start):**

- Every menu-bar HTTP call sets:
  - `Authorization: Bearer <secret>`
  - `X-Lobu-Client: menubar`
- Server validates both. Custom header makes browser-driven CSRF preflight-only; CORS denies the preflight (see §CSRF), so a malicious site can't forge the header.
- If the server returns 401, the menu bar **deletes the Keychain entry, stops the runner, and starts fresh**. This is also the manual reset path.

### 2. Browser ↔ embedded server ("Open Lobu" flow)

The web SPA already uses Better Auth sessions. We integrate, not parallel.

Sequence:

1. User clicks "Open Lobu" in the menu bar.
2. Menu bar app calls `POST /__local/bootstrap` (authenticated with the Keychain secret). Server generates a one-time bootstrap token (32 random bytes, base64), stores **the hash** (`sha256(token)`) in an in-memory map keyed by hash, with TTL 10 seconds and a single-use flag. Server returns the plaintext token to the menu bar.
3. Menu bar app opens `http://127.0.0.1:<port>/?bootstrap=<token>` in the user's browser.
4. The SPA's bootstrap handler (small new entry in `packages/web/src/`):
   1. Reads `?bootstrap=` from `window.location`.
   2. `history.replaceState()` immediately to strip the query (no history leakage).
   3. `POST /__local/exchange` with `{ token }` (no auth header — the token IS the auth).
   4. Server hashes the supplied token, atomically deletes the entry from the in-memory map (the `Map.delete()` return value is the only authoritative "is this the first call" signal — prevents double-submit races), verifies TTL, then calls Better Auth to mint a session for the local user. Sets the standard Better Auth session cookie (HttpOnly, SameSite=Lax, no `Secure` flag since localhost is plain HTTP).
5. Web SPA continues with the Better Auth session as normal. Existing API routes recognize it without modification.

**Session lifetime / refresh:**

- The browser session uses Better Auth's default TTL (today: 30 days). The bootstrap is fast and friction-free, so we don't try to engineer "silent refresh." When the session expires the SPA shows its existing expired-session redirect; the user clicks "Open Lobu" in the menu bar and gets a fresh session in one click.
- The 10-second TTL on the bootstrap token is for the URL handoff only — short enough that a leaked token (browser sync, screen-share) expires before it's useful.

---

## Personal-mode boundaries (structural)

The "you can't accidentally expose this" requirement only holds if enforced by the server, not by a config the user can flip.

### Bind enforcement

- Server reads `LOBU_PERSONAL_MODE=1` at boot. If set:
  - Refuse to start unless `bind` is `127.0.0.1` or `::1`.
  - After `server.listen()`, call `server.address()` and assert the result is loopback. Crash with a clear message if not.
  - Reject `0.0.0.0`, `::`, external interface IPs, and `localhost` resolutions that aren't loopback (some custom `/etc/hosts` setups).
- Extends the existing check in `start-local.ts:82` with a post-listen assertion.

### `personal.marker`

- On first server start in personal mode, write `<data-dir>/personal.marker` containing `{ "created_at": "<ISO>", "owner_handle": "<handle>" }`.
- On subsequent starts:
  - If `LOBU_PERSONAL_MODE=1` and marker present → load identity from marker, proceed.
  - If `LOBU_PERSONAL_MODE=1` and marker absent → first run (create marker).
  - If `LOBU_PERSONAL_MODE=1` unset and marker present → refuse to start. Forces deliberate migration away from personal mode (delete the marker manually is the documented one-way step).
- Marker file is the structural boundary. Mode is not a runtime flag the same data dir can flip.

### CSRF + CORS lockdown

A custom header (`X-Lobu-Client: menubar`) only helps if CORS doesn't grant it to arbitrary origins. The chain (extending the existing middleware in `index.ts:266`):

- **CORS:** allowed origins are exactly `http://127.0.0.1:<port>` and `http://localhost:<port>`. No wildcards. No reflection of `Origin`. `Access-Control-Allow-Headers` does **not** include `X-Lobu-Client` or `Authorization` for cross-origin preflights — a foreign tab's preflight fails before the actual request runs.
- **Origin / Sec-Fetch-Site:** all mutating routes (POST/PUT/PATCH/DELETE) require either:
  - `Sec-Fetch-Site: same-origin` or `Sec-Fetch-Site: none` (no-CORS, navigation), OR
  - `Origin` present and in the allowed list above.
- **Missing-`Origin` behavior:** native clients (the Mac app) often omit `Origin`. For mutating routes, require either (a) `Origin` present-and-allowed, OR (b) `X-Lobu-Client: menubar` + valid Bearer (the menu bar path). Pure missing-Origin without the Lobu client header → 403.
- **`Host` allowlist:** request `Host` header must be `127.0.0.1[:port]` or `localhost[:port]` — reject DNS rebinding attacks.
- **`Content-Type`:** mutations must be `application/json` (no `text/plain`, no `application/x-www-form-urlencoded`, no `multipart/form-data`). Defeats CSRF "simple request" posts.
- **`OPTIONS`:** preflight allowed only from same-origin; deny all cross-origin preflights silently.

### Tunnel detection (advisory, not a boundary)

Pi was right: process scanning is bypassable. We do it anyway as a hint, but the security guarantee is loopback bind + the CSRF stack above.

On startup, log a warning (not an error, doesn't refuse to start) if any of:

- `tailscaled` is running AND `tailscale status --json` shows the local node has Funnel enabled.
- `ngrok`, `cloudflared`, or `frpc` processes are running.

Surface the warning to the menu bar app via the startup-stdout protocol (one extra `LOBU_WARNING=<msg>` line). The menu bar shows it as a notification with a "Learn more" link. Reframed from the previous draft: not a refusal, an advisory.

---

## User / org auto-provision (integration with existing infra)

Reuses `ensurePersonalOrganization()`.

On stdin handshake:

1. Server checks if a user with `auth_provider = "local"` and `handle = <NSUserName>` already exists.
2. If not, inserts a user row inside a transaction with a `UNIQUE (auth_provider, handle)` constraint to prevent races. Fields:
   - `id`: UUID.
   - `handle`: `<NSUserName()>`.
   - `display_name`: `<NSFullUserName()>` (fall back to handle if empty).
   - `email`: `<handle>@<hostname>.local` (placeholder, never sent anywhere).
   - `auth_provider`: `"local"`.
   - `created_at`: now.
3. Calls `ensurePersonalOrganization(userId, { displayName, handle })`. This is idempotent today, so retries are safe.
4. The default agent is created by `ensurePersonalOrganization` already (existing behavior — verify in implementation).

If the user already exists (data dir from a previous run), step 2 is skipped and step 3 is a no-op. Bootstrap is idempotent.

Avatar / real email: not in v1. Documented in §Open questions.

---

## Threat model

| Threat | Mitigation |
|---|---|
| Network attacker on LAN reaches `:<port>` | Loopback bind enforced at server (refuses non-loopback in personal mode; post-listen assertion verifies). |
| Browser tab on the same Mac CSRFs the API | Strict CORS (no foreign-origin preflight passes for `X-Lobu-Client`/`Authorization`) + Origin + Sec-Fetch-Site + Host + Content-Type checks. |
| Other process on the same Mac (same user) reads Keychain or attaches to server memory | Out of scope — same-user adversary already owns the data. |
| Other macOS user on a shared Mac hits localhost | Per-user data dir + per-user port = each user runs their own server on their own port. A sibling user can hit `127.0.0.1:<other-user-port>` but doesn't have the Keychain secret, so all sensitive endpoints 401. CSRF stack still applies. |
| Tunnel (Tailscale Funnel / ngrok / cloudflared) exposes localhost to internet | Loopback bind doesn't prevent tunnels by itself, but: (a) advisory startup warning, (b) `Host` allowlist rejects requests with non-localhost `Host` headers (most tunnels rewrite this), (c) menu bar UI flags the warning. Not a hard guarantee; documented. |
| User configures `HOST=0.0.0.0` thinking it'll just work | Server in personal mode refuses to start with non-loopback bind. Marker enforces single-mode-per-data-dir. |
| Bootstrap token leaks (browser sync, screen-share, history) | One-time use enforced by atomic `Map.delete()`. 10-second TTL. Stripped from URL via `history.replaceState()` immediately. Stored as hash, not plaintext, so server memory dump doesn't reveal usable tokens. |
| Bootstrap token replay between server restarts | Token store is in-memory only. Server restart invalidates all tokens. |
| Long-lived Keychain secret leaks | Same boundary as user's filesystem. Mitigation: revoke + regenerate is one click ("Reset Lobu" — see §Reset). |
| Cross-tab credential confusion (a tab from Cloud thinks it's local) | Cookie scoped to `Path=/`, Better Auth issues distinct session per origin. Web SPA loaded from `app.lobu.ai` can't read a localhost cookie. |

---

## Reset / desync recovery

The Keychain and server-side `personal.marker` can desync (Keychain wiped, data dir copied to a new machine, etc). Recovery must be explicit and visible.

**Detection:**
- Menu bar app gets 401 on a steady-state call → assumes desync.

**Action:**
- Menu bar app shows: "Local Lobu is out of sync with this Mac. Reset and start fresh?" with one button.
- On confirm: delete Keychain entry, stop the runner, delete `~/.lobu-menubar/<NSUserName>/data/` (including `personal.marker`), restart the runner. Triggers the full first-launch handshake.
- Connector configs (folder bookmarks, vault selections) live in UserDefaults and survive the reset. Server-side history (events, runs) is wiped — same as a fresh install.

This is also what "Sign out" maps to in personal mode (the menu has no "Sign out" today when signed in; we add a "Reset Lobu…" item to the footer that does the above).

---

## Implementation surface area

### Server (`packages/server/src/`)

- New: stdin handshake reader at boot (before HTTP listener starts). Parses identity + secret.
- New: `personalAuth` middleware that validates Bearer + `X-Lobu-Client`.
- New: CSRF middleware (Origin / Sec-Fetch-Site / Host / Content-Type), folded into the existing CORS chain in `index.ts:266`.
- New: bind-enforcement assertion after `server.listen()`, extending `start-local.ts:82`.
- New: `personal.marker` write/read + mode-conflict refusal.
- New routes:
  - `POST /__local/bootstrap` — auth: personal-Bearer. Mints a bootstrap token. Returns `{ token }`.
  - `POST /__local/exchange` — no auth header (token IS auth). Atomically burns token, mints Better Auth session, sets cookie.
  - `GET  /__local/identity` — auth: personal-Bearer. Returns current local user info. (Optional, for the menu bar to show "Signed in as Burak Emre Kabakcı".)
- Tunnel detection: best-effort startup check, emits `LOBU_WARNING=…` to stdout.
- Print `LOBU_LISTEN_PORT=<port>` to stdout as the first protocol line after handshake.

### Mac app (`lobu-ai/owletto: apps/mac/Lobu/`)

- `KeychainTokenStore.swift`: add a `personal-auth-token` account on the existing `ai.lobu.mac` service.
- `LocalLobuRunner.swift`:
  - Pick a per-user free port (try a fixed list `8787, 8788, ..., 8800`, then fall back to `:0` if needed and read it back from `LOBU_LISTEN_PORT=` stdout).
  - Pass `LOBU_PERSONAL_MODE=1`, `LOBU_DATA_DIR=~/.lobu-menubar/<NSUserName>/data`, `--bind 127.0.0.1`, `--port <chosen>`.
  - Attach stdin pipe, write the handshake JSON on spawn, close write half.
  - Read first stdout line, parse port + warning.
  - Persist port to `~/.lobu-menubar/<NSUserName>/port` for crash recovery.
- New: `PersonalAuthClient.swift` — handles secret generation, Keychain round-trip, `Authorization` + `X-Lobu-Client` header injection on every API call, bootstrap-token mint + browser-open helper for "Open Lobu", 401 → reset trigger.
- `MenuBarContent.swift`:
  - When URL is loopback, skip the OAuth UI entirely. Button label becomes "Start" (the runner does the work; no separate sign-in step). Footer adds a "Reset Lobu…" inline-confirm action.

### Web (`packages/web/src/`)

- Small bootstrap handler in the SPA entry: reads `?bootstrap=`, `history.replaceState`, `POST /__local/exchange`, then proceeds. Treats the resulting Better Auth session like any other.
- Existing routes unchanged.

### CLI (`packages/cli/src/`)

- `lobu run`: accept `--bind`, `--port` (with `0` = OS-assigned), and read stdin for the handshake when `LOBU_PERSONAL_MODE=1`. No CLI flag changes for non-personal mode.

### Tests

- Server: stdin handshake (valid / malformed / wrong-mode), personalAuth middleware (valid / missing-header / wrong-token), CSRF (cross-origin preflight rejected, missing Origin without Lobu header rejected, wrong Host rejected, wrong content-type rejected), bootstrap (one-time, expiry, atomic burn), bind enforcement (post-listen assertion crashes on 0.0.0.0).
- Mac app: Keychain round-trip, stdin write/read, port discovery, 401 reset flow.

---

## Open questions

- **Real email detection from Contacts "Me" card.** Out of v1.
- **Avatar from macOS account picture.** Out of v1 — `~/Library/Caches/com.apple.iconservices.store` is gnarly.
- **Export to cloud.** Personal mode is one-way for v1. Future: `lobu export --personal` / `lobu import` ships events + connections + agents to a target org. Marker file is the signal.
- **Multi-server on the same Mac (e.g., dev + personal at the same time).** Per-user data dir handles separate users; for the same user running both, the menu bar uses `~/.lobu-menubar/<handle>/`, and a developer running `lobu run` directly uses whatever they configure (default `~/.lobu`). They won't collide unless the dev points at the menu bar's data dir — documented in `lobu run --help`.
- **What happens if the user kills `lobu run` from outside (e.g. `pkill`).** Menu bar's runner watcher should detect, restart with the same handshake (Keychain secret is reused). Verify in implementation.
- **"Open Lobu" when the server is stopped.** Currently the footer opens `state.baseURL` blindly. New behavior: if not running, start it first, then open. Specified in the Mac app section.

## Out of scope (do later)

- Avatar, real email, export/import, multi-server dev/personal coexistence beyond per-user data dir.
