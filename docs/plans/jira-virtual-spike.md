# Jira virtual-feed spike — decision matrix

> **Date:** 2026-07-29
> **Branch:** `feat/jira-virtual-feed`
> **Status:** Spike complete (offline + code-path measurement). Live Atlassian verification remains outstanding.

## Goal

Answer: for customer-issue workflows, can Lobu match **Claude/Atlassian Rovo MCP–quality live Q&A**, and what **extra** do we need for Lobu-only Automations/entities — without Glean-scale crawling?

## Competitor models (measured from public docs + our authz RFC)

### A) Live per-user — Claude / ChatGPT / Cursor + Atlassian Rovo MCP

Source: [Atlassian Rovo MCP](https://github.com/atlassian/atlassian-mcp-server), [Supported tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/).

| Layer | Automation |
| --- | --- |
| Auth | OAuth 2.1 or API token **as the human user** |
| Reads | Live tools: `searchJiraIssuesUsingJql`, `getJiraIssue`, projects, transitions meta |
| Writes | `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addCommentToJiraIssue`, worklogs |
| Search | Classic JQL + beta `searchAtlassian` (Rovo NL) |
| Corpus | No Lobu-side copy — source of truth stays Atlassian |
| Automation | Session / client-bound — no multi-user org Automation plane |
| Permissions | Source-enforced (user token) |

### B) Index + ACL — Glean / Copilot Graph / Rovo Search

| Layer | Automation |
| --- | --- |
| Auth | Admin crawl + SSO identity (Glean/Copilot); native site ACLs (Rovo Search) |
| Reads | Index (BM25 + KNN / semantic), not pure live JQL every time |
| Corpus | Yes — continuous index |
| Permissions | ACL on documents + identity link |
| Automation | Platform agents on graph/events |

### C) Lobu (this branch)

| Layer | Automation |
| --- | --- |
| Auth | Connection OAuth (`read:jira-work`, user, webhook) — **connection principal**, not per-chat-user by default |
| Reads | Virtual feed: `query()` / `search()` → `/search/jql` (implemented in this branch) |
| Writes | **None** (no `actions`, no `write:` scopes) |
| Corpus | Optional collected feed; virtual default = no issue copy |
| Signals | App-webhook **raw** land for Jira/Linear (not GitHub structured store/trigger) |
| Automation | Automations on events + entities — Lobu differentiator **if** signals are usable |

## Scenario matrix (S1–S10)

| # | Scenario | Claude MCP | Glean / Rovo Search | Lobu virtual (now) | Lobu collected | Spike evidence |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Structured ops JQL (“open P1s in SUPP”) | **Yes** | Yes (index lag) | **Yes** | Yes (stale) | Query/search JQL construction + unit pushdown |
| S2 | Restricted project — wrong user must not see | **Yes** (user token) | Yes (ACL index) | **Gap** — sees what **connection** token sees | Same | Auth design; no per-request user token on virtual path |
| S3 | Semantic “auth timeouts last month” | Partial (NL beta / text) | **Yes** | Keyword `text ~` only | Yes if embedded | `search()` AND-composes `text ~`, not embeddings |
| S4 | Comment-heavy thread summarize | **Yes** (`getJiraIssue`) | Yes | **Gap** — description only in row | Thin / raw webhook | Connector `ISSUE_FIELDS` excludes comments |
| S5 | Custom field “Customer tier” | **Yes** | If indexed | **Gap** until `ISSUE_FIELDS` extended | Same | No `customfield_*` in request |
| S6 | Status change while watching | No (no org push) | Index refresh | **Raw webhook only** | Sync + raw | Gateway: Jira falls through to raw store (`app-webhooks.ts`) |
| S7 | Offline Automation: Escalated → Slack + entity | **No** | Platform agents | **Possible** if webhook → Automation + entity | Stronger if events match | Product design; not e2e proven |
| S8 | 20 concurrent live reads | Per-user API limits | Index absorbs | **Every read hits Jira** | Poll budget | Architecture; not load-tested |
| S9 | Transition / comment with approval | **Yes** | Varies | **No** | **No** | Connector has no actions or write scopes |
| S10 | Answer during Jira outage | No | Stale index | **No** | Stale events | By design of virtual |

### Verdict bands

| Band | Scenarios | Implication |
| --- | --- | --- |
| **Parity with Claude on reads** | S1 | Ship virtual as default for “current state” Q&A |
| **Claude still wins** | S2, S4, S5, S9 | Need user principal, richer get-issue, write actions |
| **Lobu can win** | S7 | Only if webhook → structured Automation path is built |
| **Hybrid required** | S3, S6, S10 | Narrow collected and/or entities for memory + push |

## Connector auth / tenant survey

| Connector | Auth | Tenant identity | Needs post-OAuth site discovery? |
| --- | --- | --- | --- |
| github | app_install + oauth + env | `installation_id` via app install | No |
| slack | app_install + OIDC login | `team_id` via install callback | No |
| linear | oauth | Token-scoped GraphQL fixed host | No |
| google_gmail / calendar / youtube | oauth | User-scoped Google APIs | No |
| microsoft_outlook | oauth | User-scoped Graph | No |
| reddit | oauth | User-scoped | No |
| **jira** | **oauth 3LO** | **`cloud_id` (Atlassian Cloud site)** | **Yes — unique site required** |
| postgres / rss / hn / webhook / … | env / none | N/A | No |

GitHub/Slack put tenant on `app_installations.external_tenant_id`. Jira 3LO tokens
are site-agnostic until `/oauth/token/accessible-resources` returns cloud ids.

### Platform fix (this branch)

1. OAuth callback → `resolveJiraCloudSite(accessToken)` → for a single-site
   grant, stamp `connection.config.cloud_id|site_url|site_name` +
   `external_tenant_id`. Multi-site grants require an explicit `cloud_id`.
2. `readVirtualFeed` / `runConnectorQuery` merge `connection.config` the same way
   `feed-sync` and worker poll already do (`mergeExecutionConfig`).
3. Connector lazy-fallback: if `cloud_id` still missing at runtime, call
   accessible-resources with the live token (covers pre-fix connections).

## Code-path findings (this repo)

### Virtual read path — **real**

```text
manage_feeds / query_sql({feed}) / search_memory(recall)
  → readVirtualFeed (connection.config + feed.config merged; config.query as JQL)
  → connector query() | search()
  → GET /rest/api/3/search/jql
  → rows (no events)
```

- Feed definition: `issues.virtual: true` (default on create when schema says so).
- `search()` → `(baseJql) AND (text ~ "t1" AND text ~ "t2")`.
- No `total` (cursor API) — same class of limitation as Gmail virtual.

### Webhook path for Jira — **raw, not GitHub-store**

From `app-webhooks.ts`:

- Providers **with** `onDelivery` (GitHub) → trigger poll or structured store.
- Providers **without** (Jira/Linear) → **raw body** into events as
  `connector_key = webhook:app_install:<id>`, dedupe by **body hash**.

Implications:

1. Declaring `feeds.issues.webhook.mode = 'store'` does **not** run GitHub’s `storeGithubWebhookEvent` path.
2. Automations cannot reliably key on `origin_id = jira_issue_<id>` from webhooks today (body-hash origin).
3. Virtual feed never polls, so **trigger-mode** would be useless even if wired — Jira needs a **structured store** lander or Automation signals from raw payload parse.

### Writes — **missing vs Rovo MCP**

| Rovo MCP tool | Lobu Jira connector |
| --- | --- |
| `searchJiraIssuesUsingJql` | ≈ `query()` / virtual feed |
| `getJiraIssue` | partial (row projection, not full issue) |
| `getTransitionsForJiraIssue` | no |
| `transitionJiraIssue` | no |
| `addCommentToJiraIssue` | no |
| `createJiraIssue` / `editJiraIssue` | no |
| `searchAtlassian` (NL) | no (unless Lobu embeddings on collected) |

## Recommended architecture (post-spike)

```text
READS     → virtual issues feed (JQL) + prefer per-user token for multi-tenant
GET ONE   → future action/query getIssue (full fields + comments) on demand
SIGNALS   → structured webhook lander (issue key, status, origin_id) → Automations
MEMORY    → sparse entities (escalation/customer), NOT full issue history default
OPTIONAL  → narrow collected JQL only when semantic history is required
WRITES    → actions + write scopes + approval + user token (Claude parity)
AVOID     → Glean-scale full-site crawl until ACL program is paid for
```

**Do not compete with Rovo on pure Jira chat.** Compete on cross-system graph + durable Automations + entities.

## Runnable verification

```bash
# Offline JQL construction, pushdown, pagination, and row mapping
cd "$(git rev-parse --show-toplevel)"
bun test packages/connectors/src/__tests__/jira-virtual-pushdown.test.ts
bun test packages/server/src/gateway/__tests__/app-webhooks.test.ts  # includes Jira raw land
```

## Decisions locked by this spike

1. **Keep virtual default for issues** — correct for S1-style reads; aligns with Family A.
2. **Do not claim webhook+virtual = GitHub-quality automation** — raw land is not enough for S6/S7 without a structured lander.
3. **Next build priorities (order):**
   1. Structured Jira webhook → event with stable `origin_id` + status/key metadata
   2. Write actions (`transition`, `comment`) + approval + user principal
   3. `getIssue` (full fields / comments) as on-demand read, not wider default columns
   4. Per-user token on live virtual reads for multi-user orgs (S2)
   5. Optional narrow collected only if product needs S3/S10 without entities
4. **No full-site collected scrape** as the default — reaffirm hybrid over Glean-lite.

## What we still have not measured (live site owed)

- Real restricted-project ACL with two OAuth users (S2)
- Real webhook payload shape for `jira:issue_updated` with changelog (S6)
- Atlassian rate limits under multi-agent fan-out (S8)
- Side-by-side latency vs Claude MCP on the same JQL

These need a sandbox Atlassian site; offline verification still closed the architectural decisions.

## Confidence

| Claim | Confidence | Basis |
| --- | --- | --- |
| Virtual JQL is right default for ops reads | **High** | Code + unit tests + Rovo MCP tool map |
| Raw webhooks insufficient for Automations | **High** | Gateway tests + raw store path |
| Writes are the main Claude gap | **High** | Supported-tools doc vs connector definition |
| User principal required for safe multi-tenant | **High** | Authz RFC + product model |
| Exact live latency / rate limits | **Low** | Not hit real cloud in this run |
