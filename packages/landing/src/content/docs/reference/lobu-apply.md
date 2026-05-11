---
title: lobu apply CLI Reference
description: Sync your local lobu.toml + agent dirs to a Lobu Cloud org. One-way, idempotent, prompt-confirmed.
---

`lobu apply` reads `lobu.toml`, computes a diff against your cloud org, shows a plan, and — once you accept — calls existing CRUD endpoints in dependency order to converge the org to match your files.

Mental model: `terraform apply` lite. Files are the source of truth; the cloud is a follower.

## Surface

```bash
lobu apply                       # plan + prompt + apply
lobu apply --dry-run             # plan only
lobu apply --yes                 # plan + apply, no prompt (CI)
lobu apply --only agents         # restrict to agent + platform resources
lobu apply --only memory         # restrict to entity + relationship types
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

## What gets synced (v1)

- Agents (metadata: `agentId`, `name`, `description`)
- Agent settings: `networkConfig`, `egressConfig`, `nixConfig`, `mcpServers`, `skillsConfig`, `toolsConfig`, `guardrails`, `preApprovedTools`, `providerModelPreferences`, `modelSelection`, `IDENTITY.md` / `SOUL.md` / `USER.md`
- Chat platforms under `[[agents.<id>.platforms]]`, keyed by a stable ID derived from `(agentId, type, name?)`
- Memory entity types and relationship types (from `models/*.yaml` referenced by `[memory].models`)

## What is not synced (v1)

- Watchers — declare them in cloud or via `lobu memory seed` for now
- Memory data (entities, relationships, knowledge events)
- Secret values — `lobu apply` only checks that the env vars referenced as `$VAR` in `lobu.toml` are present locally, never uploads their values
- Anything not in the list above

## Plan output

Each row is one of four verbs:

| Marker | Meaning |
| --- | --- |
| `+ create` | resource doesn't exist in the cloud — will be created |
| `~ update` | resource exists with different content — will be patched (changed fields shown) |
| `= noop` | resource exists and matches the desired state |
| `? drift` | cloud has a resource not declared in `lobu.toml` — **reported only**, never deleted in v1 |

When a platform update will restart the live worker, the plan adds an inline warning line.

## Apply order

```
required-secrets check
        ↓
upsertAgent          (POST /api/:org/agents/)
        ↓
patchAgentSettings   (PATCH /api/:org/agents/:id/config)
        ↓
upsertPlatform       (PUT /api/:org/agents/:id/platforms/by-stable-id/:stableId)
        ↓
upsertEntityType        (manage_entity_schema)
        ↓
upsertRelationshipType  (manage_entity_schema)
```

If any call fails, the CLI prints partial progress and exits non-zero. Every endpoint is idempotent — re-running converges.

## Required secrets

Before any mutation, `lobu apply` walks `lobu.toml` for `$VAR` references in:

- `[[agents.<id>.providers]]` — `key`, `secret_ref`
- `[[agents.<id>.platforms]]` — every value in `[agents.<id>.platforms.config]`
- `[agents.<id>.skills.mcp.<id>]` — `headers`, `env`, `oauth.client_id`, `oauth.client_secret`

Each name must be set in the apply runner's environment (e.g. via `.env` loaded by your shell). Any missing name short-circuits the apply with a list of every missing var.

Secret values are never uploaded by `lobu apply`. Use your deployment's secret manager.

## Drift

Cloud-side resources not declared in `lobu.toml` are reported but never deleted. v1 has no `--prune`. To remove a cloud-side agent or platform, use the admin UI or the underlying CRUD endpoints directly; the next `lobu apply` will continue to surface it as drift until you remove it from the cloud or add it to your files.

## Stable platform IDs

Each platform's URL — including webhook URLs (`/api/v1/webhooks/<id>`) — is derived from `(agentId, type, name)`:

```
{slugify(agentId)}-{slugify(type)}[-{slugify(name)}]
```

When you have more than one platform of the same `type` under the same agent, `name = "..."` is required. The same rule applies in `lobu run` (file-loader.ts) — both paths build identical stable IDs.

## CI usage

```bash
lobu login --token "$LOBU_API_TOKEN"
lobu apply --yes --org my-org
```

`--yes` skips the confirmation prompt. Without `--yes`, a non-TTY apply exits non-zero rather than hang waiting for input.

## Related

- Lobu CLI: [CLI Reference](/reference/cli/)
- Memory CLI: [Memory](/reference/lobu-memory/)
- `lobu.toml`: [Configuration Reference](/reference/lobu-toml/)
