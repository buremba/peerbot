# Authorization / ACL — finalized architecture

**Status: FINALIZED (decisions locked via interview; pi-reviewed — 7 correctness
fixes folded in: two-sided `user ∩ agent` gate, explicit `deny_read`, ACL-expr →
effective principals, freshness-inside-gate, team-scoped Slack ids, fail-closed
derived provenance, stale prototype removed).** Supersedes the draft
`authz-identity-foundation-plan.md`: keeps its IF-1..IF-5 identity spine, re-anchors
everything on the existing entity graph (`entities`/`entity_relationships`/
`entity_identities`, the #1494 pattern), and adds the gate. **No new principal
tables; no rollout scaffolding.**

## 0. The requirement
A requester — human or an agent acting for them — must never see
connection-sourced data beyond their access in the source system, while we cache
everything centrally and do zero per-query federation across (tens of) tools.
Honest bound: "never" holds up to **ACL freshness** (see §5).

## 1. Locked decisions
1. **Store: PG-native, reuse the entity graph.** Memberships = `entity_relationships`;
   ACLs = compiled flat principal sets; one SQL gate. No external ReBAC engine
   (fights "Postgres is the only external"). No new principal/edge/identity tables.
2. **Revocation: bounded per-source SLA + fail-closed on stale.** Per-source
   `freshness_state`; deny when freshness is unknown/stale. Customer wording:
   "reflected within connector-specific freshness guarantees," not literal "never."
3. **Agent access = agent ∩ user.** An agent acting for a user sees ≤ that user.
   Autonomous/headless agents get NO ambient org memory. The SAME gate covers
   agent tool-calls + RAG, not just UI search.
4. **Unsupported-ACL connector ⇒ fail closed (owner-only).** A connector's
   restricted data is searchable per-user only after its ACL compiler is tested.
5. **Cross-provider identity link: verified-email both sides + no primary-id
   conflict.** Conflict (two members, same verified email) → approval, never
   silent merge. Name / unverified-email never link.
6. **Derived artifacts inherit ACLs: visible iff the viewer can see ALL sources.**
   Provenance-tracked; no cross-ACL blending.
7. **Rollout = the permanent model, not a flag.** The gate is always on; a
   connector flips owner-only → enforced via its `aclSupport`/`freshness_state`
   (data, not scaffolding); the "what did the gate decide" visibility is the
   permanent audit log you need anyway; per-connector ACL test suites catch
   compiler bugs pre-ship. **No shadow-mode tech debt.**
8. **First vertical: Slack, end-to-end.**

Adopted without a separate question (veto-able): **DI-1** promote verified login
facts → `entity_identities` claims (O(1) webhook resolution); **`$member` and the
connector-ingested `person` collapse to one entity** via those claims; ACL edges
use a **`can_read`** relationship type (max reuse of `entity_relationships`).

## 2. Identity (the foundation — IF-1..IF-4, re-anchored)
- **Resolver:** `resolveRequesterToMember(org, {authUserId | provider+id | email})`
  → `$member` entity. Extends the existing private `resolveTenantMember`
  (`identity/auth-hook.ts`) which already resolves `auth_user_id` →
  `entities('$member')` via `entity_identities`.
- **Thread into the gate:** set `AuthzScope.principal = $member entity id`
  (replacing the raw user-id placeholder in `authz/scope.ts`), fail-safe to user
  id when unresolved (then fail-closed once Slack ACLs enforce).
- **Promote claims (DI-1):** at login, write the provider's verified identity
  (`slack_user_id` `T..:U..`, `github_user_id`/`github_login`, google sub, okta
  sub) as an `entity_identities` claim tied to the `$member`, with an **assurance**
  marker; mirror `identity/connectors/google.ts`. Backfill from `identity_fact`
  events.
- **Linking:** auto-link two providers only on verified-email match both sides +
  no primary-id conflict; conflict → durable approval plane (reuse manage_agents/
  watcher field-ownership gate). Per-org `$member`.

## 3. The graph (reuse, zero new tables)
- **Principals = `entities`** (person/`$member`, company=workspace, group=channel/
  usergroup). **All Slack identifiers are team-scoped** (`T…:U…` users, `T…:C…`
  channels, usergroups likewise; Slack Connect / external users carry their own
  team prefix) so `entity_identities` uniqueness never collapses principals or
  resources across workspaces.
- **Memberships = `entity_relationships` `member_of`** (the #1494 machinery;
  `ensureMemberOfType` + idempotent live-triple unique index).
- **ACL = `entity_relationships` edges with explicit effect: `can_read` (allow)
  and `deny_read` (deny)** — deny-wins needs a place to read denies from. `resource
  → audience` principal. Private channel → `can_read` its member-group; public →
  `can_read` the workspace company.
- Boolean ACL **expressions** (Jira `browse AND issue-security`) compile to
  **effective-read principals** (a synthetic intersection principal or a concrete
  member set) — **NEVER** naive `can_read` edges to both groups (that is OR → a
  leak). "Flat principal sets" are safe only because they are *effective-read*
  principals. If a source can't compile to effective principals safely, it's
  `aclSupport: none` ⇒ owner-only (decision 4). Slack needs no expressions
  (membership is already effective).

## 4. The gate (one SQL function, used everywhere) — two-sided, fail-closed
A row is visible iff **ALL** hold (in one SQL function — no caller conventions):
1. **User side:** some `can_read` principal ∈ the viewer `$member` closure AND no
   `deny_read` principal ∈ it (deny wins).
2. **Agent side:** it is within the run's agent/channel scope. The effective
   access is **`user ∩ agent`** — an agent NEVER widens beyond both its own scope
   and the user's. Headless/autonomous agent → empty set.
3. **Freshness:** the source's `freshness_state = fresh` — checked **inside the
   gate SQL**, so missing/unknown/stale ACL state DENIES in the same query.

Viewer closure = `$member` + trusted source identities + transitive `member_of`
(recursive CTE; materialized closure later) + org/public audiences. Returns
visible resource ids → filters `channel_messages` / `events`. Applied uniformly:
`search.ts` recall, RAG, agent tool-calls, feeds route, exports — no bypass.
**Do NOT simply replace the agent-bound-channel fence with the user gate** — that
widens access from "agent's channels" to "all the user's channels"; intersect them.

## 5. Freshness / revocation
Per-source `freshness_state` (fresh|stale|unknown|failed) + `aclSupport`
(full|partial|none) + `strict_mode`. Membership removals are high-priority
invalidation (Slack `member_left_channel`, already-subscribed events + reconcile
job). Bounded SLA (Slack private <30s target; others <1-5min); fail closed when
stale/unknown. Storage: a small `authz_source_acl_state` (org, connection) — the
ONE genuinely-new small table besides provenance.

## 6. Derived-artifact ACLs (AI oversharing)
`derived_artifact_sources(artifact_event_id, source_event_id)` provenance; an
artifact (summary/embedding/memory/cached answer) is visible iff the viewer can
see ALL its sources. Provenance must be **complete + transitive**; **missing,
deleted, stale, or unknown-ACL source → DENY the artifact** (fail closed — partial
provenance is not visibility). RAG: filter candidates → build prompt → revalidate
citations.

## 7. Database changes (minimal — this is the consolidation payoff)
- `entity_identities`: add `assurance` (+ `verified_at`), two-phase (squawk gate).
  [extends existing table]
- `authz_source_acl_state`: small per-(org,connection) freshness/strict-mode row. [new, small]
- `derived_artifact_sources`: provenance for derived artifacts. [new, small]
- `can_read` + `deny_read` relationship types: **data, no migration** (runtime `ensure*Type`).
- Channels/workspaces as entities, memberships, ACL edges: **no migration** (reuse).

Net: **1 column add + 2 small tables** — vs. the 5 new tables the from-scratch
approach implied.

## 8. SDK shape (extends ConnectorRuntime; Okta = a connector, no IdP subsystem)
Connectors emit a typed record union during sync: `event` (today) + `acl`
(per-item, boolean expr) + `principal` + `membership` + `identity`; declare
`provides[]` + `aclSupport`. **Okta** = `provides:['principals','groups','identity']`,
no feeds. **Slack** = event + acl(membership) + principals/groups + identity.
Per-connector ACL compiler = the trusted security boundary (test suites + golden
fixtures + "unsupported feature ⇒ fail closed").

## 9. Per-connector reliability (the named targets)
| connector | emits | hard part |
|---|---|---|
| **Slack** (first) | content + acl(membership) + identity(slack_user_id) + groups(usergroups) | private removal = high-pri invalidation; Connect external users explicit |
| **Okta** | principals + groups + membership + identity (SCIM/OIDC) | canonical person/group layer; not source-native ACLs |
| **GSuite** | content + acl + identity(google) | link-sharing variants (distinct principals, configurable), domain/inherited |
| **Jira** | content + acl(**expr**: browse AND issue-security) | intersectional → needs AclExpr; dynamic principals; fail closed if uncompilable |
| **Linear** | content + acl(team membership) | private teams; identity → person |

## 10. The Slack e2e vertical (first proof, one PR)
Spine, each step testable, ending in the e2e:
1. **IF-1** — `resolveRequesterToMember` + thread `$member` into `AuthzScope.principal`.
2. **Slack identity claim** — promote verified `slack_user_id` claim (subset of IF-2).
3. **`buildSlackChannelGraph`** — mirror `buildGithubTeamGraph`: `$member member_of #channel`, `can_read` edges, channel/workspace entities; seed via conversations.members, fresh via member_joined/left.
4. **Gate** — `getVisibleChannelIds($member)` over `entity_relationships`; fail-closed on stale.
5. **Wire** — replace the agent-bound-channel fence in `search.ts` recall with the `$member` gate.
6. **E2E (red→green):** a `$member` of `#eng` (not `#secret`) calls `search_memory` → gets `#eng`, not `#secret`; unresolved identity → fail closed.

## 11. Phasing + size
- **P-Slack** (this vertical, ~3-4 PRs): IF-1 + claim + graph + gate + recall wiring + e2e.
- **P-Identity breadth** (IF-3 assurance/dedup, IF-4 Okta, IF-5 docs).
- **P-Sources** (per connector: GSuite → Jira → Linear; each = a tested ACL compiler).
- **P-Freshness** (reconcile, revocation priority, strict mode).
- **P-Derived** (provenance + summary/embedding gating).
Rough: ~10-14 PRs total; the per-connector ACL compilers are the long tail. The
Slack vertical proves the whole chain first.

## 12. Files (Slack vertical)
- `identity/auth-hook.ts` (export/generalize resolver), `authz/scope.ts` (thread `$member`).
- `identity/connectors/slack.ts` (verified-claim emitter, mirror google.ts).
- new `gateway/.../slack-channel-graph.ts` (mirror `github-team-graph.ts`).
- new `authz/principal-graph.ts` (the gate over `entity_relationships`).
- `tools/search.ts` (recall wiring) + the new small migration (assurance col / freshness table).
