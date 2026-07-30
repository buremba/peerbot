/**
 * The one name for "this turn is executing a Behavior", shared by the site
 * that stamps it and the sites that read it back off the signed worker token.
 *
 * A Behavior run is dispatched with `intent.kind === "behavior_run"`; the
 * enqueue path (routes/public/agent.ts) turns that into
 * `platformMetadata.source = "watcher-run"`, which `buildWorkerTokenClaims`
 * lifts into the token as `WorkerTokenData.source`. `watcher` is the internal
 * engine vocabulary for a Behavior, so the wire value keeps its historical
 * spelling — nothing agent-facing reads it.
 *
 * What reading it back means: the turn's job text is the FROZEN instruction
 * body the Behavior version compiled at apply/save time, not a human's
 * message. That freeze is only honest if the agent's live skill *library*
 * stays out of the turn — the progressive catalog advertises skills the freeze
 * never picked, and both the catalog and its generic fallback tell the model
 * to `cat .skills/…`, which serves whatever the library holds today (issue
 * #2320 must-fix 1). Persona, tools, MCP and network stay live; they are the
 * agent, not the job.
 *
 * Narrower than the SSE-routing notion of "headless": connector-repair,
 * scheduled-job and internal turns have no frozen Behavior text behind them,
 * so suppressing their skills would only make them dumber. Ordinary chat is
 * excluded for the same reason even when a Behavior is listening on the
 * conversation — a human is in that thread and the library is theirs.
 *
 * Why the worker's 5-minute session-context cache needs no isolation key: a
 * Behavior run opens its own session (`thread: watcher-<runId>`, `forceNew`,
 * see `watchers/automation.ts`), and the deployment name hashes the
 * conversation id — so a run's worker process is never the process that also
 * serves that agent's chat. If a future dispatch path ever runs a Behavior on
 * a shared conversation, that cache becomes the place this decision leaks.
 */
export const BEHAVIOR_RUN_SOURCE = "watcher-run";
