# World Model

Long-term shape of how knowledge, identity, and templates are organized across
tenants and public catalogs in Lobu.

## TL;DR

- Two org kinds (`tenant`, `public_catalog`), two visibilities (`private`, `public`).
- One graph: `entities` + `entity_relationships` + `entity_identities` are the
  universal primitives. Orgs are trust slices through that graph.
- Cross-org relationships allowed in **one direction only**: tenant → public_catalog.
- Templates are entities of type `agent_template` in a public_catalog org. No
  schema cloning on install — agents read vocabularies from public catalogs at
  runtime.
- Contribution to public knowledge happens by inviting the public org's admin
  agent into your private org as a member. Existing membership/messaging
  primitives, no draft tables, no contributor roles.
- No Postgres RLS in phase 1. App-level org-scoped queries (already in place)
  plus a write-side guard on relationship inserts are sufficient given the
  one-directional reference rule.

## Cleanup before phase 1

| PR | Action | Why |
| --- | --- | --- |
| #351 — `managed_by_template_agent_id` + `source_template_org_id` columns | **Close** | No mirroring → no tracking columns |
| #353 — `installAgentFromTemplate` schema mirror (1221 LOC) | **Close** | Schema lives in public catalogs; agents reference, don't clone |
| #357 — POST /api/install | Trim to ~30 lines | Just inserts an agent row in tenant + provisions identity |
| #359 — identity provisioning ($member + wa_jid) | Keep | Orthogonal — identities are real regardless |
| #362 — install manifest | Trim | Drop the env-var slug→bot-phone map; bot phone moves to data on the template entity |

Also revisit #358 (company-aware world model for personal-finance) against this
plan once it lands — its direction is compatible but its details may need to be
re-aligned.

## Long-term primitives

| Primitive | Purpose | Stable? |
| --- | --- | --- |
| `organization` (with `kind` + `visibility`) | Trust boundary | Yes |
| `entities` (typed rows, scoped to one org) | Anything: $member, a company, a tax filing, an agent template, a review | Yes |
| `entity_types` + `entity_relationship_types` | Vocabulary, **data not schema** — templates ship new types as rows, not migrations | Yes |
| `entity_relationships` (typed edges, explicit `source_organization_id` + `target_organization_id`) | All semantic facts, references, forks, reviews | Yes |
| `entity_identities` (namespace + identifier → entity) | Technical lookup keys (auth_user_id, email, wa_jid, uk_utr, uk_ni, companies-house-number) | Yes |

UUIDs everywhere — federation across instances or third-party catalogs becomes
cheap to add later.

## Org topology

- **`tenant`** — user's private space. `visibility=private`. Personal data,
  installed agents, filings, message history.
- **`public_catalog`** — curated public knowledge & published artifacts.
  `visibility=public`. Companies, gov bodies, currencies, tax years, allowance
  definitions, agent templates, skill definitions, reviews.

Three kinds of orgs collapsed to two: there is no `template` org kind. Templates
are entities of type `agent_template` in some public_catalog org, distinguished
by entity type, not org kind.

## Cross-org references

- Direction: tenant → public_catalog only (one-way).
- Read paths never mix scopes: queries either hit the user's org
  (membership-scoped) or public orgs (`visibility=public` filter), never both at
  once. This is what removes the "every read site must remember `OR
  visibility=public`" risk.
- Write-side guard at the application layer: when inserting an
  `entity_relationship`, validate that `target_organization_id` is either the
  same org as the source OR an org with `visibility='public'`. A Postgres
  trigger version of the same check is cheap defense-in-depth if/when needed.
- RLS is **not required** for this model to be safe. It remains a sensible
  defense-in-depth project for later but is decoupled from world-model
  delivery.

## Templates

A template is an entity of type `agent_template`:

- Carries: system prompt, model config, tool list, skill manifest, version,
  bot phone, descriptive metadata.
- References public catalogs it operates over via relationships:
  `uses_catalog` → `public-uk-tax`, `uses_catalog` → `public-uk-finance`.
- Authorship, forks, reviews, ratings: `entity_relationships` (`authored_by`,
  `forked_from`, `reviews`, `rated`).

Installation:

1. Insert agent row in user's tenant org with `template_entity_id`.
2. Provision `$member` if missing (identity provisioning logic from #359).
3. Done. No schema cloning.

When the agent boots, it builds a **schema search path**:

- The user's tenant org (for any custom types the user added).
- The public catalogs declared by the template's `uses_catalog` relationships.

Vocabulary updates propagate automatically — when `public-uk-tax` adds a new
type, all agents reading it pick up the new vocabulary on next boot. Catalog
versioning is explicit at the type level (e.g. `tax_filing@2024-25` and
`tax_filing@2025-26` are separate `entity_types` rows).

## Identity

- One `$member` entity per (org, user). Lazy-created on first meaningful
  interaction in that org, not browse.
- `entity_identities` holds technical IDs against `$member`: `auth_user_id`,
  `email`, `wa_jid`, `phone`, `uk_utr`, `uk_ni`, etc. Each is
  (namespace, identifier) → entity_id.
- Service agents (e.g. a public org's admin agent) get their own identities
  with a `service_agent` namespace so they can be invited into private orgs
  the same way human users are.

`entity_identities` (technical lookup) and `entity_relationships` (semantic
facts) stay as separate tables. Don't conflate.

## Contribution flow

1. User has data in their private org they think the public catalog should
   know about.
2. User notifies the public org's admin agent via the existing chat/messaging
   path: *"FYI I've recorded `<entity>`."*
3. If the admin agent decides it's worth canonicalizing, it requests read
   access.
4. User invites the admin agent into their private org as a `viewer`
   (read-only) or `collaborator` (limited write — for the agent to stamp a
   "synced as `<public_id>`" reference back on the user's entity).
5. Admin's agent reads, decides, writes the canonical entity into the public
   org.
6. User revokes membership when done. Or leaves the agent in for ongoing sync.

What this gives for free:

| Need | Reuses |
| --- | --- |
| Access mechanism | Existing org membership + role |
| Audit trail | Membership invite/revoke events |
| Revocation | DELETE membership |
| Granularity | Org boundary itself (or split a sharing sub-org for narrower control) |
| Trust UX | "Invite person/agent to org" — already familiar from Slack/Drive |

Trade-off: invitation grants whole-org read access, not per-entity. Acceptable —
coarse and explicit beats fine-grained and hidden for trust. Users wanting
narrower control can keep contribution-bound entities in a dedicated sharing
sub-org.

## Use case: tax return

**`public-uk-tax`** (public_catalog) seeds:

- HMRC, the £, tax years (2024-25, 2025-26 …), tax forms (SA100, SA102, SA105,
  SA108), allowance & relief definitions, filing deadlines linked to years.

**`public-uk-finance`** (public_catalog) seeds:

- Major banks, large PAYE-using employers (when known), the FCA, Companies
  House.

**User's tenant org** holds:

- `$member` with identities `auth_user_id`, `email`, `uk_utr`, `uk_ni`.
- One `tax_filing` entity per year. Relationships: `for_tax_year` → public tax
  year, `filed_with` → HMRC, `taxpayer` → `$member`, `includes_form` →
  form-instance entities.
- `income` entities (salary, dividends, interest), each with `source` →
  bank/employer in public-uk-finance.
- `expense` entities, `allowance_claim` entities pointing at public allowance
  definitions.

The agent's job at filing time is a graph walk: from `$member` → `taxpayer` →
filing → income/expense relationships, resolving sources via cross-org
references.

## Use case: agent community

**`public-templates`** (public_catalog) holds one entity per published template
(type `agent_template`):

- Forks: `forked_from` between template entities.
- Versions: either entity-per-version with `next_version` edges, or
  `template_version` child entities. Both fit the graph.
- Authorship: `authored_by` from template → `$member` of the author in some
  org.

**`public-community`** (public_catalog, separate org for policy reasons):

- `review` entities, with `reviews` → template, `authored_by` → `$member`.
- Ratings as entity properties or `rated` relationships with numeric metadata.
- Tags / categories as entities with `tagged` relationships.

Splitting `public-templates` and `public-community` reflects different admin
policies (templates are author-editable; reviews are write-once-by-author)
without inventing new permission machinery.

## Phase 1 — implementation scope

1. Migration: add `kind` + `visibility` columns to `organization`. Add explicit
   `source_organization_id` + `target_organization_id` columns to
   `entity_relationships`.
2. App-level write guard on `entity_relationships` inserts: target must be
   same-org or `visibility='public'`.
3. Seed `public-uk-tax` and `public-uk-finance` orgs with canonical UK
   entities.
4. Slim install endpoint (replaces #357's mirroring): insert agent row in
   tenant + provision `$member` identity.
5. Identity provisioning (keep #359).
6. Search endpoint scoped to `visibility=public` orgs.
7. Update template authoring: templates become entities of type
   `agent_template` in a public catalog with `uses_catalog` relationships.
   Bot phone moves from env to `agent_template` metadata.

## Deferred (with rationale)

| Deferred | Why now isn't the right time | Cheap to add later? |
| --- | --- | --- |
| Postgres RLS | Not required given one-directional refs + scope-local reads. App-level enforcement already in place. | Yes — separate project |
| Claims (verification status machine, evidence refs, expiry, dispute primitives, permissions table) | Not needed for tax return or initial community. Real complexity (per pi: status machine, cardinality per type, dispute states, permission projections). | Yes — additive columns + new permission table |
| Aliases / merges / tombstones for canonical entities | Needed at meaningful catalog scale. Premature now. | Yes — new tables, no existing-row migration |
| Federation (cross-instance entity references) | No multi-instance need yet. UUIDs from day one keep this option open. | Yes |
| Fine-grained per-entity sharing | Whole-org invite is coarser but explicit; serves the immediate need. | Yes — sub-orgs are the escape hatch |

## Long-term invariants worth preserving

1. **Vocabulary-as-data** — adding entity types or relationship types is an
   INSERT, not a migration.
2. **UUIDs everywhere** — keeps federation cheap.
3. **One graph, many orgs** — orgs are trust slices through one universal
   graph.
4. **Cross-org references unidirectional** (tenant → public).
5. **`entity_identities` (technical) ≠ `entity_relationships` (semantic)** —
   keep them separate.

## Implementation arc — finishing the existing work

Status of in-flight PRs and how each lands under the new model.

### Wave 1 — independent, ready to land now

These don't depend on the world-model schema and aren't affected by the
template-cloning rollback. Land in any order.

| PR | Title | Notes |
| --- | --- | --- |
| #352 | personal-org-on-signup | Creates `tenant`-kind org for new users. As-is. |
| #350 | personal-finance example | Pure content under `<example>/agents/personal-finance/`. As-is. |
| #354 | SA100 assembly playbook | Content. As-is. |
| #355 | statement ingestion playbook | Content. As-is. |
| #356 | personal-finance evals | Content. As-is. |
| #348 | multi-org execute MCP tools | Orthogonal scaffolding. As-is. |

### Wave 2 — world-model schema (new branches)

Two small PRs, sequential. Total ~200 LOC including migrations + tests.

| Branch | Scope |
| --- | --- |
| `feat/world-model-orgs` | Add `organization.kind` (`tenant | public_catalog`) + `organization.visibility` (`private | public`). Default existing rows to `tenant`/`private`. |
| `feat/world-model-relations` | Add `entity_relationships.source_organization_id` + `target_organization_id`. Backfill from current implicit scoping. App-level write guard helper rejecting cross-org targets unless target org is `public_catalog`. |

### Wave 3 — public catalog seeding (re-targeted existing work)

The vocabulary already in flight maps cleanly onto public catalogs.

| PR | Re-targeting |
| --- | --- |
| #358 — company-aware world model | Re-target so the personal-finance template **org** becomes a `public_catalog` org (`kind=public_catalog`, `visibility=public`). YAML content lands as `entity_types` rows in that org. No content rewrite needed; only the seed pipeline & org metadata change. |
| #360 — phase 2 schema (FX, allowance windows, filing timeline) | Same treatment. Stacks on #358. |
| `feat/agent-template-entity` (new) | Define the `agent_template` entity type. Seed the personal-finance `agent_template` entity with metadata (system prompt, model, skill list, **bot phone**) and `uses_catalog` relationships pointing at the catalog orgs from #358/#360. |

### Wave 4 — slim install + identity (replacing #357 / #362, keeping #359's helper)

Three PRs, all stacked on Wave 2 + Wave 3.

| Branch | Scope | Replaces |
| --- | --- | --- |
| `feat/slim-install` | `POST /api/install` accepts `{ template_entity_id, whatsapp_phone? }` (or slug → server-resolved to template entity). Inserts agent row in user's tenant with `template_entity_id`. Returns redirect. ~50 LOC. | #357 |
| `feat/identity-provisioning` | Salvage from #359: keep `auth/subject-identities.ts` (the helpers + signup-hook call). Drop the install-routes changes — slim-install owns those. Rebase onto `feat/slim-install`. | trims #359 |
| `feat/install-manifest-data` | `GET /api/install/manifest/:slug` reads from the `agent_template` entity. No env vars. | #362 |

### Wave 5 — landing page

Two-PR ship (per AGENTS.md submodule rule):

1. owletto-web PR (the existing #20 there): update POST body to send
   `template_entity_id`. Land first.
2. Parent submodule-bump PR.

### Cleanup as PRs land

- Close #357 when `feat/slim-install` lands.
- Close #362 when `feat/install-manifest-data` lands.
- Reduce #359 to just the salvageable helper or close + land via
  `feat/identity-provisioning`.
- Delete local worktrees for `feat/install-endpoint` and
  `feat/schema-mirror-install-flow` once detached.

### Parallelism / sequencing summary

```
Wave 1 (any order) ─────── land independently
                             │
Wave 2 ─── orgs ──── relations
                       │
Wave 3 ─── #358 ── #360 ── agent-template-entity
                              │
Wave 4 ─── slim-install ── identity-provisioning
                  │
                  └── install-manifest-data
                              │
Wave 5 ─── owletto-web#20 ── parent bump
```

Wave 1 lands now. Waves 2 and 3 can be developed in parallel by different
agents (different files), as long as 3 lands after 2's columns exist. Wave 4
stacks on both.

### Open questions to resolve before Wave 3

1. **Template org** — does personal-finance live in its own catalog org, in
   `public-uk-tax`, or in a `public-templates` org? Recommendation: own org
   (`public-personal-finance` or `public-templates`) for clean admin policy
   separation. The `agent_template` entity references the *vocabulary* catalogs
   via `uses_catalog`, so co-locating with the vocabulary isn't required.
2. **Seed mechanism** — the existing `<example>/agents/personal-finance/` YAML
   pipeline needs a small adapter so YAMLs become entity_types/entity rows in
   the public catalog org. Currently they get cloned per tenant via
   `installAgentFromTemplate` (now closed). Adapter is straightforward but
   needs to land before #358's content can flow through.
3. **Slug → template_entity_id resolution** — keep slugs in the URL
   (`/install/personal-finance`) but resolve server-side. Slug becomes a
   property on the `agent_template` entity. No env-var map.
