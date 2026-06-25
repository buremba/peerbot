# Slack agent onboarding — "set up an agent for your DM/channel"

Status: PLAN (not started). Goal: let both technical and non-technical Slack
users connect an agent to their DM/channel properly, beyond the CLI-only
`/lobu link <code>` path. Inspired by Anthropic's "Claude Tag" model.

## Background facts (verified this session)

- **The link code already works in any workspace the bot is in (hosted OR
  OAuth-installed).** `consumePreviewClaim` (`packages/server/src/preview/slack.ts:263`)
  binds whatever `team`/`channel` the `/lobu link` ran in; the claim payload
  (`ClaimPayload`, slack.ts:54) encodes only `{organizationId, agentId,
  allowedSurfaces, createdBy}` — **no workspace restriction**. The "Join the
  hosted Lobu slack workspace" copy is misleading default text → fix it.
- **`app_home_opened` carries no `team_id`** (the adapter event is
  `{adapter, channelId, userId}`), and the Slack adapter exposes no team getter.
  BUT **interactive action payloads DO include `team.id` + `user.id`**. → Any
  flow that needs the workspace id must hang off a *button click*, not passive
  render.
- **Don't mint tokens at render.** Slack caches the published App Home view, so a
  single-use token baked into a button URL goes stale (expired/used by click
  time) and write-amplifies (a DB row per passive open). → Mint **on-demand** in
  the action handler.
- Bind primitive: `upsertBinding(tx, platform, channelId, teamId, agentId,
  organizationId)` (slack.ts:222). Identity: `chat_user_identities`
  (`resolveChatUserIdentity` slack.ts:503). Claims live in `oauth_states`
  (scope `slack-preview-claim`, one-time DELETE-on-consume, TTL). Web mint
  endpoint exists: `POST /api/:orgSlug/preview/claims` → `createPreviewClaim`.
- OAuth install primitive shipped: `slack_installations` / `app_installations`
  (one-click "Add to Slack", org+team keyed) — see memory
  `project_slack_oauth_installs_shipped`. Currently **0 installs** in prod.

## Inspiration: how Anthropic does it ("Claude Tag", shipped 2026-06-23)

Claude Tag *replaced* per-user Claude-in-Slack because per-user OAuth caused
1-hour tokens w/ no refresh, refresh-race invalidation, multi-replica stale
caches, and hard 401s — **the same failure modes Lobu has hit**. New model:

1. **Install + admin-provision = auth.** Org admin provisions a service account
   once, designates channels; users just `@mention` — no per-user OAuth.
2. **App Home = setup + status hub** (unlinked → "connect" CTA; linked → agent
   name + health + reconnect).
3. **Graceful expiry**: proactive refresh + a "reconnect" affordance, never a
   silent 401.
4. **Two tiers**: org/service-account agents (instant, org-billed) + optional
   personal agents (one connect, user-scoped).

Sources: support.claude.com "Claude Tag", "Claude in Slack", "Connectors";
code.claude.com/docs/en/slack.

## Design — two onboarding tiers

### Tier 1 — Org / installed workspace (Claude-Tag-style, lowest friction)

For workspaces that install Lobu (OAuth → `slack_installations`):
- Admin provisions/links an org agent + designates channels (web dashboard).
- Users `@mention` / DM → works. The **install is the auth**; no per-user code.
- App Home shows: connected org + agent + health; admin-only reconfigure.
- This is the strategic direction. Most of the primitive exists
  (`slack_installations`); the gap is the admin "provision + designate channels"
  UX and routing default-binding.

### Tier 2 — Personal / per-DM bind (the "Set up your agent" button)

For individuals (hosted preview, or personal use in an installed workspace).
Replaces the misleading root link. **On-demand, signed-context, web-confirmed.**

Flow:
1. App Home shows an interactive button **"Set up your agent"** (`action_id`,
   NOT a pre-baked URL).
2. Click → our `onAction` handler fires. Payload gives `team.id`, `user.id`;
   channel is the user's DM. Handler **mints a fresh context claim** in
   `oauth_states` (new scope `slack-connect-context`, payload
   `{platform, teamId, channelId, slackUserId}`, ~15 min TTL, one-time) and a
   short human code (paste fallback). Delivers BOTH via an ephemeral message /
   DM: a clickable link `…/slack/connect?t=<token>` + "or paste `K7QF-93` at
   app.lobu.ai/connect".
3. User opens link → **web login** (existing auth) → `/slack/connect` page:
   "Connect *your DM in <workspace>* to:" + agent picker + "Create an agent
   (Builder)".
4. Confirm → `POST /api/.../slack/connect`: verify+consume claim (one-time) →
   `upsertBinding(platform, channelId, teamId, agentId, org)` → record
   `chat_user_identities(slackUserId → lobuUserId)` → respond.
5. Bot DMs the channel: "Linked. I'll reply here now."

Paste fallback: `/connect` page accepts the human code → same claim lookup.

### Security model (why this is safe)

- team/channel are **not secrets** → fine in a URL.
- The real risk is an **unauthenticated bind** (stranger pointing someone's DM at
  their agent). Gated by: (a) the claim is a **context-authentication** token
  (signed/stored, one-time, short TTL) that proves the team/channel/slackUser
  came from a real Slack action — NOT a capability token that auto-binds; (b) the
  bind requires **web login**; (c) the user explicitly picks the agent and
  confirms. Visiting the URL does nothing by itself.
- Bind authorization: the claim binds `claim.slackUserId`'s DM only; for channel
  binds, require the web user to be a workspace member / channel-authorized
  (reuse `bindChatToAgentForOwner` org-membership checks).

## Secondary fixes (bundled or fast-follow)

- **Copy**: update the `/lobu link` mint message (CLI + web) — it works in
  installed workspaces too, not just hosted. (slack.ts link-help strings.)
- **App Home states** (Claude-Tag idea): unlinked → setup button; linked → "Connected to <agent>" + health + reconnect. Needs per-user linked-status (we
  already resolve `chat_user_identities`).
- **Notifications team-scoping (pi blocker on PR #1546)**: passive home-open lacks
  `team_id`, so per-user notifications can't be safely team-scoped on render.
  Options: (a) drop notifications from passive home; surface them only after a
  button-click flow that yields team; (b) lean on Tier-1 install identity. Decide
  alongside this work — do NOT ship the unscoped lookup.
- **Graceful expiry**: on credential expiry, DM a "reconnect" button instead of
  silent failure (mirrors Claude Tag; we've hit the 2h WORKER_TOKEN issue).

## Testing in Slack sandbox workspaces

1. Create a free Slack **dev/sandbox workspace** (or two, to test cross-workspace
   isolation + the notifications team-scoping concern).
2. Install the Lobu app there via "Add to Slack" (exercises `slack_installations`,
   currently 0 in prod — validates the install path end to end).
3. Tier 2: open App Home → click "Set up your agent" → verify fresh link+code,
   web login, pick/create agent, confirm, bot DM confirmation. Re-click → fresh
   token (no stale reuse). Test paste-code fallback.
4. Verify `/lobu link <code>` works in the **installed** sandbox (confirms the
   "works in installed workspaces" claim live).
5. Two-workspace test: same Slack user-id space can't cross-read notifications
   (validates team-scoping decision).
6. Tier 1: provision an org agent + designate a channel; `@mention` → works with
   no per-user step.

## Phased implementation (suggested PRs)

1. **P1 — copy + App Home states**: fix the hosted-only link text; App Home
   unlinked/linked states; replace the root setup button with the on-demand
   action button (mint fresh claim on click, deliver link+code). Resolve the
   notifications team-scoping (gate or drop on passive render).
2. **P2 — web connect flow**: `/slack/connect` owletto page + `POST
   /api/.../slack/connect` consume endpoint (verify claim, bind, record identity,
   bot DM confirm) + the `/connect` paste page. Reuse `upsertBinding` +
   `oauth_states`.
3. **P3 — Tier 1 org provisioning**: admin "provision + designate channels" UX on
   installs; default channel→agent routing; App Home admin view.
4. **P4 — graceful expiry / reconnect** DMs.

## Open decisions

- Tier-1 vs Tier-2 priority: which audience first? (Org installs = strategic, but
  0 installs today; personal DM = the immediate ask.)
- Notifications on the App Home: keep (needs team via button-flow) or drop until
  Tier-1 install identity makes it clean?
- Whether the on-demand button delivers the link via ephemeral message, DM, or a
  Slack modal (modal is cleanest but more Block Kit surface).
