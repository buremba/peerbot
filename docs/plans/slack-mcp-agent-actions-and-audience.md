# Agent actions via platform MCP + per-agent capability scope + audience/recall UI

Status: DESIGN. Verified against code on branch `feat/authz-audience-ui` (base `0c4cec56c`) and against live Slack docs/endpoints, 2026-06-28.

This doc replaces the original "build an Audience UI on the Channels/Reach tab" framing with the
broader model it kept collapsing into. The audience UI is one slice (the governance surface); the
substrate is "agents act on connected platforms through the platform's own MCP, as the signed-in
user, bounded by a per-agent capability scope."

## The model

A connected platform resource (Slack channel, GitHub repo) is a **Source** with three facets that
all hang off one physical fact — the bot/app is a member of it:

- **Reach** — who/what can talk *to* the agent (`agent_channel_bindings`, MCP clients, webhooks).
- **Capture** — what conversation data is collected (`channel_messages`, webhook-only, the
  `recordChannelMessages` whole-channel toggle).
- **Audience** — who may *recall that data back* through the agent (the `member_of` graph +
  `authz_source_acl_state` gate, shipped in #1586/#1590).

The agent is the actor: **Agent = identity + reach + capability scope + approval policy.** The
builder agent (`lobu-builder`, `organization.system_agent_id`) has a broad scope and drives setup
conversationally; purpose agents (e.g. a food-delivery agent) get a narrow scope. The UI's role
shrinks to **audit / manage / govern** — the audience/recall surface is the first instance of that.

## How agents act on platforms: use the platform's official MCP, as the user

Decided after ruling out alternatives:

- **NOT** bespoke per-action gateway endpoints (doesn't generalize).
- **NOT** generalizing `slack-web.ts` into first-party connector actions (would make Slack a
  runtime connector, hits the `app_installations` ↔ `connections` credential seam, and is redundant
  once the platform ships an MCP).
- **NOT** the sync-connector `ActionDefinition`/`execute()` path (credentials resolve from the
  `connections`/`auth_profile` world; Slack lives in `agent_connections`/`app_installations`).

Instead: **consume the platform's official MCP server with per-user OAuth.** Verified live:

### Slack MCP (verified)

- Endpoint: `https://mcp.slack.com/mcp` (JSON-RPC 2.0 over Streamable HTTP).
- Per-user OAuth user tokens. `.well-known/oauth-protected-resource` →
  `authorization_servers`, `bearer_methods_supported: [header, form]`, full `scopes_supported`.
- `.well-known/oauth-authorization-server`: `authorization_endpoint =
  https://slack.com/oauth/v2_user/authorize`, `token_endpoint =
  https://slack.com/api/oauth.v2.user.access`, `grant_types = [authorization_code, refresh_token]`,
  `token_endpoint_auth_methods = [client_secret_post]`, `code_challenge_methods = [S256]`.
- **No DCR** (no `registration_endpoint`) → must use a **static client** (our app's
  `client_id`/`client_secret`).
- Read + write tools: search (messages/files/users/channels/emoji), history, `chat:write`,
  draft, create channel, reactions, canvas read/write, list channel members, user info.
- Constraint: **"only directory-published or internal apps may use MCP; unlisted apps are
  prohibited."** This is the one hard external dependency (see Risks).

### Why this is mostly already built

`packages/server/src/gateway/auth/mcp/` already implements a conformant per-user MCP OAuth client
that matches Slack's advertised flow 1:1:

- `oauth-flow.ts` — authorization-code + PKCE (S256), static `client_id`/`client_secret` path.
- `oauth-discovery.ts` — `WWW-Authenticate` → protected-resource-metadata → auth-server-metadata.
- `proxy-upstream.ts` (`resolveCredentialToken`) + `device-auth.ts` — credentials stored
  per-`(agentId, userId, mcpId)`, 5-min refresh buffer, auto-refresh via `refresh_token`.
- `proxy-shared.ts` (`computeScopeKey`, `buildUpstreamHeaders`) — `authScope: "user"` keys
  credentials per acting user; Bearer attached per upstream call.
- A tool call that 401s triggers the OAuth flow automatically (`proxy-rest-routes.ts`).

So the agent acts as **whichever signed-in user is driving the run** — by construction, bounded by
that user's real Slack permissions ("if the user has access, it shows"). Headless/shared runs have
no user token → the interactive 401→OAuth flow can't complete → those Slack-MCP tools surface
"auth needed / unavailable" rather than falling back to a shared token. That is the acting-user
boundary; no new model required.

## Credential reality (corrected)

`resolveExecutionAuth` (sync-connector path) resolves by `connectionId`, not acting user:
`oauth_account` connections run on the **connecting user's** grant (real user auth, fixed at
connect time); `app_installation` connections (Slack bot, GitHub App) run on the **org/app** token.
The Slack bot token stays for events/capture. Agent *actions* go through the **MCP** path above,
which is genuinely per-acting-user.

## Per-agent capability scope (the net-new spine)

Today operations are **org-wide and ungated**: `listOperations` / `manage_operations` take
`organizationId` but never `agentId`, and `connections.agent_id` exists but is unused in the
operations path. Any agent can discover and `execute` any org connection's tools. For
app/MCP-token actions there is **no user-permission fence underneath**, so the per-agent scope is
the load-bearing boundary.

Net-new:

- A per-agent capability-scope store: agent → allowed connectors/connections (+ optionally
  per-tool allow). Candidate: reuse/extend `connections.agent_id` + an `agent_connector_grants`
  shape, surfaced in `AgentSettings`.
- Enforce in `manage_operations` discovery (`list_available` passes `ctx.agentId` → `listOperations`
  filters) **and** execute (validate `ctx.agentId` may use the requested `connection_id`).
- Approval: existing `requires_approval` + held-run `BuilderApprovalCard`; default write tools
  (`chat:write`, `channels:write`) to approval-required.

## Audience / recall UI (slice 1, unblocked)

Read-only projection of the `member_of` graph — the inverse of the recall gate. The gate does
`requester → visible resources`; the audience reads `resource entity → members` (same `member_of`
+ `entity_identities` joins, flipped: join identities on `from_entity_id`, filter on
`to_entity_id`). Write it resource-generic (keyed on resource entity type) so `repo` slots in later.
Enforcement status per connection from `authz_source_acl_state` (enforced = full+fresh+<60min /
onboarded-but-stale / not-graphed = legacy). Surface on the Agent → Channels/Reach tab: card
audience row (avatar stack + "N can recall" + gated/agent-only/not-synced chip) + detail panel
(Enforcement segment + "Who can recall" list with you / linked-Slack / Slack-member pills + DM
deep links). Slack is the source of truth; READ-ONLY. No MCP/publishing dependency.

## Risks / dependencies

- **Directory-publishing the Lobu Slack app** — hard gate for any live MCP use. Repo ships only a
  `self-install` template manifest; publishing status is a Slack-console property to confirm/achieve
  (review process). Blocks slice 3 only.
- **Token-response shape from `oauth.v2.user.access`** — verify Lobu's token parser accepts it on
  the first real grant (low risk given conformant AS metadata; gated on publishing).
- **Capability-scope correctness is security-critical** for app/MCP-token actions (no second fence).

## Sequencing (one branch = one concern)

1. Audience/recall UI — unblocked; original branch `feat/authz-audience-ui`.
2. Per-agent capability scope — unblocked; separate branch.
3. Slack MCP wiring (static client config + register `mcp.slack.com/mcp`, full-builder scopes,
   `authScope:"user"`) — config-level; live-testable only once the app is directory-published.

Multi-replica: every piece is a Postgres-mediated read/write; no in-memory cross-pod state.
