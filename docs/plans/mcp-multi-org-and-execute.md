# MCP multi-org + `execute`/`search`: addendum to the search-execute design doc

Extends `docs/mcp-search-execute-design-doc.md` (owletto proper, status "Planned, not yet implemented") with two scopes the original didn't fully land: (1) cross-org addressing inside `execute`, and (2) the full frontend + UX surface the new tools imply. Language decision: **TypeScript over a typed `ClientSDK` in `isolated-vm`** — reviewed by a second and third opinion (codex, pi), both concurred. Bash-as-primary was evaluated and rejected because reactions are the real workload and shell quoting degrades stored user code.

Target repo for implementation: `packages/server` + `packages/web` in the `lobu` monorepo. The owletto repo is deprecated.

## Decisions locked in

- `execute` runtime: `isolated-vm` V8 isolate (not bash, not node:vm, not subprocess).
- `execute` authoring language: TypeScript compiled via esbuild, same path as today's reaction scripts.
- Cross-org addressing: `client.org(slugOrId)` accessor returning a proxy SDK bound to a re-validated `ToolContext`. No per-tool `org_slug` parameter.
- Access level for `execute`: `write` (member-tier), not `admin`. Per-call `checkToolAccess` on every SDK method is the actual gate.
- `search` + `execute` exposed on **both** scoped (`/mcp/{slug}`) and unscoped (`/mcp`) endpoints. Scoped is the default for Claude/Cursor connectors today.
- `list_organizations` + `switch_organization` exposed on scoped endpoints too. Non-script users and read-tier members still need the serial-hop path. Rename `join_organization` → drop it (semantically it's a switch when the user is already a member, and a no-op entry when they're not).

## Why TypeScript, short version

Bash + a CLI was seriously considered. Rejected on four axes:

1. **Reactions are stored, deferred user code.** Picking bash means stored reactions inherit shell quoting, pipe-failure semantics, `jq` shape drift, CLI version skew, and re-auth overhead — all as part of the durable product surface. Typed TS with TypeBox `Value.Errors` gives the model field-level repair signal.
2. **Multi-org efficiency.** One SDK client holds session context, caches membership, and reuses an auth handshake across N orgs. Bash turns a cross-org walk into N CLI invocations with N auth handshakes and N JSON parses.
3. **Runtime compounding.** Reactions today are TS source compiled by esbuild, stored in DB. `execute` and reactions sharing one SDK + one sandbox collapses two runtimes into one. Splitting them would cost a second sandbox forever.
4. **Agent fluency is an affordance problem.** LLMs write bash more natively than typed SDKs, but LLMs also repair typed errors far faster than shell errors. Solve fluency with tiny authored surface (one global `client`, top-level `await`, plain objects) and `search` returning copy-pasteable signatures — not by changing language.

## Cross-org SDK: the `client.org()` accessor

Today's `ClientSDK` is built once per request with a fixed `toolCtx.organizationId`. The cross-org accessor returns a proxy bound to a fresh `ToolContext`:

```ts
export default async (ctx, client) => {
  const orgs = await client.organizations.list();           // user's memberships + public orgs they can read
  const buremba = orgs.find(o => o.slug === 'buremba');
  if (!buremba) throw new Error('buremba not found');
  const watchers = await client.org(buremba.id).watchers.list({ template: 'reddit' });
  return watchers.filter(w => w.status !== 'active' || w.pending > 0);
};
```

Contract:

- `client.org(slugOrId)` returns `ClientSDK`. Accepts slug or UUID. First call per `(userId, orgId)` tuple verifies membership against `member`; subsequent calls within the same isolate hit an in-process LRU cache keyed by `(userId, orgId)` with a 30s TTL.
- Membership lookup populates `memberRole` (`owner | admin | member`) into the swapped `ToolContext`. Public-visibility orgs the user isn't a member of return a `memberRole: null` context, and the existing `isPublicReadable(toolName, args)` path in `src/auth/tool-access.ts` gates writes.
- Non-member on a private org: `.org()` throws `AccessDenied` synchronously, before any SDK method dispatches.
- `client.organizations.{list, current}` — new SDK namespace. `list` wraps `listOrganizations`; `current` returns the session's default org.
- The `ctx` passed to `execute` scripts carries `organization_id` = the session's default org (pinned URL or last `switch_organization`). `client` with no `.org()` call uses that same default.

Authz invariants preserved:

- Every SDK method still fires `checkToolAccess(toolName, args, ctx)`. The org swap changes `ctx`, never bypasses the check.
- Membership is re-verified on each `.org()` call, not cached across calls for >30s. A script that calls `.org(X).entities.create()` after membership was revoked mid-script fails on the second call.
- Public-workspace scripts (`role: null` on session default) can read but never write, same as today's tool surface.

## `execute` access level: write, not admin

The original design doc says `getRequiredAccessLevel('execute') = 'admin'`. Flip to `write`. Rationale:

- Per-method access checks already exist in the SDK dispatch. A member running `execute` can call any method they could call as a direct tool — composition does not create new authorization.
- An `admin`-only gate on `execute` would force members onto the aggregation-tool path we're explicitly killing. Members either deserve scripted composition or they don't.
- Read-tier sessions (no `mcp:write` scope or no member role) cannot call `execute`; they can still use `search` and the normal public-read tools.
- Entry gate: `execute` requires write-tier access. Admin-only SDK calls still re-check owner/admin role plus `mcp:admin` scope at the delegated handler boundary.

Public-workspace callers (`role: null`) can use `search` and public-read tools but cannot run `execute`. `search` is read-only and available to everyone.

## Scoped-endpoint UX fix: expose org tools everywhere

Drop the "org-switching tools only on /mcp" rule in `src/tools/execute.ts` (`ORG_AGNOSTIC_TOOLS`). Expose `list_organizations` + `switch_organization` on `/mcp/{slug}` too. Reasons:

- On a scoped URL the default org is the pinned one, but nothing is actually at risk by letting the user list memberships or switch mid-session. The pin is ergonomic, not a hard wall.
- Drop `join_organization` entirely. For already-authenticated users on a scoped URL, "join" is a misnomer — they're either already a member (no-op), or not (should fail with a "not a member" error, identical to `switch_organization`'s behavior). One tool, one semantic.

Session-resume behavior (`src/mcp-handler.ts` line 356) still rejects cross-scope recovery (scoped ↔ unscoped mismatch). Unchanged — that's correct.

## Authoring affordances

These make "LLMs write bash more fluently than typed SDKs" a non-concern:

- **Tiny surface in authored scripts.** `export default async (ctx, client) => { ... }`. One `client` global. No imports. Top-level `await` supported via esbuild's `format: 'esm'` wrapper. Plain objects/arrays. No classes, no decorators, no framework ceremony.
- **`search("ns.method")` returns signature + copy-pasteable example.** The design doc already specifies inline TypeBox-derived signatures. Extend each method's metadata with a minimal example literal:

  ```ts
  // Example:
  // const w = await client.watchers.list({ entity_id: 42, status: 'active' });
  ```

  Stored in `src/sandbox/method-metadata.ts` next to the summary/throws annotations.
- **Structured errors keyed for repair.** TypeBox `Value.Errors` surface as:

  ```ts
  { name: 'ValidationError', method: 'watchers.create',
    fields: [{ path: 'extraction_schema', expected: 'object', got: 'string',
               example: { type: 'object', properties: { ... } } }] }
  ```

  The `example` field on validation errors nudges the model to the right shape on retry.
- **Dry-run first-class.** `client.watchers.testReaction` already exists in the design doc. Add `execute` dry-run mode too: `{ script, dry_run: true }` runs under the same write-interception wrapper that reactions use, returning the `would_have` list without committing. Cost is one wrapper branch, same SDK.

## Frontend plan

Two new surfaces in `packages/web`, plus two upgrades.

### New: `/[owner]/tools/execute` — script console

A first-class execute + search page. Inspired by SQL console patterns; no equivalent exists today.

- Monaco editor with TypeScript language mode. Seeded with the standard preamble: `export default async (ctx, client) => {`.
- Inline signature panel on the right — driven by the `search` tool. Search box + namespace tree. Selecting a method injects its example into the editor at cursor.
- Org selector dropdown (top of page) — defaults to session org, switches the default `ctx.organization_id` for the run. Independent of the `client.org()` in-script accessor (which overrides per-call).
- "Dry-run" button (writes intercepted, surfaced as `would_have` list) and "Run" button. Results pane below with structured JSON output, `logs` array, `error` with line/col mapping back to user source.
- Visible run history (last 20 per org) — click to reload a script. Stored per-user in localStorage initially; DB-backed later if needed.

Files:
- `src/app/[owner]/tools/execute/page.tsx` (new route)
- `src/components/tools/execute-console/{editor,signature-panel,results-pane,run-history}.tsx`
- `src/hooks/use-execute.ts` → POSTs `{ script, dry_run, org_slug }` to `/api/mcp/execute` (internal proxy to the backend's MCP `execute` tool).

### New: `/[owner]/settings/organizations` — org membership + invites

Today org CRUD is a dropdown overlay. A dedicated page is needed for cross-org work:

- Tab "Members" — list members of the current org with roles.
- Tab "Invites" — pending `invitation` rows sent to this user's email. Accept/decline.
- Tab "Your Organizations" — flat list of all orgs the user belongs to with direct-link switch.
- Tab "Delete" (owners only).

Files:
- `src/app/[owner]/settings/organizations/page.tsx`
- `src/components/settings/organizations/{members,invites,my-orgs,delete}-tab.tsx`

### Upgrade: watcher reaction editor

Today: plain `<Textarea>` in `src/components/entity-tabs/watchers-tab/from-scratch-panel.tsx:461–466`. No syntax highlighting, no dry-run, no compile feedback until save.

- Replace textarea with Monaco (reusing whatever component the new execute console lands).
- "Test reaction" button — calls `client.watchers.testReaction` against the most recent window, surfaces the `would_have` list + logs inline.
- Inline compile errors (line/col) from esbuild — fire on blur or debounced keystroke.
- Collapsible "Context" card showing the `ctx.extracted_rows` shape for this watcher's extraction_schema.

Files touched:
- `src/components/entity-tabs/watchers-tab/from-scratch-panel.tsx`
- `src/hooks/use-watchers.ts` (`useTestReaction` new hook)

### Upgrade: sidebar org dropdown

Already calls `organization.setActive({ organizationId })`. Two small changes:

- Add a persistent badge for pending invitations (count from `/api/organizations/invites/pending`).
- "Manage organizations" entry at the bottom of the dropdown → `/[owner]/settings/organizations`.

No other frontend pages need to change.

## Edge cases and how each is handled

From a BLOCKER/GUARD/BENIGN survey of the current codebase:

### Cross-org access

- **Non-member on private org via `.org()`** — synchronous throw from the accessor, before SDK dispatch. Already covered by the per-call membership check.
- **Public-visibility org, `memberRole: null`** — accessor returns a read-only SDK. Writes fail at `isPublicReadable` check. Existing handler behavior, no new code.
- **Org hard-delete mid-script** — `member` row disappears, LRU cache invalidated by TTL (≤30s) or by the next dispatch if a write reaches the handler and the row is gone. Reads during the window succeed, consistent with Postgres-level visibility; no stale membership beyond 30s.
- **No soft-delete on `organization` today** (confirmed: `db/schema.sql` has no `deleted_at`). If it's added later, the `organizations.list`/`.org()` path needs the filter too — tracked as a follow-up.
- **Slug vs UUID both accepted** — accessor resolves by length heuristic (`startsWith` UUID regex) + DB lookup. Matches the ergonomic norm of the rest of the API.

### Reactions

- **Stored reaction calls `client.org(X)` after reaction owner lost membership of X** — fires per-call membership check. SDK throws `AccessDenied` inside the isolate; `watcher_reactions` row logs the failure. Reaction run completes with `success: false`, no partial writes to X (because the accessor throws before dispatch).
- **Reaction fires on a watcher whose org was hard-deleted** — upstream `watcher` row is already gone by FK cascade; the reaction never schedules. BENIGN.
- **Dry-run must classify cross-org calls** — the dry-run wrapper wraps the entire `ClientSDK`, so `client.org(X).entities.create(...)` goes through the same interceptor. Classification is method-keyed in `method-metadata.ts`, unaffected by org swap.
- **Public-workspace reactions** — reactions today run with `memberRole: null` and `isAuthenticated: true` (system context). A public-org reaction that tries to write fails at `isPublicReadable`. Unchanged.

### Sandbox limits

- **Large `query_sql` result OOMs the 64MB isolate** — cap `query_sql` result size at 32MB server-side (before handoff). Documented limit; `search("knowledge.search")` example shows pagination.
- **200 SDK call quota hit by a cross-org walk** — document with an example: iterating 30 orgs × 10 method calls = 300, needs batching or summary reads. Error message includes `sdk_calls_remaining: 0` so the model can retry with narrower scope.
- **60s wall-clock timeout on external-call chains** — `operations.execute` counts against wall-clock. Error `{ name: 'TimeoutError', phase: 'external_chain', last_method: 'operations.execute' }` so the model can shorten.
- **Recursive `execute`** — banned statically: `method-metadata.ts` doesn't expose `client.execute`. Tested via a ship-blocking assertion.

### Session and auth

- **Concurrent unscoped sessions with independent switches** — `sessions` Map in `mcp-handler.ts` is sessionId-keyed. Isolated. BENIGN.
- **Session resume after `switch_organization` on unscoped URL** — `persisted.organizationId` is replayed into the recovered session. BENIGN.
- **Session resume with scoped↔unscoped URL mismatch** — already rejects (line 356). Correct.

### Audit

- **50 SDK calls fired by one `execute` get no top-level invocation row** — add `execute_invocations` table:

  ```sql
  CREATE TABLE public.execute_invocation (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id text NOT NULL REFERENCES public.organization(id),
    user_id         text NOT NULL REFERENCES public."user"(id),
    script_hash     text NOT NULL,
    script_source   text,
    status          text NOT NULL,  -- 'success' | 'error' | 'timeout' | 'quota'
    sdk_calls       int  NOT NULL,
    duration_ms     int  NOT NULL,
    error_json      jsonb,
    started_at      timestamptz NOT NULL DEFAULT now()
  );
  ```

  Plus a nullable `execute_invocation_id uuid` column on every change-event table the SDK writes to (already uniform today — single `event` table per the existing schema). The SDK sets the column from `ctx` on every write. Admins can now query "all side effects of invocation X" in one SQL.

- Reactions get their own path already (`watcher_reactions` table). Don't double-log.

## File-by-file changes

### `packages/server`

New:
- `src/sandbox/client-sdk.ts` — `buildClientSDK(toolCtx, env, opts?: { dryRun?: boolean })`. Top-level `org(slugOrId)` accessor returns a proxy SDK with swapped ToolContext after a membership check.
- `src/sandbox/run-script.ts` — shared `isolated-vm` runner.
- `src/sandbox/namespaces/{entities, entitySchema, connections, feeds, authProfiles, operations, watchers, classifiers, viewTemplates, knowledge, organizations}.ts` — per-namespace thin delegations.
- `src/sandbox/method-metadata.ts` — summary, throws, cost, access, **example** per SDK path.
- `src/sandbox/typebox-to-signature.ts` — formatter.
- `src/tools/sdk_search.ts`, `src/tools/sdk_execute.ts`.
- `migrations/YYYYMMDDhhmmss_add_execute_invocation.sql` — new table + FK column on `event`.

Modified:
- `src/tools/registry.ts` — drop `join_organization` registration; add `list_organizations` + `switch_organization` unconditionally (drop `orgSwitching: true` gating, handle both scoped and unscoped); register `search` + `execute`.
- `src/tools/execute.ts` — drop `ORG_AGNOSTIC_TOOLS` scoping restriction. `switch_organization` allowed on scoped endpoints; session mutates default org in place (same code path as today's unscoped handler).
- `src/tools/organizations.ts` — `listOrganizations` surfaces `role` in addition to `is_member`. Drop the old `join_organization` handler entirely.
- `src/auth/tool-access.ts` — `execute: 'write'`; `search: 'read'`. Drop `join_organization`. Per-method check table remains authoritative.
- `src/watchers/reaction-executor.ts` — swap `buildReactionSDK` for `buildClientSDK(reactionCtx, env)`. `runScript({ entryPoint: 'react', ... })` shared with `execute`.
- `src/mcp-handler.ts` — `includeOrgSwitching` gating removed (always true).

Deleted:
- `src/tools/admin/` MCP registrations for the 14 `manage_*` tools — handlers stay, MCP-surface entries go.
- `src/tools/admin/index.ts` after `query_sql` registration moves.

### `packages/web`

New:
- `src/app/[owner]/tools/execute/page.tsx`
- `src/components/tools/execute-console/{editor, signature-panel, results-pane, run-history}.tsx`
- `src/app/[owner]/settings/organizations/page.tsx`
- `src/components/settings/organizations/{members, invites, my-orgs, delete}-tab.tsx`
- `src/hooks/{use-execute, use-invitations}.ts`

Modified:
- `src/components/entity-tabs/watchers-tab/from-scratch-panel.tsx` — Monaco + test-reaction button.
- `src/hooks/use-watchers.ts` — `useTestReaction` hook.
- `src/components/sidebar/organization-dropdown.tsx` — pending-invites badge + "Manage organizations" link.

## PR plan

Five PRs, landable in order. Each is independently mergeable; later PRs stack only if an earlier one hasn't landed.

### PR-1: SDK + sandbox scaffolding, no new MCP tools yet

Scope:
- `src/sandbox/{run-script, client-sdk, method-metadata, typebox-to-signature}.ts`
- Per-namespace delegations (most thin wrappers; `organizations` and `watchers` have real logic).
- `client.org()` accessor with membership check + LRU cache.
- Add `isolated-vm` dep; verify the Node runtime can load its native addon on the target host.

Validation:
- Unit tests: `client-sdk.test.ts` covers `org()` accessor (slug, UUID, non-member throw, public-workspace read-only, revocation mid-script).
- Sandbox smoke test: trivial script `return 1 + 1` runs to completion under 50ms cold.

### PR-2: `search` + `execute` MCP tools, drop `admin` gating

Scope:
- `src/tools/{sdk_search, sdk_execute}.ts` — register in `src/tools/registry.ts`.
- `src/auth/tool-access.ts` — `execute: 'write'`, `search: 'read'`.
- Drop the 14 `manage_*` tool registrations from MCP surface (handlers preserved).
- Execute dry-run mode plumbing.

Validation:
- Integration tests: 17 scenarios from the original design doc's `## Verification` section, plus:
  - Cross-org read in `execute` by a write-tier member.
  - Cross-org write by a member of the second org.
  - Cross-org write rejected for non-member.
  - Read-tier session runs read-only script successfully; write attempt fails mid-execution with typed error.
- Migration: ~20 integration tests that call `executeTool('manage_*', { action, ... })` rewrite to call handlers directly.

### PR-3: audit trail — `execute_invocation` table + event linkage

Scope:
- Migration: new table + nullable `execute_invocation_id` FK on `event`.
- `execute` handler writes the invocation row pre-run; SDK writes the FK into every change-event.
- Admin SQL examples in docs.

Validation:
- Integration test: script creating 3 entities + 1 watcher → `SELECT * FROM event WHERE execute_invocation_id = $1` returns 4 rows.

### PR-4: scoped-endpoint UX fix

Scope:
- Expose `list_organizations` + `switch_organization` on `/mcp/{slug}`.
- Drop `join_organization` entirely.
- Update `src/utils/workspace-instructions.ts` preamble.

Validation:
- Integration test: scoped session calls `switch_organization`, next tool call runs against the new org.
- MCP client config verified on Claude Desktop and Codex after the rename.

### PR-5: frontend — execute console + settings + reaction editor upgrade

Scope:
- New routes + components listed above.
- `useExecute` posts through the existing `/api/mcp/*` proxy.
- Monaco upgrade on the reaction editor.
- Sidebar pending-invite badge.

Validation:
- Manual QA: create a 3-line script, run, verify result. Run dry-run, verify `would_have` list. Switch orgs via selector, re-run. Open a watcher, hit "Test reaction", verify inline logs.

## Risks and gotchas

- **`isolated-vm` native build.** Node version pin, `python3` + `build-essential` when a prebuild is unavailable. Half-day risk on hosts without a matching prebuild; verify before deep work.
- **Existing reaction scripts in DB.** Stored scripts target the legacy `ReactionSDK` shape (`actions.execute`, `content.save`, `notify`, `query(sql, params)`, `react(ctx, sdk)` export). The new `ClientSDK` is a different surface — namespace renames (`content.save` → `knowledge.save`, `actions.execute` → `operations.execute`), object-shaped args instead of positional, no `notify` primitive, and the entry point is `default async (ctx, client, params?)`. Old scripts will not transparently keep working — they must be rewritten and recompiled. Migration ran in PR #348 against `watchers.reaction_script` / `reaction_script_compiled`; backup table `_reactions_backup_2026_04_25` holds originals for rollback. Audit query: `SELECT COUNT(*) FROM watchers WHERE reaction_script ~ 'export\s+async\s+function\s+react\s*\(' OR reaction_script ~ 'sdk\.(notify|content|actions)';` returns 0 post-migration.
- **Dry-run write classification misses a handler.** If a new method is added without metadata, dry-run might treat it as a read and mutate prod. Ship-blocking test: `method-metadata.ts` must cover every public SDK path; CI fails if not.
- **Async SDK bridge leaks.** `isolated-vm` `Reference.apply` patterns have known footguns (un-disposed references, leaked promises). Budget unit-test time here up front.
- **Token budgets of `search`.** A namespace listing in a crowded namespace (watchers has ~15 methods) can still run ~500 tokens. Document a `depth` param later if needed.
- **Frontend bundle size from Monaco.** ~2MB gzipped. Lazy-load the editor behind a dynamic import; never ship it on non-console pages.

## Critical files

Backend:
- `src/tools/execute.ts` (lines 30–82, 145–165)
- `src/tools/registry.ts` (lines 130–165)
- `src/tools/organizations.ts` (the whole file)
- `src/mcp-handler.ts` (lines 100–170, 350–360)
- `src/auth/tool-access.ts`
- `src/watchers/reaction-executor.ts`
- `db/schema.sql` (additions for `execute_invocation` + FK on `event`)

Frontend:
- `src/components/sidebar/organization-dropdown.tsx`
- `src/components/entity-tabs/watchers-tab/from-scratch-panel.tsx` (lines 461–466)
- `src/hooks/{use-org-context, use-watchers}.ts`
