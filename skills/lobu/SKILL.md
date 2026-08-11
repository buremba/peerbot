---
name: lobu
description: "Set up new Lobu agents end to end and operate existing Lobu projects and memory: interview, scaffold, validate, authenticate, connect feeds, execute operations, and test Behaviors."
---

# Lobu

Use this skill when setting up a brand-new Lobu agent from scratch (follow "Onboarding a New Project" below) or when running, validating, evaluating, or connecting an existing Lobu project, or operating Lobu memory from a coding agent.

The `AGENTS.md` generated into a new project is the source of truth for the config API (the `define*` helpers, connectors, auth, Behaviors, memory) — this skill does not duplicate it. For an existing project, jump to "Core Model" + the relevant reference section below.

## Onboarding a New Project

Use this playbook when a new user asks you to build them a Lobu agent from scratch. Set it up end to end: ground yourself in what the user already has, interview, discover, scaffold, prove the complete local path, then offer the deployment choice. Do not call the setup complete until every path the user selected has actually passed end to end. If an external provider, authorization, deployment, or rate limit blocks the proof, name the exact blocker and leave the setup as blocked rather than claiming success.

### 1. Ground yourself in what the user already has

Before interviewing, look at what already exists so your questions and suggestions are personal rather than a blank slate. This is discovery, not a design decision — do not let it skip the interview.

- Local: run `lobu context list` to see existing contexts; check the current directory and home for existing Lobu projects (`lobu.config.ts`), configured MCP servers, and CLI auth state. Note what the user already set up.
- Cloud: if the user has an active session (do not create one just to look), call `client.organizations.list()`, `client.agents.list()` for each org, `client.catalog.listInstalled({ kinds: ["connectors"] })`, and `search_memory` for prior knowledge. This reveals existing agents, connectors, and memory you can build on.
- Tell the user what you are looking at so they can correct you, and let what you find shape the options you offer. Never treat this discovery as an identity signal: orgs, emails, or domains never prove a company or product, and never mention a competitor or third party unless it actually appears in what you found.

Do NOT ask for a login email during the interview. Email is only needed when a managed connector actually requires a session (step 3) or when the user chooses cloud deployment (step 6); ask for it at that point. Treat identity only as identity; never infer a company from an email address or domain.

### 2. Interview with concrete, personalized options

Interview the user one question at a time; wait for each answer, do not guess, and do not batch the questions. Anchor each question in what you found in step 1. Instead of asking "what agent do you want?" as a blank slate, summarize what you see and offer two or three concrete alternatives to choose from:

- "You already have org X with connectors A and B installed and N existing agents. Do you want to (a) add a new agent on top of those, (b) extend one of the existing agents, or (c) start something standalone?"
- "For what it should do, the common shapes are (a) a triage agent that reads incoming chat and files a ticket, (b) a scheduled report that summarizes new activity each morning, (c) a research agent that answers questions from your connected tools. Which fits, or what would you change?"

Offer a default so the user can answer "the first one" — decisive users and undecided users both move faster with a concrete menu.

- What company or product is this for?
- What does it do, and who does it serve?
- What is its public domain? (optional for a personal project)
- Do I have permission to research the public website and other public sources?
- What is the agent for?
- What should we call it?
- Who uses it: just me, my team, or each of my customers?
- How should it behave, and what may it do unattended versus only with approval?
- What should it remember? Model this as one to three entity types.
- Where does its data come from? Pick one connector or custom source to start.
- Where should people talk to it? Offer Web UI, API or SDK, MCP, Slack, Teams, WhatsApp, Discord, Google Chat, and Telegram without forcing a chat platform. If Slack is chosen, ask whether to join Lobu's hosted workspace for a quick start, install Lobu into an existing workspace, or use a custom Slack app; then ask whether to test the DM with Lobu, a named channel, or both, and whether people knowledge means conversation participants, bound-channel members, or the full workspace directory.
- Should anything run on a schedule?
- Which supported LLM provider credential does the user have?

If the user gave permission to research and has a public domain, research the company before proposing the design. Summarize its product, customers, workflows, and useful signals, and cite the public sources you used. Then propose one to three entity types, their relationships, the first data source, one or two useful Behaviors, and suitable interaction channels. Play back a short numbered plan and wait for confirmation before scaffolding anything.

### 3. Discover the surface before choosing how to scaffold

Check Node is 22-24 or 26+ (only Node 25 is unsupported), then run `lobu context list` and identify the named Lobu Cloud context; do not assume the active context still points to cloud after a local run. If a managed or cloud connector was chosen and there is no session, ask for the login email at that point, explain that Lobu will email an approval link, and run `lobu login --email <confirmed-address> --context <cloud-name>`. The person approving must sign in with that same email; knowing an address never grants access. After a successful login, an empty organization membership list is a tenancy/discovery result, not an authentication failure: call `client.organizations.list()` and explain the result. Never revoke or repeat login with `--force` unless the user separately approves that re-authentication.

Use ClientSDK through Lobu MCP or `lobu memory exec` with the explicit cloud context. Call `client.organizations.list()` to find public organizations offering managed connections. Call `client.catalog.listInstalled({ kinds: ["connectors"] })`; if the connector is not installed, call `client.catalog.listCatalog({ kinds: ["connectors"] })`. Inspect the selected entry's `detail.auth_schema`, `detail.options_schema`, `detail.feeds_schema`, and `detail.behavior_events` instead of guessing field names. If a matching live managed offer exists, explain it and call `client.connections.connectManaged` only after consent. Complete the returned user authorization, then run `lobu context use <cloud-name>` immediately before executing its `local_bootstrap_command` from the parent directory where the new project should be created; use `--here` only after entering an empty directory, and do not create a blank Lobu scaffold first. Ask for bring-your-own OAuth credentials only if no managed offer exists or the user prefers their own app.

### 4. Scaffold and build from the confirmed plan

If managed auth supplied a `local_bootstrap_command`, use the project it generated. Otherwise run `npx @lobu/cli@latest init` with the confirmed name and provider. Postgres is built in, so `lobu run` starts an embedded database; ask for `DATABASE_URL` only if the user chooses external Postgres. Read the generated `AGENTS.md` completely before editing `lobu.config.ts`. Use the canonical reference at `https://github.com/lobu-ai/lobu/blob/main/examples/lobu-crm/lobu.config.ts` when needed; do not assume that example exists in the new project's filesystem. Briefly explain how the chosen feed may use checkpoints to collect incrementally, emits events, builds shared entity memory, and gives both chat and Behaviors the same governed context.

`feeds_schema.<feed>.eventKinds` are the default Behavior trigger catalog for feed connectors: every declared kind is a subscribable event type (`event_type` = the kind slug, created-on-insert), scoped to a specific feed via `match: { feed_key }`. `behavior_events` (now derived from eventKinds when a connector declares none) is the trigger picker's list. If no declared kind matches the use case, use a scheduled Behavior with a bounded named SQL source and read event text from `payload_text`. Validate the query against the running local schema before relying on it. If `feeds_schema` is empty, do not invent or trigger a feed; chat integrations such as Slack can deliver incoming messages directly. For Slack or Telegram, prefer `defineConnection` with `credentialMode: "hosted"` so no bot token is required; `lobu run` prints the exact hosted-workspace join URL, own-workspace install URL when available, and short-lived link command. Use those returned values instead of constructing URLs. A printed `/lobu link <code>` is one-time: redeem it in the first selected DM or channel. In an installed workspace whose installer is linked to Lobu, bind each additional surface with `/lobu link <agent-id>`; otherwise generate a fresh code for that surface. Mention Lobu in a channel test and verify the App Home separately. Lobu email login and Slack installation are separate: the email link authorizes Lobu CLI access, while an existing-workspace install requires the user or workspace admin to approve Slack's OAuth screen. Never describe Slack consent as an email approval. Use `credentialMode: "byo"` only if the user chooses their own app. Tell the user once which remaining secrets are required and add only `secret("ENV_NAME")` placeholders to config. Never open or request permission to read `.env`; inspect `.env.example` when present and declared secret placeholder names only. Never read, print, invent, or paste a real secret into source or chat.

If the user wants the agent to know people in Slack, ask whether that means conversation participants, members of bound channels, or the full workspace directory. Installing the app proves none of those by itself. Verify the selected scope by inspecting the people or member entities Lobu actually materialized and by asking the agent a roster question. If human-readable names or non-participants are unavailable, identify that exact product gap; never claim the complete workspace directory was synced.

### 5. Prove the complete local path

Change into the generated project directory and verify `pwd` contains the intended `lobu.config.ts`; never run project commands from its parent. Run `npx @lobu/cli@latest validate`, boot with `npx @lobu/cli@latest run`, and verify health and the local Web UI. With the embedded database default, `lobu run` creates and selects the local context and auto-applies the project; with an external `DATABASE_URL`, it does neither, so authenticate and apply to that runtime explicitly. Send a harmless direct chat message without tools.

Before consent to access provider data, inspect only catalog, connection, auth-profile, and feed metadata. For a `browser_session` profile only, `npx @lobu/cli@latest connector run <key> --auth-profile <browser-session-profile-slug> --check` resolves the device-bound path without execution. Never use `connector run` as a generic managed OAuth or env-profile check; those durable credentials stay at the gateway. Do not run a feed or connector dry-run before consent, because a dry-run may still read provider data. Ask explicitly before accessing real provider data. Only after approval, dry-run the connector or feed server-side and trigger the selected feed manually if that connector actually declares one. A feed dry-run records its run but persists no collected events, entities, attachments, checkpoint changes, or feed sync state. Run each Behavior once, poll `client.operations.getRun` with its returned `run_id`, and show each completed run plus any declared result event or entity. For a Canvas-only or reaction-only Behavior, do not invent a persisted output; use the Behavior `view_url` returned by Lobu. For Slack, treat DM, channel mention, App Home, and requested member discovery as four separate checks. Keep actions in approval mode unless the user explicitly approves execution. If any step fails, fix it and rerun that step; do not silently substitute a different path.

### 6. Offer the deployment choice

After the local proof, ask the user whether to keep running locally or deploy to Lobu Cloud. Explain that the embedded local runtime and Lobu Cloud are separate targets, and that keeping it local needs no further setup. Only if the user chooses cloud deployment, ask for the login email to identify the deployer, explain that Lobu will email an approval link, and run `lobu login --email <confirmed-address> --context <cloud-name>`; the person approving must sign in with that same email. Because `lobu apply` has no context flag, use `lobu context list` and then `lobu context use <cloud-name>` to select an explicit cloud context before deployment. Run `lobu apply --dry-run` first, show the target organization and exact plan, and wait for confirmation before applying. After apply, use only authoritative `view_url` values and link commands returned by Lobu; never construct URLs. Present the working access choices: Web UI, direct agent chat, API or SDK, MCP, and any channels the user selected.

## Core Model

- **Lobu** is the agent framework, runtime, deployment layer, and memory surface.
- Keep framework configuration in `lobu.config.ts` (TypeScript, `defineConfig` from `@lobu/cli/config`).
- Keep agent identity and behavior in `IDENTITY.md`, `SOUL.md`, and `USER.md`.
- Keep reusable capability bundles in `skills/<name>/SKILL.md` or `agents/<agent>/skills/<name>/SKILL.md`.
- Use `lobu login` for CLI authentication. Do not use a separate memory login command.
- Use `lobu memory ...` for memory operations, MCP client wiring, seeding, direct tool calls, and browser-auth capture.

## Project Checklist

1. Read `lobu.config.ts` first.
2. Read the active agent files under `agents/<id>/`.
3. Check local skills under `skills/` and `agents/<id>/skills/`.
4. Use `lobu validate` after config changes.
5. Discover the live SDK and connector surface with `search_sdk`; never guess a method, connector key, feed key, connection id, or operation key.
6. When prompt or Behavior changes, run evals via promptfoo (see `examples/personal-finance/evals/promptfooconfig.yaml`). The in-house `lobu eval` command has been removed.

## Common Commands

```bash
npx @lobu/cli@latest init my-agent
npx @lobu/cli@latest run
npx @lobu/cli@latest validate
npx @lobu/cli@latest login
```

## Authentication

- Interactive (human at a terminal): `lobu login` runs the device-code flow with a browser approval.
- CI / your own automation: `LOBU_API_TOKEN`, or `lobu login --token <pat>`.
- Local `lobu run`: the CLI mints credentials automatically over loopback — no prompt.
- Headless, on a *user's* behalf: `lobu login --email <address>`. The server emails the user a one-click approval link and the CLI polls until they approve, then stores the scoped credential — no TTY, no pre-minted token. This is the auth.md "user_claimed" flow.

An external agent not using this CLI can drive the same flow over HTTP: read `<origin>/auth.md` (linked from the `agent_auth` block in `<origin>/.well-known/oauth-authorization-server`) for the endpoints. Today only the email user_claimed flow exists (no zero-touch ID-JAG). Never fabricate a token.

## Organization Deletion

Treat organization deletion as permanent and restricted to organization owners. The supported path is the **Organization settings** page, opened from that workspace's settings button in the organization switcher. ClientSDK and Lobu CLI intentionally expose no organization-delete method. When asked to delete organizations, identify each exact target and its data impact read-only, surface one production organization at a time for explicit confirmation, then direct an owner to that page or use their logged-in browser only when explicitly authorized. Never invent a hosted URL, call the raw Better Auth route, bypass a failed authorization check, delete organization rows directly, or batch confirmations.

Cloud CLI OAuth/PAT credentials are not a Better Auth browser session. A `401` or `403` is a stop signal: report the authorization boundary and leave the organization intact.

<!-- lobu-memory-guidance:start -->
## Memory Defaults

Your long-term memory is powered by Lobu. Do NOT use local files (memory/, MEMORY.md) for memory.
- Lobu automatically recalls relevant memories when you receive a message.
- To save something, call save_memory with the content and an appropriate semantic_type.
- To search, call search_memory. Results include view_url links to the web interface.
- NEVER construct Lobu URLs yourself. When the user asks for a link, call search_memory to get the correct view_url.
- When the user says "remember this", save it to Lobu immediately.
- When a message changes a fact you already stored (an updated preference, status, count, location, or plan), first search_memory for the prior memory to get its id, then save_memory the new value with supersedes_event_id set to that id. This replaces the stale value so future recalls return the current one; the old value stays in history but is hidden from normal search.
<!-- lobu-memory-guidance:end -->

## Lobu Memory

Configure project-scoped memory in `lobu.config.ts` by setting the org on `defineConfig` and declaring the schema with the `define*` helpers:

```ts
import { defineConfig, defineEntityType } from "@lobu/cli/config";

const ticket = defineEntityType({
  key: "ticket",
  name: "Ticket",
  properties: {
    subject: {
      type: "string",
      "x-table-label": "Subject",
      "x-table-column": true,
    },
  },
});

export default defineConfig({
  org: "my-org",
  orgName: "My workspace",
  agents: [/* ... */],
  entities: [ticket],
});
```

Seed data records still live as YAML under `./data`. Then seed or operate the memory workspace with:

```bash
lobu login
lobu memory org set <org-slug>
lobu memory health --org <org-slug>
lobu memory seed --org <org-slug>
lobu memory run search_memory '{"query":"Acme"}' --org <org-slug>
```

Use `search_memory` first when the user asks about a specific entity or workspace memory. Use `save_memory` to persist durable memory. To update existing knowledge, search first, then save with `supersedes_event_id` so the old row is tombstoned rather than deleted.

## MCP Client Setup

Use the actual MCP URL for the user's runtime. Never hardcode a hosted URL unless the user explicitly asks for that instance.

Common setup commands:

```bash
# Claude Code
claude mcp add --transport http lobu <mcp-url>

# Codex
codex mcp add lobu --url <mcp-url>

# Gemini CLI
gemini mcp add --transport http lobu <mcp-url>

# Interactive client wiring wizard
lobu memory init --url <mcp-url>
```

For ChatGPT, Claude Desktop, Cursor, and other browser-managed clients, paste the MCP URL into the client's MCP/connector settings and complete OAuth in the browser.

## Browser-Authenticated Connectors

For connectors that need a real browser session, `browser-auth` launches a dedicated Chrome with remote debugging, stores its CDP endpoint on the auth profile, and the connector attaches over CDP at sync time (harvesting cookies live):

```bash
lobu memory browser-auth --connector <key> --auth-profile-slug <slug>
lobu memory browser-auth --connector <key> --auth-profile-slug <slug> --check
```

Use `--dedicated-profile` only when you want a non-default dedicated Chrome profile directory; use `--remote-debug-port` to customize the CDP port (default `9222`).

## Agent-Facing Tool Surface

The normal MCP surface is intentionally small. Flat administrative tools are not advertised to agents; compose through these tools instead:

- `search_memory` and `save_memory` for direct knowledge recall and persistence.
- `search_sdk` to discover current ClientSDK methods, signatures, connector feed keys, operations, access requirements, and examples. Pass `mode: "read"` when you only need methods safe for `query_sdk`.
- `query_sdk` for read-only TypeScript and `query_sql` for governed, paginated SQL reads.
- `run_sdk` for mutations and external operations. Use `lobu memory exec` from the CLI for the same ClientSDK scripting workflow.

Search before create to avoid duplicates. Prefer a read or dry run before mutations, never fabricate returned URLs or identifiers, and never delete from `events`; supersede or tombstone instead.

## Connectors, Feeds, and Operations

Connectors are the primary integration path for third-party services. Use this lifecycle:

1. Call `search_sdk` with the service name. It returns installed and installable connectors, declared feed keys, SDK methods, and readiness details.
2. Use `query_sdk` to inspect `client.catalog.listInstalled({ kinds: ["connectors"] })`, `client.catalog.listCatalog({ kinds: ["connectors"] })`, and `client.connections.list()` when you need a complete inventory.
3. In `run_sdk`, call `client.connections.connect({ connector_key })`. An `active` or `pending_auth` result carries a `connection_id`. A `setup_required` result is a continuation: follow its `next_action`, `resume_call`, or `completion_check` exactly and do not create a feed until a `connection_id` is present. If the result carries `self_install_url` (a Slack app bootstrap deep link), offer it to the user so they can create + install their own app and paste back the bot token / signing secret.
4. Create the feed with `client.feeds.create({ connection_id, feed_key, config })`. Connecting alone collects nothing.
5. Trigger and verify it with `client.feeds.trigger({ feed_id, dry_run: true })`, then inspect `client.feeds.get({ feed_id })`. A dry run prevents Lobu writes but cannot undo upstream side effects caused by the connector.

Virtual feeds query the provider live and can be read with `client.feeds.readMany(...)`; collected feeds persist events for search and relational queries.

Discover executable connector actions with `client.operations.listAvailable({ query, include_disconnected: true })`. Use the returned connection and operation target with `client.operations.execute({ connection_id, operation_key, input })`. If readiness is disconnected, follow the returned next action instead of guessing a connection. Approval-gated execution returns `pending_approval`; surface that state rather than treating it as failure.

## Data Ingestion

- Use `lobu memory seed` for small declarative YAML datasets under `./data`; it processes records sequentially and is not a bulk-backfill path.
- Use `client.knowledge.save` for schema-less semantic history such as messages, notes, observations, and content. Pass `supersedes_event_id` when replacing an existing fact.
- Use `client.entities.create` / `client.entities.update` only for strict structured records that match declared entity schemas.
- For large backfills, send bounded chunks through `run_sdk` / `lobu memory exec` and use `Promise.allSettled` so conflicts and partial failures remain visible.

```ts
export default async (_ctx, client) => {
  const records = [
    { content: "...", semantic_type: "note" },
    { content: "...", semantic_type: "observation" },
  ];
  return Promise.allSettled(records.map((record) => client.knowledge.save(record)));
};
```
