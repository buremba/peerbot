# Tool surface for glm-4.7: discrete MCP vs. just-bash / MCP-as-CLI

**Question.** For the `z-ai` provider's **glm-4.7** model, is the agent more
reliable when the ~23 Lobu MCP tools are exposed as **(A) discrete first-class
tools** or **(B) a single `bash` tool where MCP tools are invoked as
`lobu <tool> <<<'{json}'`** (the embedded "MCP-as-CLI" surface)?

**Answer (short).** Discrete MCP (Arm A) is the better surface for glm-4.7, but
the dominant result is that **glm-4.7 is an unreliable agent for multi-step CRM
ops on either surface** — it tends to make a single exploratory tool call and
stop. Arm B adds a second, larger failure mode on top: glm-4.7 frequently does
not discover or use the `lobu` CLI at all (it reaches for `sqlite3` / local
files), and when it does use it, malformed shell/heredoc quoting drives a high
errored-call rate. See numbers below.

> This is a research finding. **No production agent config was changed.** The
> recommendation is the output.

## The two surfaces and the toggle

The worker chooses the surface from `mcpExposure` in
`packages/agent-worker/src/openclaw/worker.ts`:

```
const mcpExposure =
  toolsConfig?.mcpExposure === "cli" || process.env.LOBU_MCP_EXPOSURE === "cli"
    ? "cli"   // Arm B — one bash tool, MCP tools as `lobu <tool>` CLIs
    : "tools" // Arm A — discrete first-class MCP tools (default cloud surface)
```

- **Arm A (`tools`, default cloud):** `createMcpToolDefinitions` registers every
  MCP tool as a pi tool. The model calls them as function calls.
- **Arm B (`cli`, embedded deployment):** `buildMcpCliCommands` registers one
  just-bash command per MCP server; `createEmbeddedBashOps` wires it into the
  bash tool. The model runs `lobu --help`, `lobu <tool> --schema`, and
  `lobu <tool> <<<'{json}'`. Both are runnable today.

## Harness

`examples/lobu-crm/evals/tool-surface/` (see its README for run instructions).

- **Real model:** glm-4.7 over z-ai, model object built exactly as the worker's
  `model-resolver.ts` (openai-completions, `https://api.z.ai/api/coding/paas/v4`,
  `compat.supportsStore=false`, key `Z_AI_API_KEY`).
- **Real tools + DB:** the actual Lobu MCP handlers (`manage_entity`,
  `save_memory`, `search_memory`, `query_sql`, …) over a real Postgres
  (server-package fixtures + migrations on `lobu_test`).
- **Real surfaces:** Arm A from `getAllTools()`; Arm B from the worker's real
  `buildMcpCliCommands` + `createOpenClawTools` bash + just-bash interpreter.
- **Success checks** assert resulting DB / entity / event STATE, not the reply.
  Read tasks additionally score the reply text.

### One deliberate divergence (documented honestly)

just-bash hardens `Error.stackTraceLimit` to non-writable for the duration of a
custom-command execution. postgres.js stamps a cached Error on every query
(`Error.stackTraceLimit = 4`), so running the DB handlers **in-process inside a
just-bash command** throws "Attempted to assign to readonly property". Production
never hits this because the MCP-CLI handler calls the gateway over HTTP and the
DB work runs in the **gateway process**. The harness reproduces that exact
boundary: a separate `dispatcher-server.ts` process owns Postgres + the handlers,
and Arm B's `callTool` reaches it via `fetch`, like `callMcpTool` reaches the
gateway. So Arm B's model-facing surface (heredoc, quoting, `lobu <tool>`
dispatch, JSON-on-stdin) is the worker's, and DB work crosses a real process
boundary as in prod.

### Harness-fidelity notes (affect both arms equally)

- Local runs have no embeddings service, so `search_memory`'s vector path is
  empty. Seeded leads are named `"<Person> — <Company>"` so the fuzzy/trigram
  name fallback finds them, matching how the production agent (with embeddings)
  would. Without this, weak models bail after an empty first lookup — an artifact
  of the harness, not the tool surface.
- Each arm gets ONLY its surface active: Arm A = the 23 MCP tools (pi's
  `process`/`subagent`/`bash` built-ins removed); Arm B = one `bash` tool.

## Tasks (CRM-ops, from the `crm-ops` skill)

1. `create-lead` — create Jane Doe / AcmeCo / GitHub star / signal.
2. `read-pipeline` — counts per stage (state + reply check).
3. `advance-stage` — AcmeCo → conversation (must write `lead:stage_changed` event
   AND update the entity).
4. `log-interaction` — log a call, next step demo (`lead:interaction` event).
5. `open-pilot` — multi-step: pilot entity + `converted-to` link + lead→pilot.
6. `stale-leads` — reasoning read: which leads are stale in conversation >7d
   (must name StaleCo only; reply check).

## Results

Real glm-4.7 over z-ai. **6 tasks × 2 arms × 3 trials = 36 real model runs.**
Raw per-cell metrics in `examples/lobu-crm/evals/tool-surface/last-run.json`.

**Overall by arm**

| arm | pass rate | mean calls | fumble rate | mean turns | mean sec |
|---|---|---|---|---|---|
| A — discrete MCP | **28% (5/18)** | 4.3 | **0% (0/77)** | 5.1 | 32 |
| B — bash / MCP-as-CLI | **0% (0/18)** | 9.5 | **50% (86/171)** | 10.5 | 34 |

**By arm × task (pass rate / mean calls / mean fumbles)**

| arm | task | pass rate | mean calls | mean fumbles |
|---|---|---|---|---|
| A-discrete | create-lead | 100% (3/3) | 3.7 | 0.0 |
| A-discrete | read-pipeline | 33% (1/3) | 4.7 | 0.0 |
| A-discrete | advance-stage | 0% (0/3) | 2.3 | 0.0 |
| A-discrete | log-interaction | 0% (0/3) | 2.7 | 0.0 |
| A-discrete | open-pilot | 0% (0/3) | 4.0 | 0.0 |
| A-discrete | stale-leads | 33% (1/3) | 8.3 | 0.0 |
| B-bash-cli | create-lead | 0% (0/3) | 8.0 | 4.3 |
| B-bash-cli | read-pipeline | 0% (0/3) | 10.0 | 4.7 |
| B-bash-cli | advance-stage | 0% (0/3) | 12.0 | 6.3 |
| B-bash-cli | log-interaction | 0% (0/3) | 9.7 | 4.3 |
| B-bash-cli | open-pilot | 0% (0/3) | 8.7 | 5.0 |
| B-bash-cli | stale-leads | 0% (0/3) | 8.7 | 4.0 |

**Reading the numbers**

- **Arm A makes valid tool calls (0 fumbles across all 77 calls)** — glm-4.7
  forms the discrete function calls correctly. Its failures are *procedural*: it
  updates the entity but skips the required `lead:stage_changed` /
  `pilot:created` event, or logs an interaction under `semantic_type: "note"`
  instead of `lead:interaction` (skill-convention violations the state checks
  enforce). Single-step tasks it can fully express (create-lead) pass 3/3.
- **Arm B fumbles ~half of every call** — 86 of 171 tool calls errored, almost
  all malformed `lobu <tool>` invocations (bad heredoc/JSON-in-shell quoting,
  wrong sub-command). It needed ~2.2× the calls and turns of Arm A and still
  passed nothing. In one trial it never invoked `lobu` at all (`lobu=false`).

## Failure modes observed

- **Arm A — procedural under-completion (the dominant Arm A failure):** glm-4.7
  forms valid discrete tool calls (0 fumbles), but on multi-step CRM ops it does
  part of the procedure and stops. advance-stage: it updates `metadata.stage`
  but never writes the `lead:stage_changed` event. log-interaction: it saves the
  event but under `semantic_type: "note"` instead of `lead:interaction`.
  open-pilot: it creates the pilot but skips the `converted-to` link / stage
  move. Single-step tasks it can fully express (create-lead) pass 3/3.
- **Arm B — does not reliably discover the CLI:** in an earlier exploratory run
  glm-4.7 reached for `sqlite3` and wrote a local JSON file rather than running
  `lobu --help`; in the scored run one trial still never invoked `lobu`
  (`lobu=false`). The MCP-as-CLI surface is not self-evident to it.
- **Arm B — shell/quoting fumbles (dominant Arm B failure):** when it does use
  `lobu`, malformed heredocs / JSON-in-shell quoting / wrong sub-commands errored
  **50% of all tool calls (86/171)**. It burned ~2.2× the calls and turns of Arm
  A and still completed nothing.

### Harness bug found and fixed mid-eval (disclosure)

The first Arm A pass scored 0/18 with a suspiciously uniform "exactly 1 tool call
then stop." Root cause was a harness bug, not the model: Arm A's custom-tool
`execute` returned `{ output, isError }`, but pi's `AgentTool` requires
`{ content: [{type:"text", text}], details }` — so the model received
`undefined` as every tool result and stopped. Fixed to mirror the worker's
`toToolResult`; re-ran clean (the 28% above). Documented here so the reported
numbers aren't mistaken for the buggy first pass.

## Recommendation

For **glm-4.7**, keep the **discrete MCP surface (Arm A, the current cloud
default)**. The MCP-as-CLI surface (Arm B) adds two failure modes glm-4.7 is
especially bad at — CLI discovery and shell quoting — without improving task
success. Do **not** flip `mcpExposure: "cli"` for glm-4.7 agents.

Caveats:
- The bigger lever is the model: glm-4.7 under-completes multi-step agentic
  tasks on either surface. If reliability matters, a stronger agentic model (or
  a more directive system prompt / explicit step scaffolding) moves the needle
  more than the tool-surface choice.
- This measures glm-4.7 specifically. Stronger models that are comfortable in a
  shell may close or invert the Arm A/Arm B gap; re-run the harness per model
  before changing a default.
