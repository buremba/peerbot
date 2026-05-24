---
title: lobu apply CLI Reference
description: Sync your local lobu.config.ts + agent dirs to a Lobu Cloud org. One-way, idempotent, prompt-confirmed.
---

`lobu apply` imports `lobu.config.ts`, computes a diff against your cloud org, shows a plan, and once you accept calls existing CRUD endpoints in dependency order to converge the org to match your project.

Mental model: `terraform apply` lite. Files are the source of truth; the cloud is a follower.

## Surface

```bash
lobu apply                       # plan + prompt + apply
lobu apply --dry-run             # plan only
lobu apply --yes                 # plan + apply, no prompt (CI)
lobu apply --only agents         # restrict to agent resources
lobu apply --only memory         # restrict to entity + relationship types + watchers
lobu apply --org my-org          # override active org
lobu apply --url https://...     # override the server URL
lobu apply --force               # bypass the .lobu/project.json link guard
lobu deploy                      # `deploy` is an alias for `apply`
```

| Flag | Description |
| --- | --- |
| `--dry-run` | Show the plan and exit without mutating |
| `--yes` | Skip the confirmation prompt (CI mode) |
| `--only <kind>` | Restrict to one resource family: `agents` or `memory` |
| `--org <slug>` | Org slug override (defaults to the active session) |
| `--url <url>` | Server URL override |
| `--force` | Bypass the project-link guard when `.lobu/project.json` points at a different `(context, org)` |

Authentication is shared with the rest of the CLI. Run `lobu login` once.

## What gets synced

- Agents (metadata: `agentId`, `name`, `description`)
- Agent settings: `networkConfig`, `egressConfig`, `nixConfig`, `mcpServers`, `skillsConfig`, `toolsConfig`, `guardrails`, `preApprovedTools`, `providerModelPreferences`, `modelSelection`, `IDENTITY.md` / `SOUL.md` / `USER.md`
- Memory entity types, relationship types, and watchers declared with `defineEntityType` / `defineRelationshipType` / `defineWatcher`
- Connections and auth profiles declared with `defineConnection` / `defineAuthProfile`, plus the connectors they reference

The memory schema is declared directly in `lobu.config.ts` and passed to `defineConfig`:

```ts
import {
  defineConfig,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
} from "@lobu/cli/config";

const account = defineEntityType({ key: "account", name: "Account" });
const owns = defineRelationshipType({ key: "owns", name: "Owns" });
const digest = defineWatcher({
  agent: "sales",
  slug: "account-digest",
  name: "Account digest",
  schedule: "0 9 * * 1",
  prompt: "Summarize account changes.",
  extractionSchema: { type: "object", properties: {} },
});

export default defineConfig({
  agents: [/* ... */],
  entities: [account],
  relationships: [owns],
  watchers: [digest],
});
```

Chat platforms are not synced by `lobu apply`. Connect them through the `/agents` admin UI or the CRUD API.

## What is not synced

- Chat platforms (connect them through the admin UI or CRUD API)
- Memory data (entities, relationships, knowledge events)
- Secret values — `lobu apply` only checks that the env vars referenced via `secret("VAR")` in `lobu.config.ts` are present locally, never uploads their values
- Anything not in the list above

## Plan output

Each row is one of four verbs:

| Marker | Meaning |
| --- | --- |
| `+ create` | resource doesn't exist in the cloud — will be created |
| `~ update` | resource exists with different content — will be patched (changed fields shown) |
| `= noop` | resource exists and matches the desired state |
| `? drift` | cloud has a resource not declared in `lobu.config.ts` — **reported only**, never deleted in v1 |

## Apply order

```
required-secrets check
        ↓
upsertAgent          (POST /api/:org/agents/)
        ↓
patchAgentSettings   (PATCH /api/:org/agents/:id/config)
        ↓
upsertEntityType        (manage_entity_schema)
        ↓
upsertRelationshipType  (manage_entity_schema)
        ↓
upsertWatcher
        ↓
upsertAuthProfile / upsertConnection (when connectors are declared)
```

If any call fails, the CLI prints partial progress and exits non-zero. Every endpoint is idempotent — re-running converges.

## Required secrets

Before any mutation, `lobu apply` collects every `secret("VAR")` reference in `lobu.config.ts`:

- provider `key` on `defineAgent({ providers })`
- `mcpServers` `headers`, `env`, and `oauth` credentials on `defineAgent`
- `credentials` on `defineAuthProfile`

Each name must be set in the apply runner's environment (e.g. via `.env` loaded by your shell). Any missing name short-circuits the apply with a list of every missing var.

Secret values are never uploaded by `lobu apply`. Use your deployment's secret manager.

## Drift

Cloud-side resources not declared in `lobu.config.ts` are reported but never deleted. v1 has no `--prune`. To remove a cloud-side agent, use the admin UI or the underlying CRUD endpoints directly; the next `lobu apply` will continue to surface it as drift until you remove it from the cloud or add it to your project.

## CI usage

```bash
lobu login --token "$LOBU_API_TOKEN"
lobu apply --yes --org my-org
```

`--yes` skips the confirmation prompt. Without `--yes`, a non-TTY apply exits non-zero rather than hang waiting for input.

## Related

- Lobu CLI: [CLI Reference](/reference/cli/)
- Memory CLI: [Memory](/reference/lobu-memory/)
- `lobu.config.ts`: [Configuration Reference](/reference/lobu-config/)
