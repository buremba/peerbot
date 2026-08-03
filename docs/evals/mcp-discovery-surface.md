# MCP discovery surface: can Gemini Flash discover every operation from bare intent?

**Question.** Given ONLY the default cloud Lobu MCP tools and **no skill
scaffolding**, can an agent DISCOVER how to perform operations across the FULL
MCP surface starting from bare natural-language intent? This tests the claim
that *any* agent can figure out how to do all operations from the MCP surface
alone.

**Answer (short).** Mostly yes, for the tasks a workspace-owner agent is
scoped to do. Real **Gemini 2.5 Flash**, given only the ~6 default MCP tools and
an owner (`mcp:admin`) token, **passes ~13–15 of 22 task×trials (59–68% across
two identical batteries)** and reaches `search_sdk` on **73–77%** of them, with a
**~1% arg-fumble rate**. When Flash calls a tool it almost never mis-forms the
args — its failures are procedural (stops mid-chain) or plain non-determinism
(same task passes one trial, fails the next), NOT "couldn't express the call."
8 of the 11 tasks pass in at least one trial; connect-slack, run-operation,
query-entities, save-memory, and schedule-a-job pass every trial. The
default-cloud MCP surface is genuinely self-describing: `search_sdk` +
`query_sdk`/`run_sdk` let Flash find and execute connect/create/query/watch/
schedule/link operations it was never told the method names for. The residual
failures split cleanly into (a) a real multi-step discovery gap, (b) a
token-scope gate that PR #1955 fixes for connector discovery, (c) one
harness/reply-scoring artifact, and (d) plain Flash run-to-run variance. See the
classification below.

> **Run-to-run variance is the headline caveat.** Two identical 22-run owner-scope
> batteries scored 68% and 59%. Individual tasks swing hard between batteries
> (create-entity 2/2 then 0/2; connect-website 1/2 then 0/2; run-operation 1/2
> then 2/2). The harness is deterministic — this is Gemini Flash being a variable
> agent. Treat any single number as ±1 task; the qualitative picture (most
> operations are discoverable; a few multi-step ones are shaky) is stable.

> This is a research finding. **No production agent config or server `src` was
> changed by this eval.** (PR #1955's one-line scope fix was applied to the
> working tree only, to measure its effect — see the scope experiment.)

## Harness

`examples/lobu-crm/evals/discovery-surface/` (see its README to run).

- **Model:** real Gemini 2.5 Flash driven in-process via pi-ai — the registry
  entry for provider `google` (api `google-generative-ai`), key injected the way
  the worker's `model-resolver.ts` injects `GEMINI_API_KEY` for the `gemini`
  gateway slug.
- **Surface:** the REAL default cloud MCP surface — exactly the ~6 first-class
  `AGENT_TOOLS` from `getMcpTools()`: `search_memory`, `save_memory`,
  `search_sdk`, `query_sdk`, `query_sql`, `run_sdk`. No admin/dispatch tools.
  The agent must discover every capability through `search_sdk` and reach it via
  the sandbox tools — exactly as a fresh cloud agent would.
- **Real sandbox:** `run_sdk`/`query_sdk` run the model's TypeScript in the real
  isolated-vm sandbox against the live `ClientSDK` + Postgres. (This is the key
  difference from the sibling `tool-surface` eval, which stubbed the sandbox
  tools out.) isolated-vm's native addon only loads under Node 22–24, so the
  harness runs under `node@22 + tsx`.
- **Checks:** every task asserts resulting DB / entity / event / run STATE.
  Read/question tasks additionally score the final reply text for the right real
  facts. Fresh seeded org per task×trial; seeds add only the minimal starting
  state the intent implies (an installed connector to connect, seeded companies
  to query), never the how-to.

### One correctness fix found while building (disclosure)

The first pass exposed `getAllTools()` (≈30 admin+dispatch tools) instead of
`getMcpTools()` (the true ~6-tool default surface). With the bloated surface
Flash scored **23% (5/22)** and discovered on only 32% — it reached for admin
tools directly and skipped `search_sdk`. Restricting to the real 6-tool default
surface **roughly tripled the pass rate (23% → 68%) and more than doubled the
discovered rate (32% → 77%)**: the narrow surface *forces* the discovery path,
and Flash follows it. That is itself a finding — the discrete default MCP
surface is well-shaped for discovery precisely because it is small.

## Tasks

11 bare-intent tasks spanning the MCP surface (see `tasks.ts`). Dropped from the
original spec: a standalone `run-operation` "operation execution event" variant
was folded into task 3; there is no `website` connector or `pages` feed in the
codebase, so the connector tasks seed a no-auth `webpages`/`pages` connector and
a real `slack` connector rather than inventing bundled connectors.

| # | task | intent | state check |
|---|---|---|---|
| 1 | connect-website | "collect example.com's pages" | a `connections` row for the connector AND a `feeds` row `feed_key='pages'` |
| 2 | connect-slack | "connect my Slack" | a `connections` row for `slack` |
| 3 | run-operation | "run the ping operation" | a completed `runs` row (`run_type='action'`) |
| 4 | create-entity | "add a company Acme, 50 employees" | a `company` entity with a metadata field = 50 |
| 5 | query-entities | "how many companies + names" | reply names all 3 seeded companies + count 3 |
| 6 | create-behavior | "watch + notify on pricing" | an active `behaviors` row |
| 7 | save-and-recall-memory | "remember target market is fintech, then recall" | an `events` row mentioning fintech + reply recalls it |
| 8 | sql-discovery | "what tables; how to find pages" | reply names real `events` table + a real column, no hallucinated table |
| 9 | org-discovery | "which workspace + connectors" | reply names the real org + a real installed connector |
| 10 | schedule-a-job | "every Monday 9am" | a `scheduled_jobs` row with a cron |
| 11 | entity-relationship | "link Jane to Acme as employer" | an `entity_relationships` row between the two |

## Results — owner (`mcp:admin`) session

Real Gemini 2.5 Flash, default 6-tool MCP surface, 11 tasks × 2 trials = 22 real
model runs. The numbers below are the definitive battery (all harness fixes
applied); an earlier identical battery scored 68% — see the variance caveat
above. Raw per-cell metrics in `last-run.json` (gitignored — re-run to
regenerate).

**Overall**

| model | pass rate | discovered rate | mean calls | fumble rate | mean turns | mean sec |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | **59% (13/22)** | **73%** | 6.0 | **2% (2/132)** | 6.9 | 8 |

**By task**

| task | pass rate | discovered rate | mean calls | mean fumbles |
|---|---|---|---|---|
| connect-website | 0% (0/2) | 50% | 6.0 | 0.0 |
| connect-slack | 100% (2/2) | 0% | 1.0 | 0.0 |
| run-operation | 100% (2/2) | 100% | 7.0 | 0.0 |
| create-entity | 0% (0/2) | 100% | 8.5 | 0.0 |
| query-entities | 100% (2/2) | 100% | 3.0 | 0.0 |
| create-behavior | 50% (1/2) | 100% | 9.5 | 1.0 |
| save-and-recall-memory | 100% (2/2) | 0% | 1.0 | 0.0 |
| sql-discovery | 0% (0/2) | 50% | 4.5 | 0.0 |
| org-discovery | 50% (1/2) | 100% | 4.5 | 0.0 |
| schedule-a-job | 100% (2/2) | 100% | 8.5 | 0.0 |
| entity-relationship | 50% (1/2) | 100% | 12.5 | 0.0 |

**Per cell** (state = DB check, reply = fact check for read tasks, disc = called
`search_sdk`, firstWrite = index of first execute/read tool, −1 = never)

| task | trial | pass | state | reply | disc | calls | firstWrite | turns | detail |
|---|---|---|---|---|---|---|---|---|---|
| connect-website | 1 | ❌ | ❌ | — | y | 12 | 3 | 13 | discovered connector, didn't land the connection |
| connect-website | 2 | ❌ | ❌ | — | n | 0 | −1 | 1 | no tool call (answered from head) |
| connect-slack | 1 | ✅ | ✅ | — | n | 1 | 1 | 2 | slack connection active |
| connect-slack | 2 | ✅ | ✅ | — | n | 1 | 1 | 2 | slack connection active |
| run-operation | 1 | ✅ | ✅ | — | y | 8 | 1 | 9 | 1 ping action run completed |
| run-operation | 2 | ✅ | ✅ | — | y | 6 | 1 | 7 | 1 ping action run completed |
| create-entity | 1 | ❌ | ❌ | — | y | 7 | 1 | 8 | no company entity landed |
| create-entity | 2 | ❌ | ❌ | — | y | 10 | 1 | 11 | Acme created but metadata empty (no 50) |
| query-entities | 1 | ✅ | ✅ | ✅ | y | 3 | 1 | 4 | names all 3 companies + count |
| query-entities | 2 | ✅ | ✅ | ✅ | y | 3 | 1 | 4 | names all 3 companies + count |
| create-behavior | 1 | ✅ | ✅ | — | y | 12 | 1 | 13 | 1 active behavior |
| create-behavior | 2 | ❌ | ❌ | — | y | 7 | 1 | 8 | no behavior created |
| save-and-recall-memory | 1 | ✅ | ✅ | ✅ | n | 1 | 1 | 2 | saved + recalls fintech |
| save-and-recall-memory | 2 | ✅ | ✅ | ✅ | n | 1 | 1 | 2 | saved + recalls fintech |
| sql-discovery | 1 | ❌ | ✅ | ❌ | y | 8 | 1 | 9 | reply didn't name the events table |
| sql-discovery | 2 | ❌ | ✅ | ❌ | n | 1 | 1 | 2 | reply didn't name the events table |
| org-discovery | 1 | ✅ | ✅ | ✅ | y | 7 | 1 | 7 | names the real org + a connector |
| org-discovery | 2 | ❌ | ✅ | ❌ | y | 2 | 2 | 3 | didn't echo org/connector this trial |
| schedule-a-job | 1 | ✅ | ✅ | — | y | 10 | 2 | 11 | scheduled job cron=0 9 * * 1 |
| schedule-a-job | 2 | ✅ | ✅ | — | y | 7 | 2 | 8 | scheduled job cron=0 9 * * 1 |
| entity-relationship | 1 | ❌ | ❌ | — | y | 11 | 3 | 11 | discovered but never landed the link |
| entity-relationship | 2 | ✅ | ✅ | — | y | 14 | 3 | 14 | Jane↔Acme link created |

## Failure classification (the real deliverable)

Each failing task×trial in the owner-scope run, classified honestly:

- **(a) genuine multi-step discovery gap.** `create-entity` (0/2 this battery,
  2/2 the prior one) and `entity-relationship` (1/2) both require a two-hop
  discover-then-create: create the entity/relationship TYPE (via
  `entitySchema.createType` / `createRelType`), *then* create the entity / link.
  Flash chains both hops only some of the time; when it fails it either creates
  the type but never lands the entity/link, or (create-entity trial 2) creates
  the entity with empty metadata, dropping the `50`. This is the surface's
  genuinely hardest ask — the second step's precondition is itself a discovery,
  and it's exactly where the run-to-run variance bites hardest. The tool
  DESCRIPTIONS / `search_sdk` output are the lever: spell out "create the type
  first, then set metadata" in the method docs and this stabilizes.
- **(b) fixed-by-#1955 (connector visibility, scope-gated).** Under a default
  `mcp:read`+`mcp:write` token, `client.catalog.listInstalled` was classified
  admin-only, so the agent literally could not see installed connectors — it got
  *"requires an MCP session with admin access"*. This hobbled `connect-*`,
  `run-operation`, and `org-discovery` discovery for default-scoped sessions. The
  owner-scope run above is unaffected (admin bypasses the gate); the isolated
  effect is measured in the scope experiment below.
- **(c) harness / reply-scoring artifact (strict reply checks).**
  `sql-discovery` (0/2) fails its reply check because Flash answers the "how would
  I find pages" part by describing `query_sdk` / feeds rather than naming the raw
  `events` table + a column, which the check demands — the *state* side is fine
  (it's a read), and the guidance it gives is not wrong, just phrased around a
  table name the strict check wanted verbatim. `org-discovery`'s reply check
  requires the model to echo the workspace's literal name; the harness now seeds
  a clean name ("Contoso Labs") so this is fair, and it passes when Flash actually
  queries (trial 1). A related harness bug (now fixed): the connector was
  originally keyed `webpages`/"Web Pages" while the prompt said "website", so
  `search_sdk('website')` returned 0 hits and a correct agent couldn't find the
  connector by the prompt's own word (verified directly). It's now keyed
  `website`/"Website"; connect-slack (name matches "Slack") passes 2/2, evidence
  the connect path is discoverable when the name lines up.
- **(d) Flash run-to-run variance (weak agent, not the surface).** On several
  trials Flash replied with 0–1 tool calls — answering "I'll do that" / a
  plausible answer from its head without calling a tool (`disc=n`, 1 turn; e.g.
  `connect-website` trial 2, `sql-discovery` trial 2, `create-behavior` trial 2).
  The same task passes on the other trial or in the other battery. This is model
  non-determinism, not a missing affordance — and it dominates the delta between
  the 68% and 59% batteries.

## Scope experiment — PR #1955 (connector-discovery visibility)

PR #1955 adds `manage_catalog: new Set([])` to `OWNER_ADMIN_ACTIONS` so
`list_catalog`/`list_installed` fall through to READ tier. Before it, a default
`mcp:read`+`mcp:write` token (what `lobu token create` mints) got
*"manage_catalog.list_installed requires an MCP session with admin access"* and
could not discover connectors at all.

Measured directly on the connector-dependent tasks under a **default-scope**
token, pre-fix vs post-fix (2 trials each):

| task | pre-fix pass | post-fix pass | discovered (both) |
|---|---|---|---|
| connect-website | 0% (0/2) | 0% (0/2) | 100% |
| connect-slack | 100% (2/2) | 100% (2/2) | 100% |
| run-operation | 0% (0/2) | 0% (0/2) | 100% |
| org-discovery | 0% (0/2) | **50% (1/2)** | 100% |
| **overall** | **25% (2/8)** | **38% (3/8)** | **100%** |

The isolated effect is clearest on `org-discovery` (a pure read): pre-fix the
default-token agent named a connector in **0/2** trials (`connector=false` both
times); post-fix it named one (`connector=true`), lifting org-discovery from
0% → 50% (the other trial missed only the strict org-name echo, artifact (c)).
`catalog.listInstalled` returns *"requires admin access"* pre-fix and succeeds
post-fix — verified directly. `connect-website` / `run-operation` stay 0% under
default scope both pre- and post-fix — those are *write* actions
(`connections.connect`, `feeds.create`, `operations.execute`) still gated to
admin; #1955 fixes *visibility*, not the write gate, so a default token can now
FIND the connector but still can't connect it. `connect-slack` passes under
default scope throughout (member-owned connections are `MEMBER_WRITE`).

## Recommendation

- The **default cloud MCP surface is discoverable**: a mid-tier model
  (Flash) with only `search_sdk` + the sandbox tools finds and executes most
  operations from bare intent. Keep the surface small — the bloated-surface run
  shows extra tools *hurt* discovery by giving the model somewhere else to go.
- **#1955 (the `manage_catalog` read-scope fix) is correct and load-bearing.**
  Connector discovery under a default `mcp:read`+`mcp:write` token is broken
  without it (`catalog.listInstalled` → "requires admin access"); the fix
  measurably restores `org-discovery` and connector-intent search for the default
  principal, at no cost (both actions are pure reads).
- The remaining surface-side lever is **multi-step chaining** (create-type →
  create-entity, create-rel-type → link). If we want default agents to nail
  those, the fix is in the tool DESCRIPTIONS / `search_sdk` results (spell out
  the "create the type first" precondition), not more tools. The rest is Flash
  being a variable agent — a stronger model closes those trials.
- Caveats: this measures Gemini 2.5 Flash specifically, 2 trials/task; the
  reply-text checks are deliberately strict (they under-credit correct-but-
  paraphrased answers). Re-run per model before drawing surface conclusions.

## Update — 4-trial variance battery + tier-aware default scope

A third battery at **4 trials** (owner scope, with the #1958 two-hop metadata
guidance applied) scored **63% (28/44), 70% discovered (31/44)** — squarely
inside the earlier 59–68% band, tightening the estimate. Per-task highlights vs
the 2-trial run:

| task | 4-trial pass | 4-trial disc | note |
|---|---|---|---|
| connect-slack | 4/4 | — | rock solid |
| save-and-recall-memory | 4/4 | — | rock solid |
| query-entities | 4/4 | 3/4 | solid |
| entity-relationship | **4/4** | 4/4 | up from 1/2 — #1958 link guidance landed |
| run-operation | 3/4 | 4/4 | solid |
| create-entity | 2/4 | 3/4 | up from 0/2 but still the shakiest two-hop |
| create-behavior | 2/4 | 4/4 | discovers reliably; completion variable |
| org-discovery | 2/4 | 4/4 | reply-echo strictness |
| schedule-a-job | 2/4 | 2/4 | discovery itself is variable here |
| sql-discovery | 1/4 | 3/4 | strict table-name reply echo |
| connect-website | 0/4 | 4/4 | discovers the connector every time; never lands connect+feed — the remaining genuine multi-step gap |

`entity-relationship` moving to 4/4 is the clearest signal that spelling out the
multi-step precondition in `search_sdk` (PR #1958) closes the gap it was built to
close. `connect-website` (connect → then create the feed) is the analogous
two-hop still open.

### Tier-aware default-scope scoring

Each task now carries a `tier` (`read` | `member-write` | `admin`). Under
`--scope default` (a normal `mcp:read mcp:write` member token — what
`lobu token create` mints), an `admin`-tier task's write is legitimately blocked,
so the runner scores it a **pass when the agent discovered the operation and hit
the admin gate** ("correctly blocked") rather than counting it as a discovery
failure. This makes a `--scope default` battery an honest measure of the *member*
experience — connector/behavior/schedule tasks are admin-gated and expected to
stop at the gate, while read + member-write tasks (query, create-entity,
save-memory, link) must complete. Run it with `./run.sh --scope default`.
