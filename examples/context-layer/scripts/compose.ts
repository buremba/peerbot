/**
 * THE MONEY SHOT — compose the "governed why" over a LIVE warehouse.
 *
 * A semantic layer answers *what* the number is. This composes the *why*: it
 * reads the governed context records out of Lobu and lets them GOVERN the query
 * that reads the warehouse — the definition version in effect for a month
 * decides how that month is counted, and a data-incident's structured
 * adjustment decides which rows are subtracted. The output is a raw-vs-adjusted
 * churn series where every deviation is explained by a dated, sourced record.
 *
 * Two phases, both on stock Lobu:
 *
 *   1. A sandboxed `run_sdk` script reads the CONTEXT LAYER (no warehouse
 *      access): the `metric-definition` entity, its definition changelog (the
 *      supersede chain, each version carrying a machine-usable
 *      `governing_predicate`), and the `business-event` records (each carrying
 *      an `affected_metrics` list and, for a data incident, a structured
 *      `adjustment`). It returns these as plain JSON.
 *
 *   2. From those predicates + adjustments THIS script GENERATES one governed
 *      rollup SQL and runs it LIVE against the warehouse through the stock
 *      `query_sql` connection pushdown (read-only, nothing copied into Lobu).
 *      The generated SQL is what makes the claim true:
 *        • the definition version GOVERNS the count — post-2026-05 months are
 *          counted under v2 (payment-failures inside the 28-day dunning grace
 *          filtered out), so the SAME warehouse yields a DIFFERENT number than
 *          v1 would. Not a label — a different WHERE.
 *        • a data_incident SUBTRACTS exactly the rows it names
 *          (cancel_reason = billing_migration_artifact) from its month. March is
 *          repaired (~550 → ~50), not thrown away.
 *        • an external_shock keeps its number and only flags it.
 *
 * The composition is deterministic — no LLM. The context layer turns "why did
 * March spike?" from archaeology into a lookup, and turns "which definition was
 * in effect?" from tribal knowledge into a filter the query actually applies.
 *
 * Prereqs: `lobu run` is up here, and `seed:warehouse` + `seed` have run.
 */

import { WAREHOUSE_CONNECTION_SLUG } from "./lib/env.ts";
import { callTool, connectLocalGateway } from "./lib/gateway.ts";

// ── Types shared between the two phases ────────────────────────────────────

interface DefinitionVersion {
  version: string;
  effective_from: string;
  definition: string;
  is_current: boolean;
  governing_predicate: {
    exclude_payment_failure_in_grace?: boolean;
    dunning_grace_days?: number;
  } | null;
}

interface BusinessEvent {
  event: string;
  type: string;
  date: string;
  source: string;
  affected_metrics: string[];
  adjustment: { op: string; cancel_reason?: string } | null;
}

interface ContextLayer {
  metric: string;
  metric_slug: string;
  changelog: DefinitionVersion[];
  events: BusinessEvent[];
}

/**
 * PHASE 1 — read the context layer out of Lobu (stock SDK, no warehouse touch).
 * Everything inside this template literal executes on the gateway, sandboxed.
 */
const CONTEXT_SCRIPT = `
export default async (_ctx, client) => {
  const metricList = await client.entities.list({ entity_type: "metric-definition" });
  const metric = (metricList.entities ?? [])[0];
  if (!metric) throw new Error("metric-definition entity not found — run seed first");
  const metricSlug = metric.metadata?.metric ?? metric.metadata?.aliases?.[0] ?? metric.name;

  // The definition changelog — the supersede chain. Each version carries the
  // machine-usable governing_predicate the query will be built from.
  const changelogRes = await client.knowledge.read({
    entity_id: metric.id,
    semantic_type: "definition",
    include_superseded: true,
    sort_by: "date",
    sort_order: "asc",
  });
  const changelog = (changelogRes.content ?? [])
    .map((e) => ({
      version: e.metadata?.version,
      effective_from: e.metadata?.effective_from,
      definition: e.text_content,
      governing_predicate: e.metadata?.governing_predicate ?? null,
    }))
    .sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  changelog.forEach((d, i) => { d.is_current = i === changelog.length - 1; });

  // The governed "why" records.
  const eventList = await client.entities.list({ entity_type: "business-event" });
  const events = (eventList.entities ?? []).map((ev) => ({
    event: ev.name,
    type: ev.metadata?.event_type,
    date: ev.metadata?.event_date,
    source: ev.metadata?.source_link,
    affected_metrics: ev.metadata?.affected_metrics ?? [],
    adjustment: ev.metadata?.adjustment ?? null,
  }));

  return { metric: metric.name, metric_slug: metricSlug, changelog, events };
};
`;

// ── SQL generation — the definition/incident metadata BECOMES the query ────

/**
 * The governing-version WHERE fragment for a single month: given the version in
 * effect, emit the predicate that decides which cancellations count. v1 counts
 * everything; v2 filters out payment-failures inside the dunning grace. Built
 * from `governing_predicate` — the definition literally governs the SQL.
 */
function versionPredicate(v: DefinitionVersion): string {
  const p = v.governing_predicate;
  if (p?.exclude_payment_failure_in_grace) {
    const graceDays = Number(p.dunning_grace_days ?? 28);
    // A payment_failure cancelled within `graceDays` of its dunning start is a
    // retry-window artifact, not churn — exclude it. Everything else counts.
    // NULL-safe: `IS DISTINCT FROM` keeps a NULL-reason cancellation counted (a
    // plain `cancel_reason = 'x'` would go NULL → NOT NULL → the row silently
    // dropped from the FILTER).
    return (
      `NOT (cancel_reason IS NOT DISTINCT FROM 'payment_failure' ` +
      `AND dunning_started_at IS NOT NULL ` +
      `AND cancelled_at <= dunning_started_at + interval '${graceDays} days')`
    );
  }
  return "TRUE"; // v1: every cancellation counts.
}

/**
 * A single data-incident's structured subtraction, keyed by BOTH the incident's
 * month (from event_date) AND its cancel_reason. Only a subtract_reason
 * adjustment is derivable purely from the warehouse, so that is what we apply.
 */
interface IncidentAdjustment {
  /** YYYY-MM the incident occurred in — the ONLY month its rows are subtracted from. */
  month: string;
  /** SQL string literal for the reason (already single-quoted + escaped). */
  reasonLiteral: string;
}

function incidentAdjustments(
  events: BusinessEvent[],
  metricSlug: string
): IncidentAdjustment[] {
  return events
    .filter(
      (e) =>
        e.type === "data_incident" &&
        e.affected_metrics.includes(metricSlug) &&
        e.adjustment?.op === "subtract_reason" &&
        e.adjustment.cancel_reason &&
        e.date
    )
    .map((e) => ({
      month: String(e.date).slice(0, 7),
      reasonLiteral: `'${String(e.adjustment?.cancel_reason).replace(/'/g, "''")}'`,
    }));
}

/**
 * A row is an "incident artifact" iff it falls in an incident's month AND
 * carries that incident's cancel_reason. Keyed by month so a March incident
 * only ever touches March — it does NOT subtract the reason from every month.
 * NULL-safe via `IS NOT DISTINCT FROM`.
 */
function artifactPredicateSql(adjustments: IncidentAdjustment[]): string {
  if (adjustments.length === 0) return "FALSE";
  const clauses = adjustments.map(
    (a) =>
      `(to_char(date_trunc('month', cancelled_at), 'YYYY-MM') = '${a.month}' ` +
      `AND cancel_reason IS NOT DISTINCT FROM ${a.reasonLiteral})`
  );
  return clauses.join(" OR ");
}

/**
 * Build ONE governed rollup SQL over the warehouse. Per month it returns:
 *   raw          — every cancellation (churn v1, no governance)
 *   adjusted     — counted under the version in effect for that month AND with
 *                  the data-incident rows subtracted (only the affected metric,
 *                  only the incident's own month)
 *   subtracted   — the count of exactly the incident-named rows (the artifacts).
 *                  Derived from the incident predicate alone, so it stays honest
 *                  even if an incident ever lands in a version-governed month
 *                  (never conflated with rows the version predicate excludes).
 * The version-in-effect boundary is emitted as a CASE from the changelog dates,
 * so the SAME query counts pre-May months under v1 and post-May under v2.
 */
function buildGovernedSql(ctx: ContextLayer): string {
  const adjustments = incidentAdjustments(ctx.events, ctx.metric_slug);
  const artifactPredicate = artifactPredicateSql(adjustments);
  // Keep everything that is NOT an incident artifact. `NOT (artifact)` is
  // NULL-safe because artifactPredicate uses IS [NOT] DISTINCT FROM, so it is a
  // total boolean (never NULL) — a NULL-reason row is simply not an artifact.
  const keepPredicate =
    adjustments.length === 0 ? "TRUE" : `NOT (${artifactPredicate})`;

  const chrono = [...ctx.changelog].sort((a, b) =>
    a.effective_from.localeCompare(b.effective_from)
  );
  const earliest = chrono[0];
  if (!earliest) {
    throw new Error(
      "metric-definition has no versioned definition — run `bun run seed` first"
    );
  }
  // CASE arms newest-first: the first month-boundary that is <= the row's month
  // wins, i.e. the version in effect. Falls through to the earliest version.
  const arms = [...chrono]
    .reverse()
    .map(
      (v) =>
        `      WHEN to_char(date_trunc('month', cancelled_at), 'YYYY-MM') >= '${v.effective_from.slice(
          0,
          7
        )}'\n        THEN (${versionPredicate(v)})`
    )
    .join("\n");
  const fallback = versionPredicate(earliest);

  const governedExpr = `CASE\n${arms}\n      ELSE (${fallback})\n    END`;

  return (
    `SELECT to_char(date_trunc('month', cancelled_at), 'YYYY-MM') AS month,\n` +
    `       count(*)::int AS raw,\n` +
    `       count(*) FILTER (\n` +
    `         WHERE (${keepPredicate})\n` +
    `           AND (${governedExpr})\n` +
    `       )::int AS adjusted,\n` +
    `       count(*) FILTER (WHERE ${artifactPredicate})::int AS subtracted\n` +
    `  FROM subscriptions\n` +
    ` WHERE cancelled_at IS NOT NULL\n` +
    ` GROUP BY 1\n` +
    ` ORDER BY 1`
  );
}

// ── Compose ────────────────────────────────────────────────────────────────

interface QuerySqlResult {
  rows: Array<{
    month: string;
    raw: number;
    adjusted: number;
    subtracted: number;
  }>;
  error?: string;
}

const gw = await connectLocalGateway();
console.log(`Connected to local gateway (org: ${gw.org})`);

// Phase 1: the context layer.
const ctxResult = await callTool<{
  return_value?: ContextLayer;
  success: boolean;
  error?: { message: string };
}>(gw, "run_sdk", { script: CONTEXT_SCRIPT, timeout_ms: 60_000 });
if (!ctxResult.success || !ctxResult.return_value) {
  throw new Error(
    `context read failed: ${ctxResult.error?.message ?? "unknown"}`
  );
}
const ctx = ctxResult.return_value;

// Phase 2: GENERATE the governed SQL from that context, run it LIVE.
const governedSql = buildGovernedSql(ctx);
const live = await callTool<QuerySqlResult>(gw, "query_sql", {
  connection: WAREHOUSE_CONNECTION_SLUG,
  sql: governedSql,
});
if (live.error) {
  throw new Error(`governed query failed: ${live.error}\n---\n${governedSql}`);
}
const liveRows = live.rows;

// Which definition version governs a given YYYY-MM month?
const versionFor = (month: string): DefinitionVersion | undefined => {
  let current = ctx.changelog[0];
  for (const def of ctx.changelog) {
    if (def.effective_from.slice(0, 7) <= month) current = def;
  }
  return current;
};

// Join the live governed series with the business-event flags per month.
const months = liveRows.map((row) => {
  const month = row.month;
  const flags = ctx.events
    .filter((ev) => String(ev.date ?? "").slice(0, 7) === month)
    .filter((ev) => ev.affected_metrics.includes(ctx.metric_slug))
    .map((ev) => ({ event: ev.event, type: ev.type, source: ev.source }));
  const gov = versionFor(month);
  return {
    month,
    raw: row.raw,
    adjusted: row.adjusted,
    definition_version: gov?.version ?? null,
    flags,
    // Exactly the incident-named (artifact) rows for this month, straight from
    // the warehouse — never derived as raw−adjusted, so a version-governed month
    // can never inflate the "subtracted" figure.
    subtracted: row.subtracted,
  };
});

// ── Output ─────────────────────────────────────────────────────────────────

console.log(`\n=== Adjusted churn for ${ctx.metric} ===\n`);
console.table(
  months.map((m) => ({
    month: m.month,
    raw: m.raw,
    adjusted: m.adjusted,
    def: m.definition_version,
    flags: m.flags.map((f) => f.type).join(", ") || "",
  }))
);

console.log("\n=== Definition changelog (governs the query) ===");
for (const d of ctx.changelog) {
  const pred = d.governing_predicate?.exclude_payment_failure_in_grace
    ? ` [predicate: exclude payment_failure inside ${d.governing_predicate.dunning_grace_days}-day grace]`
    : " [predicate: count every cancellation]";
  console.log(
    `  ${d.version} (from ${d.effective_from})${d.is_current ? " [current]" : ""}: ${d.definition}${pred}`
  );
}

// Prove the definition MOVES the number, not just labels it: pick a v2-governed
// plain month and show what v1 would have counted vs what v2 actually counts.
const v2Month = months.find(
  (m) => m.definition_version === "v2" && m.flags.length === 0
);
if (v2Month) {
  console.log("\n=== Definition governs the number (not just the label) ===");
  console.log(
    `  ${v2Month.month}: raw ${v2Month.raw} counted under v1 would be ${v2Month.raw}; ` +
      `under the v2 predicate the governed count is ${v2Month.adjusted}. ` +
      `Same warehouse, different number — because the definition changed the WHERE.`
  );
}

console.log("\n=== Narrative ===");
for (const m of months) {
  for (const f of m.flags) {
    if (f.type === "data_incident") {
      console.log(
        `  • ${m.month}: raw ${m.raw} REPAIRED to ${m.adjusted} — ${f.event} ` +
          `(${f.source}). Subtracted ${m.subtracted} artifact rows; the real ` +
          `cancellations that month still stand.`
      );
    } else if (f.type === "definition_change") {
      console.log(
        `  • ${m.month}: definition moved to ${m.definition_version} — ${f.event} ` +
          `(${f.source}). Post-boundary months are counted under the new predicate.`
      );
    } else {
      console.log(
        `  • ${m.month}: raw ${m.raw} genuinely elevated — ${f.event} ` +
          `(${f.source}). Real but flagged; do not extrapolate.`
      );
    }
  }
}

console.log(
  "\nAdjusted churn is computed by letting the governed context drive the query: " +
    "each month is counted under the definition version in effect, data-incident " +
    "artifacts are subtracted (not nulled), and external shocks are kept but " +
    "flagged. Every deviation cites its source of truth."
);
