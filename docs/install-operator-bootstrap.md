# Install-operator bootstrap

## Problem

A fresh `lobu run` boots with an empty `user` table. The CLI (and the macOS
menu bar) start by calling `POST /api/local-init`, which today returns
`no_user_yet` and tells the caller to point a browser at `/sign-up`. That
works on a developer laptop with a browser; it does not work in CI, in
containers, or in a `/tmp` scaffold where no SPA is reachable. The first
non-desktop install can't authenticate, can't `lobu apply`, can't do
anything — a chicken-and-egg.

Closing #917 removed an over-engineered fix (pairing URL file, single-use
PAT column, `POST /auth/pair-token`, `/auth/enrol-credential` SPA page,
custom OTP table). The actual gap is much smaller.

## Design

At first `lobu run` boot, `start-local.ts` calls `ensureInstallOperator()`
before `httpServer.listen(...)`. The function:

1. Checks for a `user` row with `principal_kind = 'install_operator'`.
   If present → no-op (idempotent).
2. If absent, inserts:
   - One `user` row, `principal_kind = 'install_operator'`,
     `email = install@<hostname>` (deterministic, no PII collected),
     `name = "Local Install"`.
   - One `account` row with `providerId = 'credential'`,
     `password = await hashPassword(ENCRYPTION_KEY)` — the existing
     `@better-auth/utils/password` hasher used for every email-password
     account on the install.
   - A personal organization for the operator (re-use
     `ensurePersonalOrganization` from `auth/personal-org-provisioning.ts`,
     and `ensureDefaultAgent` from `auth/default-provisioning.ts` so the
     install ships with the default agent without waiting for a second
     boot).

`ENCRYPTION_KEY` is the random secret already generated in `.env` for
at-rest encryption. Making it serve double duty as the install operator's
sign-in credential removes the need for a separate install secret and
matches what's already in operator muscle memory.

`principal_kind` is a new `text NOT NULL DEFAULT 'human'` column on
`user`. The discriminator lets every surface that filters humans (signup
count, member lists, password reset, magic link, OAuth account-linking,
admin user lists) exclude the install operator with a single predicate:
`WHERE principal_kind <> 'install_operator'`.

A centralised helper `isInstallOperator(user)` plus a server-side helper
`isInstallOperatorRow(row)` keep the carve-out logic in one place so we
can extend it without grep'ing for the predicate.

## Client flows

| Client | Path | New code? |
| --- | --- | --- |
| CLI on install host (`lobu apply`, `lobu chat`) | Existing `POST /api/auth/sign-in/email` with `email=install@<hostname>` + `password=ENCRYPTION_KEY` | No |
| Loopback menubar / web first sign-in | Existing `POST /api/local-init` (loopback-only) — install_operator now exists, so it short-circuits to a session immediately | No |
| Cross-machine first sign-in | SPA login → operator pastes `ENCRYPTION_KEY` once → enrol passkey via existing settings page | Tiny copy hint |
| Second device | Browser-native WebAuthn cross-device verification (caBLE / hybrid) — already wired via `@better-auth/passkey` | No |
| Multi-tenant install (team org) | Standard `/sign-up` flow; install_operator coexists silently with humans | No |

## Out of scope

The following machinery from PR #917 is **deliberately not in this design**.
Codex review showed each is redundant with existing infrastructure:

- **Pairing URL file** — superseded by SPA login + WebAuthn cross-device.
- **`single_use = true` PAT column** — superseded by better-auth sign-in.
- **`POST /auth/pair-token`** — superseded by `POST /api/auth/sign-in/email`.
- **`/auth/enrol-credential` SPA page** — superseded by the existing
  passkey enrolment in the settings page.
- **Custom `pairing_otps` table** — never needed; the SPA paste-once flow
  uses the operator's existing `ENCRYPTION_KEY`.
- **v2 "vault-wrapping" layer** — `ENCRYPTION_KEY` already does both jobs
  (at-rest encryption *and* the install secret), so v1 ≡ v2.

## Security considerations

`ENCRYPTION_KEY` today is a server-side at-rest key — possession of `.env`
is already total compromise (read every encrypted secret in Postgres).
Making it *also* the install operator's auth credential means it may now
touch surfaces it didn't before:

- It can enter a browser address bar / DOM during the SPA paste-once flow.
- Browsers may offer `navigator.credentials.store` for it.
- It can appear in password-manager autofill, in screenshots, in shoulder
  surfing.

Trade-offs:

- The SPA login screen sets `autocomplete="off"` on the install-secret
  field by default; operators who *want* the password manager hint can
  enrol a passkey instead and never paste it again.
- The synthetic `email = install@<hostname>` is not a real address. No
  password reset / magic link can be sent to it, which is fine because
  the carve-outs below reject those flows anyway.

Carve-outs (one predicate, applied at each surface):

- `databaseHooks.user.create.before` — install_operator excluded from the
  "deployment already has a user" count, so the first human signup can
  still proceed in single-user mode.
- `getAuthConfig().hasUser` — same predicate, so the SPA gateway knows
  "the install has a *human*" not "the install has the operator row".
- `sendResetPassword` / `sendMagicLink` — reject when the target user has
  `principal_kind = 'install_operator'`.
- OAuth account-linking — reject when the linking target is the install
  operator (we don't want the operator row to accumulate social identities).
- Member listing / org member UI — filter out install_operator so it
  doesn't appear in human-discovery surfaces.

## Migration of existing installs

On next boot, every existing install auto-provisions its install_operator.
Existing human users with normal email + password accounts keep working —
their auth is independent of the operator row. No user-visible disruption.
The `principal_kind` column defaults to `'human'` for every pre-existing
row, so existing predicates that used to filter `WHERE id <> 'bootstrap-user'`
(legacy, pre-#902) can be replaced with the cleaner
`WHERE principal_kind <> 'install_operator'`.

## Stage 2 implementation files

- `db/migrations/<next-version>_principal_kind.sql` —
  `ALTER TABLE "user" ADD COLUMN principal_kind text NOT NULL DEFAULT 'human'` +
  `CREATE INDEX idx_user_principal_kind ON "user" (principal_kind)`.
- `packages/server/src/auth/install-operator.ts` (new) —
  `ensureInstallOperator()`, `isInstallOperator(user)`,
  `INSTALL_OPERATOR_KIND` constant.
- `packages/server/src/start-local.ts` — call `ensureInstallOperator()`
  before `httpServer.listen(...)`.
- `packages/server/src/auth/index.tsx` — magic-link / password-reset
  guard, signup-blocking hook predicate update.
- `packages/server/src/auth/config.ts` — `hasUser` predicate update.
- `packages/server/src/auth/routes.ts` — `/api/local-init` no longer
  returns `no_user_yet` for the operator-only state (defensive 500 if
  it ever does).
- `packages/owletto/src/app/auth/login.tsx` — copy hint on the login
  page pointing at `ENCRYPTION_KEY` (deferred to a follow-up owletto PR
  + submodule bump; the backend lands first).
- Tests in `packages/server/src/auth/__tests__/install-operator.test.ts`
  and `packages/server/src/__tests__/integration/auth/install-operator.test.ts`.
