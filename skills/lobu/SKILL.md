---
name: lobu
description: Scaffold a new Lobu agent project from a user interview, then build, run, and maintain it, including lobu.config.ts, prompt files, local skills, evals, providers, connections, and Lobu memory workflows.
---

# Lobu

Use this skill when the user wants to scaffold a new Lobu agent (no existing project), or when they're working on an existing Lobu project — running, validating, evaluating, or connecting one. Also use it for persistent Lobu memory, MCP client setup, OpenClaw memory plugin configuration, knowledge search/save workflows, watchers, and browser-authenticated connectors.

If no `lobu.config.ts` exists in the current working directory, treat the user as a first-time user and run the "First-Time Setup" flow below. Otherwise jump straight to "Core Model" + the relevant reference section.

## First-Time Setup

The user has installed this skill and wants a working Lobu agent end-to-end. Run the four phases below in order. Pause at every real decision and ask the user — do not fake credentials, do not guess. Cite specific docs/files when you do not know something.

### Phase 1 — Environment

Verify the host can run Lobu before writing any code:

- Node.js 22.x–24.x. Reject Node 25+ (it breaks `isolated-vm`, which the worker depends on). If missing, instruct the user to install via `nvm`, `fnm`, or `mise`.
- Bun (used to run the CLI from npm). Install via `curl -fsSL https://bun.sh/install | bash` if missing.
- A reachable Postgres with the `pgvector` extension. If the user does not have one, point them at `docker run -d --name lobu-pg -p 5432:5432 -e POSTGRES_PASSWORD=lobu pgvector/pgvector:pg16` or Neon/Supabase.
- One LLM provider API key. Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`), or Z.ai (`ZAI_API_KEY`). Ask the user which they have; do not pick for them.

Capture `DATABASE_URL` and the provider key in the user's response — they will go into `.env` in Phase 3.

### Phase 2 — Interview

Ask short, concrete questions one at a time. Wait for the answer before asking the next. Do not batch questions.

1. **What is the agent for?** One sentence. (Example: "Triage support emails and draft replies for the on-call engineer.")
2. **Who uses it?** Just you, your team, or each of your customers (multi-tenant)?
3. **What does it need to remember?** Translate the answer into 1–3 entity types. (Example: "support tickets, customers, recurring issues.")
4. **Where does the data come from?** One source to start. (Slack, Gmail, GitHub, Linear, Stripe, a custom webhook, a CSV — pick one.) If the user names a source Lobu does not ship a bundled connector for, plan to write a custom `connector.ts`.
5. **Where do people talk to it?** Slack, Telegram, Discord, MS Teams, WhatsApp, web (HTTP API), or MCP-only?
6. **What should it do on a schedule, if anything?** For v1, propose at most one "dreaming" watcher (e.g. "every morning at 8am, cluster yesterday's tickets by root cause"). Skip if the user does not need one.

### Phase 3 — Scaffold

Based on the interview answers, run:

```bash
npx @lobu/cli@latest init <agent-name>
cd <agent-name>
```

The CLI generates the directory layout, including `lobu.config.ts`, `package.json`, and `tsconfig.json`. All authoring is TypeScript: import `defineConfig`, `defineAgent`, `defineEntityType`, `defineRelationshipType`, `defineWatcher`, `defineConnection`, `defineAuthProfile`, and `secret` from `@lobu/cli/config`. Read `examples/lobu-crm/lobu.config.ts` in the lobu repo for a complete, working reference before editing. Then edit:

- **`lobu.config.ts`** — set the agent name + description from question 1 on `defineAgent`; add the chosen provider with `providers: [{ id, model, key: secret("X_API_KEY") }]`; set `org` / `orgName` in `defineConfig` from a slug of the user's choice.
- **`.env`** — fill in `DATABASE_URL` and the provider API key from Phase 1.
- **Entity types** — declare the entity types from question 3 with `defineEntityType({ key, name, properties })` and list them in `defineConfig({ entities: [...] })`. Each property is a JSON Schema fragment; add `"x-table-label"` / `"x-table-column": true` to surface a column in the admin UI.
- **`<name>.connector.ts`** — only if the source from question 4 is not a bundled connector. Model it on `examples/lobu-crm/funnel-form.connector.ts` in the lobu repo, then list it with `connectorFromFile("./<name>.connector.ts")` in `defineConfig({ connectors: [...] })`.
- **Watchers** — add one watcher with `defineWatcher({ agent, slug, prompt, extractionSchema, schedule? })` and list it in `defineConfig({ watchers: [...] })`. Use the cron `schedule` from question 6 if the user wants one.
- **`<name>.reaction.ts`** — only if the watcher needs to call actions after extracting (post to Slack, update an entity, etc.). Point the watcher at it with `reaction: "./<name>.reaction.ts"`. Default (no `reaction`) just writes the extracted data to memory.

Then boot:

```bash
npx @lobu/cli@latest run
```

The CLI starts the embedded gateway + worker on `http://localhost:8787`.

### Phase 4 — Verify

Confirm the agent works end-to-end before declaring done:

1. Send a test message via the chosen channel from question 5 (or the local web UI at `http://localhost:8787` if MCP-only).
2. Confirm the agent replies.
3. If you wired a connector, trigger a real event (or post a synthetic one) and confirm the watcher fired:
   ```bash
   npx @lobu/cli@latest memory run search_memory '{"query": "<something the watcher would have extracted>"}'
   ```
4. Show the user the memory event row from step 3, plus the admin UI at `http://localhost:8787/<org>/events` so they can see the structured record.

If anything fails, do not silently move on — surface the error, propose a fix, and only continue once the user confirms.

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
5. When prompt or behavior changes, run evals via promptfoo (see `examples/personal-finance/evals/promptfooconfig.yaml`). The in-house `lobu eval` command has been removed.

## Common Commands

```bash
npx @lobu/cli@latest init my-agent
npx @lobu/cli@latest run
npx @lobu/cli@latest validate
npx @lobu/cli@latest login
```

<!-- lobu-memory-guidance:start -->
## Memory Defaults

Your long-term memory is powered by Lobu. Do NOT use local files (memory/, MEMORY.md) for memory.
- Lobu automatically recalls relevant memories when you receive a message.
- To save something, call save_memory with the content and an appropriate semantic_type.
- To search, call search_memory. Results include view_url links to the web interface.
- NEVER construct Lobu URLs yourself. When the user asks for a link, call search_memory to get the correct view_url.
- When the user says "remember this", save it to Lobu immediately.
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

## OpenClaw Memory Plugin

For OpenClaw, install the plugin and let the Lobu CLI write plugin config:

```bash
openclaw plugins install @lobu/openclaw-plugin
lobu login
lobu memory configure --url <mcp-url> --org <org-slug>
lobu memory health --url <mcp-url> --org <org-slug>
```

`lobu memory configure` writes a token command that uses `lobu token --raw`, so OpenClaw reuses the top-level Lobu login.

## Browser-Authenticated Connectors

For connectors that need cookies from a local browser session:

```bash
lobu memory browser-auth --connector <key> --auth-profile-slug <slug>
lobu memory browser-auth --connector <key> --auth-profile-slug <slug> --check
```

Use `--chrome-profile`, `--launch-cdp`, and `--dedicated-profile` only when the user needs a specific browser profile or dedicated remote-debugging profile.

## Tool Discipline

- Search before create to avoid duplicate entities.
- Never fabricate Lobu memory links. If a tool returns a view URL, use that URL.
- Use canonical MCP tool names only.
- Prefer read-only operations before mutations when validating connectivity.
- `events` is append-only: never delete rows directly; use tombstone/supersede flows.
