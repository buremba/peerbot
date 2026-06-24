# Spec: `git push` → append-only `events`

*How a push to Lobu's synthetic git remote becomes staged, supersession-linked `events` rows. Code-grounded; every translation rule maps to a concrete `insertEvent(...)` call.* (Spike output, 2026-06-22; confidence 78/100.)

## 0. Ground truth from the code

- **`events` is append-only** (`db/migrations/00000000000000_baseline.sql:894` — *"Never DELETE; supersede with a tombstone row that points at the original via supersedes_event_id"*). `supersedes_event_id bigint` at `:881`; FK at `:5042` (`ON DELETE SET NULL`).
- **The "current" projection** is the view `current_event_records` (`baseline.sql:951-992`): a row is current iff `NOT EXISTS (newer WHERE newer.supersedes_event_id = e.id)`. **This is exactly the tree a clone materializes from.**
- **At-most-one-superseder invariant**: `CREATE UNIQUE INDEX idx_events_superseded_by ON events (supersedes_event_id) WHERE supersedes_event_id IS NOT NULL` (`baseline.sql:3996`). Two writers can't both supersede the same base event — loser gets SQLSTATE `23505` (`save_content.ts:35-48`). **Row-level optimistic-concurrency primitive backing git ref CAS at the DB layer.**
- **`insertEvent`** (`insert-event.ts:247-433`) is the single chokepoint. Two supersession mechanisms: explicit `supersedesEventId` (`:87`, INSERT `:362`); origin-keyed auto-supersession via `onConflictUpdate:true` → `findCurrentEventByOrigin` (`:119-167`) + `isSemanticallyEqual` no-op (`:169-199`), serialized under `pg_advisory_xact_lock` (`:422-430`).
- **Validation**: `validateSaveContentSemanticType` (`event-kind-validation.ts:258-277`) checks `semantic_type`+`metadata` against the entity type's `event_kinds`; **permissive when none defined** (`:184-187`).
- **Entity metadata** on `entities.metadata jsonb`; field edits mutate it (`updateEntity`, `entity-management.ts:343-415`) and emit an audit `change` event (`recordChangeEvent`, `insert-event.ts:458-490`).
- **Relationships** via `manage_entity` link (`manage_entity.ts:1058-1085`). **`runs`** carries provenance; `events.run_id` links event→run (`baseline.sql:871`).

## 1. The repo projection (what a clone materializes)

Synthesized from `current_event_records` + `entities` + `entity_relationships`:

```
/<entity_type_slug>/<entity_slug>.md
```
```markdown
---
lobu_id: 4217        # entities.id — STABLE identity, never user-editable
lobu_type: person    # entity_type slug (authoritative)
lobu_rev: 88123      # high-water event id at clone time (optimistic base, Policy 7)
title: "VP Engineering"
email: jane@acme.com
links:
  works_at: company/acme.md
---
<body: current note/summary/content events, newest first, each fenced with its source event id>
```
Reserved/server-owned (rejected if mutated): `lobu_id`, `lobu_type`, `lobu_rev`. Other frontmatter keys = entity-metadata fields; body = prose → note events.

**Origin-id scheme (the supersession key).** Translator runs as a dedicated synthetic connection (`connector_key='git'`, per-org `connection_id`). Deterministic `origin_id`:

| Source | `origin_id` |
|---|---|
| frontmatter field `K` of entity `E` | `git:ent:<E>:meta:<K>` |
| body note block id `N` | `git:ent:<E>:body:<N>` |
| new body prose | `git:ent:<E>:body:<sha256(text)[:12]>` |

`onConflictUpdate:true` → re-pushing a field auto-supersedes its prior current event; unchanged → no-op. **The tree diff is an optimization; correctness comes from origin-keyed dedup + `lobu_rev` base check.**

## 2. Core mapping (changed entity file → events)

1. Parse frontmatter (YAML) + body. Invalid YAML → reject whole push (Policy 6).
2. Resolve `lobu_id` → entity (org-scoped). No match + no `lobu_id` → creation (Policy 9).
3. `parsedFrontmatter Δ projected` → per-field events; `parsedBody Δ projected` → note events.
4. Validate each; fail → reject whole push (Policy 6).
5. Stage all `insertEvent(...)` **in one `sql.begin` transaction stamped with the push's `run_id`** — a commit is atomic.

Frontmatter field `K=v` → `updateEntity(E,{metadata:{K:v}})` + `insertEvent({entityIds:[E], originId:'git:ent:E:meta:K', semanticType:chooseKind(E,K), content:String(v), payloadData:{field:K,value:v}, metadata:{category:'entity_field',field:K,namespace:'git'}, connectorKey:'git', connectionId:GIT_CONN_ID, runId:PUSH_RUN_ID, createdBy:PUSHER}, {onConflictUpdate:true})`. Body block → same shape, `semanticType:'note'`, `payloadType:'markdown'`.

## 3. Policies (hard cases)

1. **MODIFY single field (happy path)** — origin-keyed supersession; old event masked, new current; no DELETE; advisory lock serializes vs concurrent connector writes.
2. **RENAME (`git -M`)** — identity = `lobu_id`, not path. Same id + path change → slug field edit. `lobu_id` stripped → delete+create. `lobu_id` reassigned to another existing id → reject whole push.
3. **DELETE a file** — never `DELETE FROM events`. Soft-delete entity (`deleted_at`) + tombstone lifecycle event (`recordLifecycleEvent` shape, `insert-event.ts:530-570`). Deleting one frontmatter field → supersede that field's event with a tombstone (`metadata.status='deleted'`, `payloadData.value=null`).
4. **Field owned by a CONNECTOR/other agent** — prior writer known (current value's event has `connection_id != GIT_CONN_ID`). **Flag, don't silently clobber.** Supersede only if the type marks the field user-writable; else reject with conflict ("field `email` owned by connector `whatsapp`; override with `lobu_override:[email]`"). Override records `metadata.supersedes_provenance`.
5. **UNKNOWN frontmatter key** — `metadata_schema` is the allow-list. Strict types → reject as *"schema change needed"* (a schema edit is a deliberate migration via `/_schema/<type>.md` → `manageEntitySchema`, its own commit). Permissive types → accept as plain field event.
6. **Invalid YAML / schema failure → fail closed** — whole push rejected atomically (validate all changed files *before* opening the tx). Surfaced as non-zero `git push` exit with the report on the side-band. Mirrors `save_content` `ToolUserError(422)` — user fault, no Sentry.
7. **Concurrent supersession** — two layers: (1) **git ref CAS** (coarse) → non-fast-forward rejection, client rebases/re-clones; (2) **per-field optimistic base check** (fine) → explicit `supersedesEventId = <event current for this origin at clone time>`; if already superseded, `idx_events_superseded_by` UNIQUE throws `23505` → per-file conflict. Use explicit `supersedesEventId` when `lobu_rev` present, else `onConflictUpdate`.
8. **Body prose change** — each block has a stable `blockId`; edit → supersede that block's note event; add → fresh note; delete → tombstone note. Timeline preserved (superseded notes masked, not deleted; full chain queryable).
9. **NEW file + relations** — `createEntity({entity_type:<dir slug>, name, slug, metadata:<frontmatter minus reserved/links>, ...})` + creation lifecycle event + each `links:` → `entity_relationships` (`source='git'`, `confidence=1.0`); removed link → soft-delete relationship. Server assigns `lobu_id` (open Q1).

## 4. Worked example

`person/jane-doe.md` (entity 4217), one commit, `PUSH_RUN_ID=99001`, pusher `user_abc`, `GIT_CONN_ID=70`; projection `lobu_rev:88123`, `title` current event `88010`, `aliases` `88044`.

```diff
@@ frontmatter
- title: "Engineer"           +title: "VP Engineering"
- aliases: ["jd","jane.d"]     +aliases: ["jd"]
@@ body
+ <!--block:new--> Met at the Q2 offsite; owns the latency workstream.
```

→ 3 `insertEvent` calls in one `run_id=99001` tx:
1. title → `supersedesEventId:88010`, `semanticType:'identity'`.
2. aliases → `supersedesEventId:88044`, `semanticType:'fact'`, `metadata.removed:['jane.d']`.
3. new body block → `semanticType:'note'`, `onConflictUpdate` (first-write).

Net: 3 new rows; `88010`/`88044` masked (pointed at via `supersedes_event_id`); `entities.metadata` updated; **zero deletes**. If `88010` was superseded between clone and push → `23505` on call #1 → whole tx rolls back → conflict reported on the file. (Dropping alias `jane.d` is *not* its own event — `aliases` is one array field → one field-supersession with `metadata.removed`; per-alias timeline needs aliases as child entities, open Q4.)

## 5. Open questions

1. **Server-assigned `lobu_id` round-trip** — server mints id on creation but the pushed tree lacks it. Either (a) server rewrites the ref to a tree carrying the id + client re-clones, or (b) client pre-allocates via push option. Shapes offline-writability across multiple creates. *(Assumed (a).)*
2. **`run_id` provenance** — run id via `GIT_PUSH_OPTION_*`/ref namespace; the `runs` row must exist before events FK it. Does the push create the run (`run_type='git_push'`) or must the client pre-register? *(Assumed push creates it.)*
3. **`semantic_type` per field** — should be declared on the entity type (`field → event_kind` map in `metadata_schema`), else every edit lands as `change`.
4. **Array/object field granularity** — list fields supersede whole; per-element timeline needs child entities or a structured `payloadData` diff convention.
5. **Connector-field override UX** (`lobu_override:`) — invented here; needs product sign-off.
6. **Body block identity** — depends on stable fence markers surviving the client's editor; needs a robust marker or a block→event-id manifest.
7. **Transaction size** — a push touching thousands of files = one big tx holding many advisory locks; may need batching, weakening "one commit = atomic."

## Next actions
1. Decide the **`lobu_id` mint/round-trip** (Q1) — gates offline-writability; then lock the frontmatter contract.
2. Settle **`run_id` provenance** (Q2).
3. Add a **`field → event_kind` declaration** to `entity_types` (Q3).
4. **Prototype the read path first** and round-trip a no-op `clone → push` to prove `isSemanticallyEqual` yields zero events before building the write translator.
