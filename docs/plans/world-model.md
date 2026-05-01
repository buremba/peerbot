# World Model

How knowledge, identity, and templates are organized across tenants and public
catalogs.

## TL;DR

- Public knowledge (HMRC, Barclays, Apple Inc, the £, tax years, …) lives in
  **public_catalog orgs** (`organization.visibility = 'public'`). Real-world
  entities, vocabularies, and templates are entities/types in those orgs.
- Each user gets a **tenant org** on signup (`visibility = 'private'`). Their
  `$member` entity, personal facts, filings, and message history live there.
- One graph: `entities` + `entity_relationships` + `entity_identities` are the
  universal primitives. Orgs are trust slices through that graph.
- Cross-org references flow **one direction only**: tenant → public_catalog.
  Public rows never reference tenant rows.
- Vocabulary (`entity_types`) is referenced by `id`, not by slug, so an entity
  in tenant org A can carry a type defined in public-catalog org B by FK
  alone — no per-row org_id column needed.
- App-level org-scoped queries plus a write-side guard on cross-org
  relationship inserts are sufficient given the one-directional rule. No
  Postgres RLS required.

## Primitives

| Primitive | Purpose |
| --- | --- |
| `organization` (with `visibility`) | Trust boundary |
| `entities` (typed rows, scoped to one org) | Anything: `$member`, a company, a tax filing, an agent template, a review |
| `entity_types` + `entity_relationship_types` | Vocabulary as **data** — new types are INSERTs, not migrations |
| `entity_relationships` (typed edges) | Semantic facts, references, forks, reviews |
| `entity_identities` ((namespace, identifier) → entity) | Technical lookup keys (`auth_user_id`, `email`, `wa_jid`, `uk_utr`, …) |

## Org topology

- **`tenant`** — user's private space (`visibility=private`). Personal data,
  installed agents, filings, message history.
- **`public_catalog`** — curated public knowledge (`visibility=public`).
  Companies, gov bodies, currencies, tax years, allowance definitions, agent
  templates, skills, reviews.

No third org kind. Templates are entities of type `agent_template` *inside* a
public_catalog org, distinguished by entity type, not by a separate org kind.

## Cross-org references

- Direction: tenant → public_catalog only.
- Reads never mix scopes — queries hit either the user's org
  (membership-scoped) or public orgs (`visibility=public` filter), never both
  in the same query. Removes the "every read site must remember `OR
  visibility=public`" risk.
- Write-side guard: when inserting an `entity_relationship`, validate that
  the target's org is either the same as the source or has
  `visibility='public'`. The relationship's organization_id always matches
  the source.
- Lookup of `entity_types` widens at write time via a **schema search path**:
  the agent declares which public catalogs it operates over, and the runtime
  walks [user's tenant org, then each declared catalog] when resolving a
  slug → `entity_type_id`. The resolved id is materialized on the entity row,
  so reads never need the search path.

## Identity

- One `$member` entity per (org, user). Auto-created on signup for the user's
  tenant org; lazy-created on first meaningful interaction in any other org
  they join.
- `entity_identities` holds technical IDs against `$member`: `auth_user_id`,
  `email`, plus connector-side IDs like `wa_jid`, `phone`, `uk_utr`.
- Service agents (e.g. a public org's admin agent) carry their own
  identities under a `service_agent` namespace and can be invited into
  private orgs the same way human users are.

`entity_identities` (technical lookup) and `entity_relationships` (semantic
facts) are separate tables. Don't conflate.

## Templates

A template is an entity of type `agent_template` in a public_catalog org:

- Carries: system prompt, model config, tool list, skill manifest, version,
  bot phone, descriptive metadata.
- Declares which public catalogs it uses via `uses_catalog` relationships
  (e.g. `uses_catalog` → `public-uk-tax`, `uses_catalog` → `public-uk-finance`).
- Authorship, forks, reviews, ratings: ordinary `entity_relationships`
  (`authored_by`, `forked_from`, `reviews`, `rated`).

Installation is a small INSERT into `agents` with `template_entity_id`
pointing at the template entity. No schema cloning — the agent reads
vocabulary from the catalogs declared in `uses_catalog`. Vocabulary updates
propagate automatically; catalog versioning is explicit at the type level
(e.g. `tax_filing@2024-25` and `tax_filing@2025-26` are separate
`entity_types` rows).

## Contribution to public knowledge

1. User has data in their tenant org they think the public catalog should
   know about.
2. User notifies the public org's admin agent via the existing chat path.
3. Admin agent requests read access; user invites it into their tenant org
   as a `viewer` (or `collaborator` if it should stamp a "synced as
   `<public_id>`" reference back).
4. Admin's agent reads, decides, writes the canonical entity into the public
   org.
5. User revokes membership when done.

Reuses existing org membership, role, audit, and revocation primitives. No
draft tables, no contributor role, no moderation queue. Trade-off: invitation
grants whole-org read; users wanting narrower control put contribution-bound
entities in a sharing sub-org.

## Use case: tax return

`public-uk-tax` (public_catalog) holds: HMRC, the £, tax years, SA forms
(SA100, SA102, SA105, SA108), allowance/relief definitions, filing deadlines.

`public-uk-finance` (public_catalog) holds: major banks, large PAYE-using
employers, the FCA, Companies House.

User's tenant org holds:

- `$member` with identities `auth_user_id`, `email`, `uk_utr`, `uk_ni`.
- One `tax_filing` entity per year. Relationships: `for_tax_year` → public
  tax year, `filed_with` → HMRC, `taxpayer` → `$member`,
  `includes_form` → form-instance entities.
- `income` entities with `source` → bank/employer in `public-uk-finance`.
- `expense` and `allowance_claim` entities pointing at public allowance
  definitions.

Filing time is a graph walk from `$member` → `taxpayer` → filing →
income/expense relationships, resolving sources via cross-org references.

## Use case: agent community

`public-templates` (public_catalog) holds one entity per published template
(`agent_template`), with `forked_from`, `next_version`, `authored_by`
relationships.

`public-community` (public_catalog, separate org for policy reasons) holds
`review` entities, ratings, tags. Splitting reflects different admin policies
(templates are author-editable; reviews are write-once-by-author) without
inventing new permission machinery.

## Long-term invariants

1. **Vocabulary as data** — adding entity types or relationship types is an
   INSERT, not a migration.
2. **`entity_types.id` is the type identity, slug is display** — never key
   data on the slug column.
3. **One graph, many orgs** — orgs are trust slices through one universal
   graph.
4. **Cross-org references are unidirectional** (tenant → public).
5. **`entity_identities` (technical) ≠ `entity_relationships` (semantic)** —
   keep them separate.

## Outstanding work

The agent path is complete: tenant agents discover canonical entities via
`search_knowledge`, create entities with public-catalog vocabulary, and link
cross-org. The frontend has org-awareness primitives (`useCurrentOrg`,
`PublicOrgJoinBar`, public orgs in the org dropdown) but doesn't yet exercise
the cross-org features. The work below closes that gap with as little new UX
as possible — every item reuses an existing surface or widens an existing
query.

Ordered by what unblocks usage; skip items if the corresponding use case
doesn't bite yet.

### 1. Schema CRUD cross-org awareness — backend (~80 LOC)

`manage_entity_schema` `action='list'` and `action='get'` are still org-local
in `tools/admin/manage_entity_schema.ts`. Widen the entity-types and
relationship-types lookups with the same pattern as #374's resolver: tenant
first, then `visibility='public'`, ORDER BY tenant-first. Each row in the
response carries `organization_id` + `organization_slug` so callers can
distinguish local from cross-org.

This is the prerequisite for *every* frontend type-picker change below.

### 2. Frontend type pickers show cross-org types (~30 LOC)

The two consumers of the schema CRUD list API:

- `useEntityTypes(orgContext)` — entity creation flow's type dropdown
- `useRelationshipTypes(orgContext)` — relationship-type-rules form

Both already read `manage_entity_schema action='list'` results. Once #1 ships,
the rows will include cross-org types automatically. Frontend-side change is
purely visual:

- Add a small **read-only badge** on rows whose `organization_slug !==
  currentOrgSlug`. Reuses the existing `<Badge>` from
  `@/components/ui/badge`. Group cross-org types under a "From public
  catalogs" subheader in the dropdown.
- For cross-org rows, hide the edit/delete actions and disable the row's
  click-into-edit affordance.

No new components; no new pages. The dropdown's data shape grows by one
field. Same component everywhere.

### 3. Discovery: lean on the existing org dropdown ✅ shipped

A user wanting to *browse* a public catalog already navigates to
`/{public-org-slug}` (e.g. `/market`). The org dropdown returns
public orgs alongside member orgs.

The "Your Organizations" / "Public Organizations" split with a separator
already exists in
`packages/web/src/components/sidebar/organization-dropdown.tsx`
(grouped via `CommandGroup` headings + `CommandSeparator`, gated on
`is_member` / `visibility`). No further work.

For users who want to *find* a canonical entity by name without knowing the
catalog: that's an agent task (`search_knowledge`), not a frontend search.
**Don't add a global search bar** — keeps the UI simple, pushes the
discovery work into the AI tool where it's already strong.

### 4. Read-side cross-org tolerance (~50 LOC)

`manage_entity.get`, `resolve_path`, and the public-pages routes filter by
`e.organization_id = ctx.organizationId`. After #374, a tenant relationship
can have `to_entity_id` pointing at a public-catalog entity — but
`list_links` reaches it via FK join, while a follow-up `get` of that target
fails with "not found" because it isn't in the caller's org.

Same pattern as #377's `fetchEntityById`: widen each read site to
`(e.organization_id = caller OR target_org.visibility='public') AND
e.deleted_at IS NULL`. Operational counts already gated by the CASE-WHEN
shape.

### 5. Visibility-flip safety — deferred until there's a flip path

There is no exposed mutation that lets users (or admins) change
`organization.visibility` today. `tools/organizations.ts` exposes only
`listOrganizations` and `switchOrganization`; visibility is set at org
creation. Item #7 already notes this. Adding a guard on a non-existent
mutation is dead code.

When the admin visibility-control path lands, plug this guard in at the
mutation site:

```sql
SELECT EXISTS (
  SELECT 1
  FROM entity_relationships r
  JOIN entities te ON te.id = r.to_entity_id
  WHERE te.organization_id = $org_being_flipped
)
```

If true on a `public → private` flip, reject with: *"this catalog has
incoming references; remove them or split your data into a new private org
first."* Cleaner than retroactive revalidation, no migration cost.

### 6. Catalog curation pass (data, not code)

Existing public orgs (`market`, `atlas`, `agent-community`, …) hold the
canonical entities. The 4–5-entity verticals (`leadership`, `sales`,
`devops`, …) are likely template seeds, not curated catalogs.

Before recommending these as references in agent prompts, do a one-off
prune. Pure SQL pass against prod (we have direct access). No PR needed —
just a documented changelog of what was removed.

#### 2026-04-28 — consolidation pass

Dropped three orgs that were either duplicates or no longer in scope:

- `venture-capital` — entity content was fully duplicated in `market`
  (companies/investors/funds/products/sectors all matched by name).
  Dropped: org row + 12,504 events + 13 founder watchers + 55 connections
  + 78 feeds + 8,271 runs.
- `careops` (Healthcare) — out of scope; dropped the workspace, agent,
  watchers, connections, and the seed entities (1 patient, 1 appointment,
  1 treatment, 26 members).
- `market-intelligence` — folded into `market`. All 21 brand entities
  matched existing market companies by name, so brands were remapped to
  the company rows; 275,147 events, 9 watchers, 78 connections, 84 feeds,
  9,290 runs, 23 event_classifiers, 10 connector definitions, 2 agents,
  4 auth_profiles, 1 oauth client all moved over via `organization_id`
  rewrite. Entity_ids[] arrays in events/watchers/feeds rewritten via
  the brand→company id map. The 235 MI relationships were exact
  duplicates of existing market `mentions` triples and soft-deleted
  before the org drop.

Followup: events + watchers have no FK to organization, so the org drop
left the rows orphaned and required an explicit cleanup. A separate PR
adds `ON DELETE CASCADE` so future drops are clean.

### 7. `is_catalog` flag on `organization` (~30 LOC + migration)

Pi flagged that `visibility='public'` alone trusts every public org as
canonical, so a tenant who flips their org public could squat on common
slugs (`brand`, `tax_filing`). Today **no normal user code path lets a
regular user mutate `visibility`** — only admins via direct DB or a
yet-unwritten admin API — so this is bounded operationally.

Promote to schema when we add an admin-flippable visibility control, or
when the catalog count grows past ~10. The fix is small: add
`organization.is_catalog boolean DEFAULT false`, change the schema search
path's `OR o.visibility = 'public'` to `OR o.is_catalog = true`.

### 8. `entity_relationship_type_rules` slug → id (~150 LOC + migration)

`entity_relationship_type_rules.source_entity_type_slug` and
`target_entity_type_slug` are text. Cross-catalog vocabulary makes slug
lookup ambiguous. Same conversion shape as #370 (entity_type slug → FK)
applied to this table. Defer until the first cross-catalog rule conflict
shows up — none today.

### 9. Contribution flow — when there's actually content to contribute

The "invite the public-org admin agent into your tenant as a viewer"
pattern (described above) needs:

- A way for the admin agent to declare which entity types it's interested
  in (could be a `requires_review` watcher in the admin's public catalog).
- A small UI nudge in the tenant when the agent posts back "this looks
  canonical, want me to ask the catalog admin to incorporate it?"

No new schema. Build this when the first user actually has data worth
contributing. Until then it's premature.

### 10. TOCTOU on type lookup (deferred indefinitely)

The microsecond window between schema-search-path resolution and INSERT
where a public type could be soft-deleted. Worst case is an entity row
referencing a now-soft-deleted type — recoverable, not corrupting. Pi
flagged twice; we deferred twice. The cleanest fix is a transactional
rewrite of `createEntity`, which is bigger than the bug warrants.

## Deferred (with rationale)

| Deferred | Why later |
| --- | --- |
| Postgres RLS | Not required given one-directional refs + scope-local reads; app-level enforcement is already in place. Add as defense-in-depth when there's an independent reason. |
| Claims (verified `works_at`, `owns_profile_of`, etc., with status machine, evidence refs, expiry, dispute primitives, permissions table) | Not needed for tax return or initial community. Real complexity — bring in when someone needs to claim ownership of a canonical entity. |
| Aliases / merges / tombstones for canonical entities | Needed at meaningful catalog scale. Premature before the first rename hurts. |
| Federation (cross-instance entity references) | No multi-instance need yet. |
| Fine-grained per-entity sharing | Whole-org invite is coarser but explicit. Sub-orgs are the escape hatch when needed. |
