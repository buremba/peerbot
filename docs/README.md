# Lobu docs — index

Hierarchy-first: read `CONCEPTS.md` first, then go deep on the surface you are
touching. `plans/` holds design history rather than the current contract; use the
docs below for shipped behavior.

## Concepts (read first)

- **`CONCEPTS.md`** — entities vs events, identity (`origin_id` vs `events.id`),
  the end-to-end lifecycle, the feature map, webhook connections.
- **`AUTOMATIONS.md`** — the Automation primitive contract: triggers, sources,
  outputs, chaining, and their safety limits.

## Build

- **`connector-authoring.md`** — when and how to write a custom connector
  (`connectorFromFile`, `defineConnector`, feeds, `eventKinds`, actions, auth).
- **`database-connectors.md`** — the Postgres connector and governed `query_sql`.

## Operate the repo

- **`AGENT_PLAYBOOK.md`** — supporting rationale, incident history, and exact
  flags for the root and package agent rules.
- **`GOTCHAS.md`** — symptom-indexed traps by surface (build, SQL, testing,
  submodule, browser).
- **`BROWSER_TESTING.md`** — authenticated browser verification runbook.
- **`MIGRATIONS.md`** — dbmate safety rules for hot tables.
- **`RELEASING.md`** — release-please flow and recovery paths.
- **`REVIEW_SCHEMA.md`** — the `make review` verdict schema and gates.
- **`SECURITY.md`** — self-host threat model and credential invariants.
- **`DOCKER.md`** — self-hosting the `lobu-app` image.
