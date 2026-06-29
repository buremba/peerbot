---
title: lobu.config.ts reference
description: Complete reference for the lobu.config.ts authoring file and the @lobu/cli/config API.
sidebar:
  order: 1
---

`lobu.config.ts` is the project configuration file created by `lobu init`. It is a TypeScript module that default-exports `defineConfig({...})`. You author agents, providers, network access (including the LLM egress judge), guardrails, worker settings, the Lobu memory schema (entity types, relationship types, watchers), connections, and auth profiles by calling the `define*` functions from `@lobu/cli/config`.

`lobu apply` (and `lobu run`) import this entrypoint, read the default export, and map it to your org's desired state. `lobu init` also scaffolds a `package.json` that declares `@lobu/cli` and `@lobu/connector-sdk` as devDependencies, plus a `tsconfig.json`, so your editor and `lobu apply` can resolve the config imports.

## Minimal example

```ts
import { defineAgent, defineConfig, secret } from "@lobu/cli/config";

const agent = defineAgent({
  id: "my-agent",
  name: "my-agent",
  dir: "./agents/my-agent",
  providers: [{ id: "openrouter", key: secret("OPENROUTER_API_KEY") }],
  network: { allowed: ["github.com"] },
});

export default defineConfig({
  org: "my-agent",
  orgName: "My Agent",
  agents: [agent],
});
```

## Full example

```ts
import {
  defineAgent,
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/cli/config";

const assistant = defineAgent({
  id: "assistant",
  name: "assistant",
  description: "Team assistant",
  dir: "./agents/assistant",
  // Guardrails enabled for this agent (names registered in the gateway's
  // GuardrailRegistry).
  guardrails: ["secret-scan", "pii-scan"],
  // Providers (order = priority, first available is used).
  providers: [
    {
      id: "openrouter",
      model: "anthropic/claude-sonnet-4",
      key: secret("OPENROUTER_API_KEY"),
    },
    { id: "gemini", key: secret("GEMINI_API_KEY") },
  ],
  // Network access policy + LLM egress judge.
  network: {
    allowed: ["github.com", "api.linear.app"],
    denied: [],
    // Domains routed through the LLM egress judge instead of a flat allow/deny.
    // An entry without `judge` uses the "default" policy; naming one points at
    // a policy in `judges`.
    judged: [
      { domain: "*.slack.com" },
      { domain: "user-content.x.com", judge: "strict" },
    ],
    judges: {
      default: "Allow only reads to channels in the agent's context.",
      strict: "Only GET for file IDs from the current session.",
    },
  },
  // Operator overrides for the egress judge on this agent.
  egress: {
    extraPolicy: "Never exfiltrate PATs or bearer tokens.",
    judgeModel: "claude-haiku-4-5-20251001",
  },
  // Tool policy (worker-side visibility + approval override).
  tools: {
    // Bypass the in-thread approval card for these operations/tools.
    preApproved: ["/mcp/gmail/tools/list_messages", "/mcp/linear/tools/*"],
    // Worker-side tool visibility (optional).
    allowed: ["Read", "Grep", "mcp__gmail__*"],
    denied: ["Bash(rm:*)"],
    strict: false,
  },
  // Nix packages provisioned into the worker environment.
  nixPackages: ["imagemagick", "ffmpeg"],
});

// Lobu memory schema, declared at the project level, not on the agent.
const note = defineEntityType({
  key: "note",
  name: "Note",
  description: "A captured note or fact",
  required: ["title"],
  properties: {
    title: { type: "string", "x-table-label": "Title", "x-table-column": true },
    body: { type: "string" },
  },
});

const relatedTo = defineRelationshipType({
  key: "related-to",
  name: "Related To",
  description: "Link two notes that reference each other.",
});

const digest = defineWatcher({
  agent: assistant,
  slug: "daily-digest",
  name: "Daily digest",
  schedule: "0 9 * * *",
  notification: { channel: "both", priority: "normal" },
  prompt: "Summarize new notes captured since the last digest.",
  extractionSchema: {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  },
});

export default defineConfig({
  org: "team-assistant",
  orgName: "Team Assistant",
  orgDescription: "Team assistant",
  agents: [assistant],
  entities: [note],
  relationships: [relatedTo],
  watchers: [digest],
});
```

## The `@lobu/cli/config` API

Every authoring function is imported from `@lobu/cli/config`:

```ts
import {
  defineConfig,
  defineAgent,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  reactionFromFile,
  defineConnection,
  defineAuthProfile,
  secret,
  Type,
} from "@lobu/cli/config";
```

Each `define*` returns a branded handle. Assign it to a `const` and pass that handle wherever a reference is needed (for example a `defineWatcher` takes the `defineAgent` handle as its `agent`).

### `defineConfig(project)`

The default export of `lobu.config.ts`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `org` | string | no | Lobu Cloud org slug this project applies to |
| `orgName` | string | no | Display name used if `lobu apply` offers to provision the org |
| `orgDescription` | string | no | Org description |
| `organizationId` | string | no | Resolved Lobu Cloud org id that `lobu apply` matches against |
| `agents` | `Agent[]` | yes | Agents (from `defineAgent`) |
| `entities` | `EntityType[]` | no | Entity types (from `defineEntityType`) |
| `relationships` | `RelationshipType[]` | no | Relationship types (from `defineRelationshipType`) |
| `connections` | `Connection[]` | no | Connections (from `defineConnection`) |
| `authProfiles` | `AuthProfile[]` | no | Auth profiles (from `defineAuthProfile`) |
| `watchers` | `Watcher[]` | no | Watchers (from `defineWatcher`) |
| `connectors` | `ConnectorSource[]` | no | Local connector source files to compile + ship (from `connectorFromFile`; pass `connectorFromFile<typeof MyConnector>(...)` with an `import type` for go-to-def + a `tsc` check on the default export). Explicit list, no `./connectors` auto-discovery |

Connections, the memory schema, and watchers are declared at the project level (in `defineConfig`), not inside `defineAgent`. A watcher names its owning agent through its own `agent` field.

### `defineAgent(agent)`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Agent ID. Must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` (lowercase alphanumeric with hyphens; cannot start or end with a hyphen) |
| `name` | string | no | Display name shown in the admin UI |
| `description` | string | no | Short description shown in the admin UI |
| `dir` | string | no | Path to the agent content directory holding `IDENTITY.md`, `SOUL.md`, `USER.md`. Relative to the config file; defaults to `./agents/<id>` |
| `skills` | `Skill[]` | no | Skills the agent can use, built with `defineSkill(...)` (inline) or `skillFromFile(...)` (a `SKILL.md`). Explicit list, deduped by name; no folder auto-discovery |
| `providers` | `ProviderConfig[]` | no | LLM provider list (order = priority) |
| `network` | `NetworkConfig` | no | Network access policy + LLM egress-judge config |
| `egress` | `EgressConfig` | no | Operator overrides for the LLM egress judge on this agent |
| `tools` | `ToolsConfig` | no | Tool policy: pre-approval bypass + worker-side visibility |
| `guardrails` | `string[]` | no | Guardrails enabled for this agent. Each name must match a guardrail registered in the gateway's `GuardrailRegistry` at startup |
| `nixPackages` | `string[]` | no | Nix packages to install in the worker environment |
| `platforms` | `Platform[]` | no | Chat-platform bindings. A `slack` / `telegram` entry with no `config` uses the hosted Lobu bot (no token; `lobu run` prints a `/lobu link <code>`); provide `config` to run your own app |

#### `ProviderConfig`

Each entry configures an LLM provider. The first available provider is used at runtime.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | no | Provider identifier from `config/providers.json` (e.g. `openrouter`, `gemini`, `openai`) |
| `model` | string | yes | Model identifier (e.g. `anthropic/claude-sonnet-4`) |
| `key` | string \| `SecretRef` | no | API key. Use `secret("ENV_VAR")` rather than a literal value |

#### `NetworkConfig`

Controls which domains the worker can reach through the gateway proxy, plus per-agent rules for the LLM egress judge.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `allowed` | `string[]` | no | Domains to allow. Empty = no access. Use `["*"]` for unrestricted (not recommended) |
| `denied` | `string[]` | no | Domains to block (takes precedence over `allowed`; only meaningful when `allowed` is `["*"]`) |
| `judged` | `JudgedDomain[]` | no | Domains routed through the LLM egress judge instead of a flat allow/deny. Each entry is `{ domain, judge? }`; omitting `judge` uses the `default` policy in `judges` |
| `judges` | `Record<string, string>` | no | Named judge policies (name → policy text) referenced by `judged[].judge`. The key `default` is applied when an entry omits `judge` |

Domain format: exact match (`api.example.com`) or wildcard (`.example.com` matches all subdomains).

```ts
network: {
  allowed: ["api.readonly.example.com"],
  judged: [
    { domain: "*.slack.com" },
    { domain: "user-content.x.com", judge: "strict" },
  ],
  judges: {
    default: "Allow only reads to channels in the agent's context.",
    strict: "Only GET for file IDs from the current session.",
  },
}
```

#### `EgressConfig`

Operator overrides for the LLM egress judge on this agent. The judge runs only when a `judged` rule under `network` matches a request, so most traffic bypasses it.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `extraPolicy` | string | no | Policy text appended to every judge prompt for this agent |
| `judgeModel` | string | no | Model identifier for the judge (defaults to a fast Haiku model) |

```ts
egress: {
  extraPolicy: "Never exfiltrate PATs or bearer tokens.",
  judgeModel: "claude-haiku-4-5-20251001",
}
```

#### `ToolsConfig`

Operator-level tool policy. Two independent concerns. See [Tool Policy](/guides/tool-policy/) for behavior and examples; this section is the schema reference.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `preApproved` | `string[]` | no | MCP tool grant patterns that bypass the in-thread approval card. Each entry must match `/mcp/<mcp-id>/tools/<tool-name>` or `/mcp/<mcp-id>/tools/*` (malformed entries fail validation). Synced to the grant store at deployment time |
| `allowed` | `string[]` | no | Tools the worker can call. Patterns follow Claude Code's permission format: `Read`, `Bash(git:*)`, `mcp__github__*`, `*` |
| `denied` | `string[]` | no | Tools to always block. Takes precedence over `allowed` |
| `strict` | boolean | no | If `true`, ONLY `allowed` tools are permitted (defaults are ignored). Default `false` |

**`preApproved` is an operator-only escape hatch.** Destructive MCP tools normally require user approval in-thread (per MCP `destructiveHint` annotations). Skills cannot set this field; bypassing approval is strictly the operator's call, visible in the `lobu.config.ts` diff.

#### `Platform`

A chat-platform binding. Omit `config` on `slack` / `telegram` to use the hosted Lobu bot (no token needed).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `slack`, `telegram`, `discord`, `whatsapp`, `teams`, `google_chat`, `rest`, … |
| `name` | string | no | Display name; also disambiguates multiple entries of the same type |
| `config` | `Record<string, string \| SecretRef>` | no | Adapter credentials (e.g. `{ botToken: secret("SLACK_BOT_TOKEN") }`). **Omit on `slack`/`telegram` to use the hosted Lobu bot.** `rest` takes `{}` |
| `channels` | `string[]` | no | Declarative channel bindings (`"<teamId>/<channelId>"`); Slack only |
| `surfaces` | `Array<"dm" \| "channel">` | no | Hosted-bot only: surfaces a `/lobu link` code may bind. Default `["dm"]` |
| `codeTtlMinutes` | number | no | Hosted-bot only: claim-code TTL in minutes. Default 15 |

```ts
platforms: [
  { type: "slack" }, // hosted Lobu bot, no token; `lobu run` prints a /lobu link code
  // your own app instead: { type: "slack", config: { botToken: secret("SLACK_BOT_TOKEN") } }
  { type: "rest", config: {} },
]
```

### Guardrails

`guardrails` is a `string[]` on `defineAgent`. Each name must match a guardrail registered in the gateway's `GuardrailRegistry` at startup; names that don't resolve are ignored. Each guardrail targets one stage: `input` (user message to worker), `output` (worker text to user), or `pre-tool` (tool-call authorization).

```ts
const assistant = defineAgent({
  id: "assistant",
  dir: "./agents/assistant",
  guardrails: ["secret-scan", "pii-scan"],
});
```

### `defineEntityType(entityType)`

Declares an entity type in the Lobu memory schema. Pass it to `defineConfig({ entities: [...] })`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Stable slug, the diff key |
| `name` | string | no | Display name |
| `description` | string | no | Short description |
| `required` | `string[]` | no | Required property names for the entity's metadata |
| `properties` | `Record<string, unknown>` | no | JSON Schema properties for the entity's metadata. Add `"x-table-label"` / `"x-table-column": true` to surface a property as a column in the admin UI |
| `metadata` | `Record<string, unknown>` | no | Free-form metadata |

```ts
const lead = defineEntityType({
  key: "lead",
  name: "Lead",
  description: "A person who has shown a signal toward us",
  required: ["name", "stage"],
  properties: {
    name: { type: "string", "x-table-label": "Name", "x-table-column": true },
    stage: {
      type: "string",
      enum: ["signal", "trial", "customer"],
      "x-table-label": "Stage",
      "x-table-column": true,
    },
  },
});
```

### `defineRelationshipType(relationshipType)`

Declares a relationship type. Pass it to `defineConfig({ relationships: [...] })`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Stable slug, the diff key |
| `name` | string | no | Display name |
| `description` | string | no | Short description |
| `rules` | `Array<{ source, target }>` | no | Allowed source/target entity types; each a `defineEntityType` handle or a slug string |
| `metadata` | `Record<string, unknown>` | no | Free-form metadata |

```ts
const convertedTo = defineRelationshipType({
  key: "converted-to",
  name: "Converted To",
  description: "Links a lead to the pilot it became.",
  rules: [{ source: lead, target: pilot }],
});
```

### `defineWatcher(watcher)`

Declares a scheduled watcher. Pass it to `defineConfig({ watchers: [...] })`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | string | yes | Stable slug, the diff key |
| `agent` | `Agent` \| string | yes | Owning agent (handle or id). Every watcher belongs to exactly one agent |
| `name` | string | no | Display name |
| `description` | string | no | Short description |
| `schedule` | string | no | Cron schedule (e.g. `0 9 * * 1`) |
| `prompt` | string | yes | Instructions the watcher runs each firing |
| `extractionSchema` | `Record<string, unknown>` | yes | JSON Schema (or TypeBox schema) describing the LLM output |
| `sources` | `Record<string, string>` | no | Named SQL data sources (`name` → query) |
| `notification` | `{ channel?, priority? }` | no | `channel`: `canvas` \| `notification` \| `both`; `priority`: `low` \| `normal` \| `high` |
| `minCooldownSeconds` | number | no | Minimum seconds between firings |
| `tags` | `string[]` | no | Free-form tags |
| `reactionsGuidance` | string | no | LLM guidance for the watcher's downstream reaction agent |
| `agentKind` | string | no | Agent-kind override for firings (e.g. `background`, `notifier`) |
| `reaction` | `ReactionSource` | no | A sibling `.ts` reaction script referenced with `reactionFromFile("./reactions/foo.reaction.ts")` (pass `reactionFromFile<typeof handler>(...)` with an `import type` for go-to-def + a `tsc` check on the default export), compiled and run in a sandboxed isolate when the watcher fires. The script must `export default async (ctx, client) => …`. See the [Reaction SDK](/sdks/reactions/) |

```ts
import type weeklyDigestReaction from "./reactions/weekly-digest.reaction.ts";

const digest = defineWatcher({
  agent: crm,
  slug: "weekly-digest",
  name: "Weekly digest",
  schedule: "0 9 * * 1",
  notification: { channel: "both", priority: "high" },
  minCooldownSeconds: 3600,
  tags: ["crm", "weekly"],
  reaction: reactionFromFile<typeof weeklyDigestReaction>(
    "./reactions/weekly-digest.reaction.ts"
  ),
  prompt: "Produce the weekly digest and post it to Slack. Keep it short.",
  extractionSchema: {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  },
});
```

### `defineConnection(connection)`

Declares a connection to a connector. Pass it to `defineConfig({ connections: [...] })`. The connection's OAuth grant (for `oauth_account` / `browser_session` profiles) is performed at runtime in the admin UI.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | string | yes | Stable slug, the diff key |
| `connector` | string \| `ConnectorClass` | yes | Connector key, or the class produced by `defineConnector` |
| `name` | string | no | Display name |
| `authProfile` | `AuthProfile` \| string | no | Runtime/account auth profile (handle or slug) |
| `appAuthProfile` | `AuthProfile` \| string | no | OAuth-app auth profile (handle or slug) |
| `config` | `Record<string, unknown>` | no | Connector configuration |
| `deviceWorkerId` | string | no | UUID pinning syncs/actions to a specific device worker |
| `feeds` | `ConnectionFeed[]` | no | Scheduled feeds. Each is `{ feed, name?, schedule?, config? }`, where `feed` is a feed key from the connector |

```ts
const githubConn = defineConnection({
  slug: "github-lobu",
  connector: "github",
  name: "GitHub - lobu-ai/lobu",
  authProfile: githubAccountAuth,
  appAuthProfile: githubAppAuth,
  config: { repo_owner: "lobu-ai", repo_name: "lobu" },
  feeds: [
    {
      feed: "issues",
      name: "Issues",
      schedule: "15 */6 * * *",
      config: { repo_owner: "lobu-ai", repo_name: "lobu", lookback_days: 90 },
    },
  ],
});
```

### `defineAuthProfile(authProfile)`

Declares an auth profile a connection references. Pass it to `defineConfig({ authProfiles: [...] })`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | string | yes | Stable slug, the diff key |
| `connector` | string \| `ConnectorClass` | yes | Connector this profile authenticates |
| `authKind` | `env` \| `oauth_app` \| `oauth_account` \| `browser_session` | yes | Authentication kind |
| `name` | string | no | Display name |
| `credentials` | `Record<string, string \| SecretRef>` | no | Credential references (use `secret("ENV_VAR")`). Only meaningful for `env` / `oauth_app`; the grant for `oauth_account` / `browser_session` is performed at runtime in the UI |

```ts
const githubApp = defineAuthProfile({
  slug: "github-app",
  connector: "github",
  authKind: "oauth_app",
  name: "GitHub OAuth App",
  credentials: {
    GITHUB_CLIENT_ID: secret("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: secret("GITHUB_CLIENT_SECRET"),
  },
});
```

### `secret(name)`

Returns a write-only secret reference resolved at `lobu apply` time from the environment (`.env` / `process.env`). The real value is never embedded in committed code. Use it for provider keys, MCP credentials, and auth-profile credentials.

```ts
key: secret("OPENROUTER_API_KEY")
```

The apply loader resolves the reference at apply time. For provider `key` fields, the resolved value is pushed to the server's secrets store. For MCP credentials and auth-profile credentials, a `$NAME` placeholder is stored; the real value is resolved at worker egress time and never uploaded.

### `Type`

Re-exported TypeBox `Type` for authoring extraction schemas and feed/action config schemas with full TypeScript inference. You can pass a TypeBox schema anywhere an `extractionSchema` or connector config schema is accepted, or use a plain JSON Schema object.

## Chat platforms

Chat platforms (Slack, Telegram, Discord, WhatsApp, Teams, Google Chat) are declared on the agent via `platforms`, or connected through the `/agents` admin UI / CRUD API. Bot tokens and secrets live in `.env` as `secret(...)` refs. See [Slack](/platforms/slack/) for the per-platform setup.

To skip the bot-token setup, omit `config` on a `slack` / `telegram` entry to use the hosted Lobu bot: `lobu run` prints a short-lived `/lobu link <code>` you redeem by DMing the hosted bot (Slack also supports a one-time "Add to Slack" to use it in your own workspace).

## Lobu memory

Entity types, relationship types, and watchers are the memory schema. Declare them with `defineEntityType` / `defineRelationshipType` / `defineWatcher` and list them in `defineConfig`. `lobu apply` reconciles them against your org. See [`lobu memory`](/reference/lobu-memory/) and [`lobu apply`](/reference/lobu-apply/).

The org slug comes from `defineConfig({ org })`. `MEMORY_URL` is available as an optional base-endpoint override for local or custom Lobu deployments.

## Validation

```bash
npx @lobu/cli@latest validate
```

Checks that `lobu.config.ts` loads, conforms to the schema, and that skill IDs and provider configuration are valid. Returns exit code 1 on failure.
</content>
</invoke>
