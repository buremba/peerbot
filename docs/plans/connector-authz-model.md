# Connector authorization & data attribution model

Status: design / RFC. Builds on `authz-acl-permission-program.md` (the access-graph
engine + fail-closed resource-visibility gate, already live for Slack + GitHub) and
`feeds-and-connections-model.md`.

## Problem

For team/work tools (Jira, Linear, GitHub, Slack), we have to decide how a connector
is authorized and how its data is attributed to users:

- **Per-user**: each user authorizes their own account; we only ever see their slice.
  Simple permissions, but no shared picture and no cross-user reasoning.
- **Org scrape + attribute**: an admin connects once, we ingest the full picture, and
  each user only sees the subset they're allowed to see in the source tool.

Decided requirements (from product):

1. The agent must answer **both** personal ("my tickets") and org-wide ("sprint status,
   who's blocked") questions.
2. Setup is **admin once, with optional per-user** connections layered on.
3. Visibility is a **strict mirror, fail-closed** of the source tool's own permissions.
4. Whether we need data the admin token can't see (private/restricted) is **undecided**.

## How Claude / ChatGPT connectors do it (reference point)

They use **pure per-user OAuth + live retrieval**. You add a connector, authorize it with
your own account, and at query time the model calls the remote MCP server **with your
token**. Access is **delegated to the source** — you see exactly what your token can see,
enforced by Jira/GitHub, not by the assistant. There is **no central scrape**, so there is
**nothing to attribute**: every request already runs as the asking user.

The cost of that simplicity is exactly the capability Lobu exists to provide: a shared,
persistent, cross-user picture. The moment you keep a central copy you inherit the
attribution problem Claude designed around. **The ACL mirror is the price of the shared
corpus** — you cannot have Lobu's shared memory *and* Claude's "no attribution needed."

## How Glean / Copilot do it (the org-backbone reference point)

Glean is the canonical "org backbone + ACL mirror" product, and it shows the identity step
done well: the **admin** connects each source once and Glean crawls everything, mirroring
each document's **ACL** into the index. The **user logs in once via SSO** — never to the
individual tools. Identity is **federated from a shared corporate IdP** (Okta/Google/Azure
AD): the SSO assertion gives an *authoritative, verified* email/subject, and because every
source sits behind that same IdP, "this user = this Jira accountId = this GitHub SAML
identity" is a SCIM directory lookup, not a guess. Microsoft Copilot does the same via
Azure AD/Graph.

Takeaway: requiring users to log into every tool individually is *more* friction than Glean
and is only necessary when there is **no** shared IdP. "Email match" is risky only when
*guessed*; from a verified SSO assertion it is authoritative — that is the whole trick.

## Recommended model: org backbone + ACL mirror + per-user overlay

A superset of Claude's model:

- **Ingest (full picture)** — admin installs one connection per source (GitHub App,
  Jira/Linear OAuth, broad scope). Everything that install can see lands in `events`.
- **Gate (per-user, fail-closed)** — the existing `authz/*` layer attributes visibility:
  map each Lobu user → their source identity; sync source membership (repos/projects/teams)
  on a cron; `resource-visibility` shows an event iff the user is `member_of` its resource;
  unknown/stale membership → hidden. "Both" falls out for free — org-wide is the same gate
  for a user whose membership spans the org; "my tickets" is the same gate filtered to one
  person. One mechanism, not two code paths.
- **Overlay (optional per-user)** — a user connects their own account to reach what the
  admin token can't (restricted projects, private repos/DMs). Ingests tagged to them; the
  gate naturally shows it only to them. This sub-path **is** Claude's model.

### Phasing

- **P1 — per-user (Claude-style).** Per-user connect via `manage_connections` (already
  returns `connect_url`; the agent sends it in chat). Source-enforced, zero new ACL work.
  Safe default for any source, and the only viable mode for personal sources (Gmail, bank).
- **P2 — org backbone + gate, per source.** Admin org connection + an ACL sync + a
  `sources.ts` entry + the connector stamping the resource id. Per the authz program, a new
  source is "1 `sources.ts` entry + connector stamp, no gate/engine change."
- **P3 — per-user overlay for gaps.** Only build per source when a real private-data gap
  bites (resolves requirement #4: don't speculate).

### In-chat "needs auth" UX

P1: the agent just sends the `connect_url` as a message (no new infra; reliable because
it's a normal assistant turn). Later: reuse `postLinkButton` (the `oauth` linkType already
exists and rides owner-routed delivery) for a button affordance. Do **not** reuse
`status-message:created` (wrong semantics; currently orphaned).

For a **not-logged-in** user the connect step *is* the identity step: the OAuth round-trip
both authenticates them and links their source identity. An unlinked user has no membership
→ fail-closed → sees nothing → the agent prompts "sign in here to connect."

## Gaps & open questions

Ordered by how much they threaten the stated requirements.

1. **Identity link in pure-backbone mode (the model's structural hole).** The gate needs an
   authoritative Lobu-user → source-identity mapping. In backbone mode the user never
   connects their own account, so there's no OAuth to prove the link. Options: admin-provided
   mapping (SCIM/CSV), a grant-nothing "verify your GitHub" OAuth, or directory email-match
   (risky — wrong mapping over-shares). **Must not guess by email.** This is the prerequisite
   the backbone model doesn't supply on its own.

2. **Granularity mismatch vs "strict mirror" (req #3).** The gate is resource-membership
   (repo/project). Sources have finer ACLs: issue-level restrictions, Jira field-level
   security, private comments, confidential issues, draft PRs. Repo/project membership is
   **coarser than the source**, so a project member could see a restricted issue they
   couldn't see in Jira — which violates "strict mirror." Either ingest the finer ACL
   (expensive) or consciously accept coarser-than-source and downgrade the promise to
   "resource-level mirror."

3. **Derived-data leakage.** Per-event gating is not enough. Summaries, embeddings, entity
   fields, watcher outputs, and `metric_layer` rollups computed over the full corpus can leak
   restricted info to a user who can't see the underlying events. Derived/aggregate layers
   need the same gate (or per-audience computation), or they're a side channel.

4. **Write-back = confused deputy.** Reads can use the backbone, but **actions** (create
   issue, comment, merge) must run as the user, not the admin token — otherwise the agent
   performs writes the user isn't allowed to make. Strongly implies the per-user overlay (P3)
   is required for *writes* even where reads use the backbone. Decide: block writes without
   per-user creds, or require overlay for any write.

5. **Partial org-wide results.** A user not in every project gets a rollup of only their
   accessible subset. Does the agent silently return a partial "sprint status," or disclose
   "limited to what you can access"? Silent truncation is a correctness/trust issue.

6. **Revocation latency.** Membership syncs on a cron (e.g. */15). Between a source-side
   permission removal and the next sync there's a window. Fail-closed handles *unknown*
   membership (over-hide, safe) but a freshly-*revoked* user may still see data until resync.
   Document the SLA; consider event-driven invalidation for high-sensitivity sources.

7. **Concentration of risk.** The org backbone makes a central copy of potentially very
   sensitive data whose only protection is the gate. A gate bug → mass leak. Minimize ingest
   scope, encrypt at rest, audit recall. The blast radius is strictly larger than Claude's
   per-user model.

8. **Sources without an ACL API.** The gate needs a queryable membership/ACL source
   (GitHub collaborators, `conversations.members`). Webhook/email/CSV feeds expose none →
   fail-closed (nobody sees anything) or org-wide-visible (violates strict mirror). Per-source
   decision.

9. **Backbone + overlay dedup.** If both the org backbone and a user's overlay ingest the
   same resource, events double-count in memory/metrics. Cross-path dedup (different
   connection sources, same upstream object) is new vs the existing single-path advisory-lock
   dedup.

10. **Scrape cost/scale.** Full-org history ingest is expensive (storage + embeddings; see
    prior embed-backfill incidents). May need selective/lazy/recent-window ingest rather than
    "scrape everything."

11. **"Empty" disambiguation for UX.** The agent should distinguish "empty because you have
    no access" from "empty because there's no data," to give a useful message (prompt connect
    vs say nothing found).

## Decisions made (2026-06-29)

- **D1 — Identity link: hybrid (IdP-federated + verify-OAuth fallback).** SSO orgs federate
  identity from the verified SSO assertion + SCIM (Glean-style, login once); no-SSO/personal
  accounts fall back to one-click per-source verify-OAuth (Claude-style). Authoritative in
  both modes — never email-guessing. Slots into the existing `$member` identity collapse
  (`auth:signup` identity).
- **D2 — ACL fidelity: resource-level, upgrade per source.** Ship repo/project-membership
  gating now (reuses the engine); tighten to sub-resource only where a source needs it. The
  promise is "resource-level mirror," tightened per source — not a blanket "exactly matches
  the source." High-sensitivity sources needing sub-resource fidelity are candidates to stay
  per-user (Claude-style) instead of joining the backbone.
- **D3 — Writes: require per-user creds.** Reads may come from the backbone, but any action
  (create/comment/merge) runs as the user's connected account. No admin-token writes
  (confused-deputy). Implies the per-user overlay is a prerequisite for write-enabled tools.
- **D4 — Partial results: disclose when likely incomplete.** The gate must emit a "rows were
  filtered" signal; the agent flags "limited to what you can access" only when it fires.
  Requires a filtered-count signal out of `resource-visibility`.
- **D5 — First source: GitHub.** Repo-collaborator ACL sync already exists; resource = repo;
  GitHub App = clean org backbone. Lowest new work, best end-to-end proof of P2.

### Identity & login — what ships today (no enterprise layer needed)

The D1 identity link works on the OSS path now: better-auth `genericOAuth` + built-in
`socialProviders`, credential-resolved **per org** (an org can use its own OAuth app). So
"log in with your company Google/GSuite (or GitHub, or any OIDC provider) and see only your
data" works today — the access decision uses the user's *verified* login identity + the
**source's own ACL** (GitHub collaborators, Slack channels). No SCIM or directory sync is
required for a connector vertical.

The enterprise identity layer — SAML, SCIM provisioning, enforced/domain-routed SSO, and
IdP-group→access federation — is intentionally **kept out of this OSS core** and speced
separately as a closed layer (owletto `docs/enterprise-idp-rfc.md`). It plugs in via the
existing seams (the better-auth `plugins` array + the authz `sources.ts` registry) without
forking core, and is additive — verticals ship on the path above first.

### Implied next steps
1. GitHub P2 vertical: org-App backbone connection + confirm repo ACL sync feeds the gate +
   connector stamps repo resource id (per the authz program, mostly wiring an existing path).
2. Identity: SSO/SCIM-federated identity link (D1) + verify-OAuth fallback; map onto `$member`.
3. Gate signal for D4 (filtered-count) surfaced to the worker for disclosure.
4. Write path (D3): per-user-cred requirement enforced at the connector-operation layer.
5. Derived-data gating (gap #3) and backbone/overlay dedup (gap #9) before scaling beyond
   one source.
