# WS-C — Cross-source identity bridges (GitHub committer ↔ Slack sender = same person)

> Status: plan, ready for an implementer. #1 is a cheap standalone win; the
> third-party bridge needs the merge job (#5). See [README](./README.md).

## Goal
Let the system know a GitHub commit author and a Slack message sender are the same
human, and attribute the authenticated user's Slack identity to their member
entity. Today they stay separate entities with nothing in common.

## Executive correctness summary (two findings change the design)

**Finding A — `slack_user_id` is team-scoped; the OIDC `sub` is not.** The ACL
channel graph stores `normalizeSlackUserId(teamId,userId)` = `T0XYZ:U12345`
(`connector-sdk/src/identity-normalize.ts:85-95`). The sign-in OIDC `sub`
(Better Auth `account.accountId`) is the **bare** `U12345` (`auth/config.ts:237-245`
drops team). So writing the bare `sub` as `slack_user_id` will NOT match the
channel-graph key and the ACL person keeps forking. #1 must reconstruct the
combined `T:U`, which needs the Slack `team_id` claim
(`https://slack.com/team_id`) from userinfo — available in `rawUserInfo`
(`auth/social-login-provisioning.ts:59-65`).

**Finding B — email alone CANNOT lazily bridge two already-primaried entities.**
A GitHub `person` is primaried on `github_user_id` (`github.ts:270`); a Slack
`person` on `slack_user_id` (`authz/sources.ts:36`). In `resolveLinksByKind`, when
a primary is present, resolution is governed solely by primary hits; secondary
identities (email) are only *accreted* (`entity-link-upsert.ts:643-668`), and
accretion is `ON CONFLICT DO NOTHING` (`:691-696`). The ambiguous-`>1`-skip
(`:670-681`) refuses to merge. So **two pre-existing primaried entities never merge
via email**. Therefore:
- The **authenticated-user bridge** (#1, #4) works — the `$member` is a single hub
  carrying `slack_user_id` + `email`.
- The **third-party GitHub↔Slack bridge** does NOT form by accretion — it requires
  an explicit reconciliation/merge job (#5). #2/#3 are necessary but not sufficient.

## #1 — Persist `slack_user_id` on `$member` at sign-in (CHEAP WIN, ship first)

New `persistLoginSlackIdentity` in `auth/subject-identities.ts` (reuses
`writeIdentities`), invoked from `auth/index.tsx`
`databaseHooks.account.create.after` (`:825-854`) and `.update.after`.
1. Extend `accountSummary` to capture `account.accountId` (the provider account id,
   not just the Better Auth row PK).
2. Gate on `providerId === 'slack'`.
3. Resolve the tenant `$member` via the hardened `resolveTenantMember`
   (`identity/auth-hook.ts:71-106`) — **export** it rather than duplicating the SQL.
4. Obtain `team_id`: call `fetchUserInfoWithRaw({provider:'slack', accessToken, userinfoUrl})`
   and read `raw['https://slack.com/team_id']` (one HTTP call on sign-in, fire-and-forget);
   or read `auth_data->'identity'->>'https://slack.com/team_id'` from the just-written profile.
5. `combined = normalizeSlackUserId(teamId, account.accountId)`; if null (missing
   team / malformed), log and return — never write a bare id.
6. `writeIdentities(sql, orgId, memberEntityId, 'auth:signup', [{namespace:'slack_user_id', identifier:combined}])`.
   The `'auth:signup'` source is the anti-hijack guard the channel-visibility gate trusts.

Idempotent (`ON CONFLICT … DO NOTHING`); safe from both hooks. **Immediate effect:**
the next ACL channel-graph rebuild resolves the workspace member onto `$member`
instead of forking — `resolveMembers` looks up `slack_user_id` type-agnostically and
collapses onto ANY entity carrying it (`access-graph.ts:176-225`, union `:214-223`).

**Backfill:** existing slack accounts lack the identity and we don't store team_id.
Prefer **lazy** backfill via `account.update.after` on next token refresh (zero
extra code); ship an active backfill (call userinfo per account) only if dormant
coverage matters.

## #2 — Slack sender email
Add `'users:read.email'` to `SLACK_BOT_SCOPES` (`connectors/src/slack.ts:36-56`) —
a manifest/scope change requiring workspace re-consent (existing installs keep the
old token; email capture degrades gracefully — missing email never blocks ingestion).

Add `usersInfo(botToken, slackUserId)` to `SlackWebApi` (`slack-web.ts:15-127`),
mirroring `conversationMembers`: `users.info` → `json.user.profile.email` (present
only with `users:read.email`) + `json.user.team_id`. Lives in **WS-B** (shared
low-level call); consumed by **WS-A** ingestion.

Where to write: in the channel-graph builder (`authz/slack-channel-graph.ts:84-93`),
when the scope is granted, enrich each member with `users.info` → add
`{namespace:'email', value:profileEmail}` to the member's identities, and extend
`SLACK_SOURCE.memberIdentities` (`sources.ts:36`) to include `{namespace:'email'}`.
Normalize via `normalizeEmail`. Per Finding B, this writes email onto the slack
person but does not itself merge with a github person (that's #5). Cache `users.info`
by `slack_user_id` (Tier-4 limited); never capture for `is_bot`/`is_app_user`.

**Privacy:** `users:read.email` surfaces member PII. Gate behind org opt-in (a
connection-config flag); exclude bots; document it; treat the email as consent-bearing.

## #3 — GitHub email identity — HIGHEST RISK; guardrails are the crux
Naive change: add `{namespace:IDENTITY.EMAIL, eventPath:'metadata.author_email'}` to
`GITHUB_PERSON_ENTITY_LINK.identities` (`github.ts:266-272`). `author_email` is
already stamped (`github.ts:1123`); the `email` namespace is indexed and standard.
**Done naively, this is dangerous** — commit author email is self-attested.

Over-merge failure modes:
1. `…@users.noreply.github.com` — privacy email; never a real mailbox / Slack
   profile email → merge risk, zero bridge value. **Exclude.**
2. Shared CI/bot emails (`actions@github.com`, `*[bot]@*`) — many github persons
   stamp the same email; mis-anchors it to a random human, then #5 would merge a
   human into a bot. **Exclude.**
3. Commit under a colleague's email (rebase/squash/`--author`) — self-attested,
   wrong human. No automated guardrail; argues for confidence-gating the merge.
4. One human, many emails — benign; the merge job must tolerate multiple emails.

With `github_user_id` primary, email is **accreted only**, never a resolution key on
the github side — so adding it does NOT change which github person an event resolves
to; blast radius is downstream (read-time collapse + #5).

Guardrails (layered, implement all):
- **G1 — source-level exclusion (normalize chokepoint).** In
  `connector-sdk/src/identity-normalize.ts:40-53`, reject emails whose domain is
  `users.noreply.github.com` (and the `id+user@` form) and a small denylist of
  CI/bot locals/domains. Rejecting at `normalizeIdentifier` drops them before
  `entity_identities` on ANY connector (defense in depth).
- **G2 — verified-only stamping.** In the commit event builder (`github.ts:1119-1129`),
  only stamp `author_email` into the `email` identity namespace when
  `commit.commit.verification.verified === true` (GPG/S-MIME-signed by a key GitHub
  ties to the account). Unverified commits keep `author_email` as a non-indexed
  display field only. Precision over recall — the right call for the highest-risk change.
- **G3 — confidence-gate the merge (#5), not the write.** A shared email is
  evidence, not proof: #5 merges only when the email is non-excluded and owned by
  exactly one entity on each side. Refuse merges on multiply-claimed emails (same
  spirit as the ambiguous-`>1` skip).

Recommendation: ship G1+G2 first; make #5's merge confidence-gated and **off by
default**; do NOT enable read-time email collapse for github↔third-party-slack until
G3 is in place. Writing the github email identity is safe under G1+G2; acting on it
is not without G3.

## #4 — The resulting bridge (two distinct mechanisms)
**Bridge 1 — authenticated user (works via accretion, no merge job).** After #1,
`$member` carries `auth_user_id` + `email` + `slack_user_id`. To bridge GitHub too,
a github identity emitter must write `github_user_id`/`github_login` onto `$member`
(a follow-on, parallel to the existing Google emitter; `identity/auth-hook.ts:19`
registers only Google today). With that, `$member` is the single hub and both the
slack and github persons collapse onto it. Benefits: ACL read gate / `resolveMembers`,
and read-time recall collapse (`entity-link.ts:57-71`) + per-entity metrics.

**Bridge 2 — third-party human (never signed in).** With #2 + #3 the two entities
share an `email` identity but do NOT auto-merge (Finding B). The benefit materializes
only after #5's merge job. Be explicit in any roadmap: #2+#3 alone do not deliver
Bridge 2.

## #5 — Reconciliation / merge job (mandatory for Bridge 2)
New `identity/reconcile.ts` `reconcileCrossSourceIdentities(orgId)`:
1. Candidate pairs: `entity_identities` grouped by `(org, namespace='email', identifier)`
   with entities of different source signatures (one `github_user_id`, another
   `slack_user_id`), `deleted_at IS NULL`.
2. G3 gate: accept only if the email is owned by exactly one entity on each side,
   passes G1 at merge time (defends against pre-G1 poisoned rows), and (via G2)
   the github email came from a verified commit.
3. Merge transactionally + idempotently: pick a survivor (prefer `$member`, else the
   older person), repoint `entity_identities`, `events.entity_ids`,
   `metadata.aliases`, ACL membership rows; soft-delete the loser. Reuse an existing
   `mergeEntities`/dedup primitive if one exists.
4. Log every merge with the deciding identifier; emit a collision record when the
   gate refuses (manual review).

**Provenance for G3:** prefer to only ever *write* email identities that passed G2
(verified) — then presence in `entity_identities` implies verified and the gate
reduces to "singly-owned + non-excluded" (no schema change). Run once per org after
#2/#3 data exists, then periodically (or on ACL-graph rebuild / identity ingest).

## Tests (red→green)
- **A. GitHub↔Slack collapse via merge** — seed a verified github commit event
  (email) → person with `{github_*, email}`; seed a slack member (email) → a SECOND
  person (assert they do NOT auto-merge); run #5 → one entity with `{github_*,
  slack_user_id, email}`. Negative: `actions@github.com`/noreply → no email identity
  written (G1/G2), no merge.
- **B. Sign-in member → slack_user_id + ACL collapse** — unit: `persistLoginSlackIdentity`
  writes `(slack_user_id, 'T1:U1')` with source `auth:signup`; idempotent; missing
  team → no write. Integration: provision `$member`, write its `slack_user_id`, run
  `buildSlackChannelGraph` → member resolves to `$member`, not a new person.
- **C. Guardrail units** — `normalizeEmail` rejects noreply/`*[bot]@*`/`actions@github.com`,
  accepts real; unverified commit → no email identity, verified → present.
- **D. Merge-gate** — multiply-claimed email → refused + collision logged;
  singly-owned → merged.

## Rollout / phasing (value/risk order)
1. **#1** — ship first; self-contained, immediate ACL benefit, low risk; lazy backfill.
2. **#3 G1+G2** — before any email write; cheap; must precede email data.
3. **#3 github email identity (write only)** — behind G1+G2; not yet acted on.
4. **#2 slack email** — requires re-consent; long pole; org opt-in + privacy.
5. **#5 merge job** — confidence-gated, off by default; enable per-org once data
   exists and G3 verified. This is what delivers Bridge 2.

## Risks (ranked)
1. **(Critical) #3 over-merge** — self-attested emails. G1 + G2 + G3. Residual:
   commit-under-colleague's-email — never auto-merge on a single unverified signal.
2. **(High) Finding A mismatch** — bare `sub` silently fails to bridge. Mandatory
   `normalizeSlackUserId(teamId, sub)` + "no team → no write" + test B.
3. **(High) Merge-job corruption** — transactional, idempotent, reuse a merge primitive.
4. **(Medium) Privacy** — `users:read.email` PII; org opt-in + bot exclusion + docs.
5. **(Medium) Re-consent gap** — #2 activates on reinstall; degrade gracefully.
6. **(Low) Rate limits** — `users.info` Tier-4; cache + throttle.

## Files to touch
`auth/subject-identities.ts` (#1 `persistLoginSlackIdentity`); `auth/index.tsx`
(wire hooks, capture `accountId`); `identity/auth-hook.ts` (export
`resolveTenantMember`); `github.ts` (#3 email identity `:266-272` + G2 verified-only
`:1119-1129`); `connector-sdk/src/identity-normalize.ts` (#3 G1 exclusion);
`authz/slack-channel-graph.ts` + `sources.ts` (#2 email on members); new
`identity/reconcile.ts` (#5).
