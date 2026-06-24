# Plan: provider-agnostic gateway (the proper way)

## Invariant (the whole point)
Gateway CORE contains ZERO provider names — no `createGithubAppWebhookProvider`,
no `createSlackAppWebhookProvider`, no `if (JIRA_CLIENT_ID)`. Adding/iterating an
app = a CONNECTOR DECLARATION (+ at most tiny sandboxed logic). Not necessarily
arbitrary TS-URL installs, but close. One shared architecture.

## Keep (already-right primitives — do NOT rebuild)
- `app_installations` (install lifecycle, reject/transfer).
- credential resolver `app-install-credentials.ts` (env names from declaration).
- single endpoint `/api/v1/app-webhooks/:provider`.
- `connector_definitions` as the per-org declaration STORE (refresh-cron synced).

## Hard constraint
App secrets (signing secret, App private key) live in the gateway and MUST NOT reach
connector/worker code (secret-proxy invariant). => the generic ENGINE runs in core WITH
the secrets; connectors only DECLARE shape. This is why declarative-engine beats
in-sandbox verify code.

## The generic engine = three declarative seams, one per-KIND delivery

### 1. Webhook verify (declarative, covers all)
Extend the webhook schema:
- `signatureHeader`, `algorithm`, `signaturePrefix` (exist) +
- `signingBaseTemplate` (default `{body}`; Slack = `v0:{timestamp}:{body}`),
- `timestampHeader`, `freshnessSeconds` (optional replay guard).
Core has ONE `verifyDeclared(rawBody, headers, secret, schema)` covering github/jira/linear
(HMAC over `{body}`) AND slack (HMAC over `v0:{ts}:{body}` + freshness). Delete the named
verify plugins.

### 2. Tenant extraction (declarative)
`routingKeyPath` (JSON path, exists) + allow an ordered list of paths for payloads where
the id sits in multiple places (slack: `team_id` | `team.id` | `event.team_id`). Core has
ONE generic extractor. No per-provider extractTenant fns.

### 3. Install handshake (declarative shapes)
A small enum of handshakes parameterized by the declared *Key env names:
`app-install-jwt` (github: appId+privateKey mint) and `oauth-code-exchange`
(slack/jira/linear: clientId+secret+tokenUrl). Core has ONE handler per shape; the
connector declares which + its params (tokenUrl, scopes). Remove provider-specific install
code from app-install.ts.

### Per-KIND delivery (NOT per-provider)
After verify+tenant+install-resolution (all generic), what HAPPENS is dispatched by the
connector's KIND, not its name:
- `data` connector → land event / trigger feed (existing webhook-ingest path).
- `chat` platform → route to chat adapter: active app_installations install → channel
  bindings; else PREVIEW connection fallback; fail-closed otherwise. This logic is
  chat-platform-GENERIC (telegram/whatsapp reuse it), keyed off declaration, no `slack`.

### Data-driven registration
gateway iterates the catalog/DB for integration-declaring connectors and registers ONE
generic provider per declaration. No hardcoded list. This is the single change that most
directly enforces the invariant.

## Phasing (each: typecheck + tests + commit)
- A. Declarative verify schema + `verifyDeclared` engine + data-driven registration →
  DELETE named webhook plugins (github/slack/jira/linear) from core. (Keystone — proves
  the invariant for the webhook path.)
- B. Generic tenant extractor (ordered routingKeyPaths).
- C. Generic install-handshake shapes → remove provider-specific install code.
- D. Per-kind delivery handler (data vs chat); chat delivery = install→bindings→preview.
- E. `integration`-kind first-class (de-hack the throwing `sync()`).
- F. Slack manifest/event-URL → `/api/v1/app-webhooks/slack` (NO compat); migration note
  (owner reconfigures the live Slack app event URL). Doc the new bundled keys (fixes the
  CLI template-connector-keys test).

## Carry-over fixes from make review (fold into the above, don't band-aid)
- secret resolver must use declared `webhookSecretKey` (SLACK_SIGNING_SECRET), not the
  `<PROVIDER>_APP_WEBHOOK_SECRET` convention (Phase A).
- `slack.ts` `sync(_ctx)` → handled by Phase E (integration-kind has no sync()).
- document `slack` bundled key (Phase F).

## Verdict bar
make review green (typecheck+unit+integration), pi 0 blockers, core has 0 provider-name
references (grep `\"github\"|\"slack\"|\"jira\"|\"linear\"` in gateway core = only generic
plumbing, not branching). Live Slack bot e2e = owner smoke test after manifest migration.
