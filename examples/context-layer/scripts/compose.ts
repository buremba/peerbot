/**
 * THE MONEY SHOT — compose the "governed why" over a LIVE warehouse.
 *
 * One sandboxed `run_sdk` script does the whole join, in-process, on the
 * gateway:
 *
 *   1. `client.feeds.readMany` on the VIRTUAL churn feed — the monthly rollup
 *      is pushed down to the warehouse and read LIVE. Nothing is copied into
 *      Lobu; the numbers are whatever the warehouse says right now.
 *   2. `client.entities.list` on `business-event` — the dated, sourced records
 *      that explain the distortions in that series.
 *   3. `client.knowledge.read({ include_superseded: true })` on the
 *      `metric-definition` entity — the definition changelog (the supersede
 *      chain), so each month can be labelled with the version in effect.
 *
 * The script joins these by month in plain JS and returns a composed narrative:
 * raw vs adjusted churn per month, a flag per month citing each overlapping
 * business event's `source_link`, and the definition version governing it.
 *
 * The composition is deterministic — no LLM. The context layer turns "why did
 * March spike?" from archaeology into a lookup.
 *
 * Prereqs: `lobu run` is up here, and `seed:warehouse` + `seed` have run.
 */

import { connectLocalGateway, runSdkSource } from "./lib/gateway.ts";

/**
 * The sandboxed SDK script. Exports `default async (ctx, client) => ...`; the
 * gateway runs it in-process with a scoped `client`. Everything inside this
 * template literal executes on the server, NOT in this Bun process.
 */
const SANDBOX_SCRIPT = `
export default async (_ctx, client) => {
  // ── 1. Resolve the pieces of the context layer ──────────────────────────
  const feedList = await client.feeds.list({});
  const churnFeed = (feedList.feeds ?? []).find(
    (f) => f.kind === "virtual" && f.feed_key === "query",
  );
  if (!churnFeed) throw new Error("virtual churn feed not found — run seed first");

  const metricList = await client.entities.list({ entity_type: "metric-definition" });
  const metric = (metricList.entities ?? [])[0];
  if (!metric) throw new Error("metric-definition entity not found — run seed first");

  const eventList = await client.entities.list({ entity_type: "business-event" });
  const businessEvents = eventList.entities ?? [];

  // ── 2. Read the churn rollup LIVE from the warehouse (pushdown) ──────────
  const feedRead = await client.feeds.readMany({ feed_ids: [churnFeed.id] });
  const feedResult = (feedRead.results ?? []).find((r) => r.ok);
  if (!feedResult) {
    throw new Error("virtual feed read failed: " + JSON.stringify(feedRead));
  }
  const churnRows = feedResult.result.rows ?? [];

  // ── 3. Read the definition changelog (supersede chain) ──────────────────
  const changelogRes = await client.knowledge.read({
    entity_id: metric.id,
    semantic_type: "definition",
    include_superseded: true,
    sort_by: "date",
    sort_order: "asc",
  });
  // knowledge.read (get_content) returns { content: ContentItem[] }; each item's
  // body is text_content. Read those shapes directly so a real API change fails
  // loudly instead of silently yielding [].
  const changelog = (changelogRes.content ?? [])
    .map((e) => ({
      id: e.id,
      title: e.title,
      definition: e.text_content,
      version: e.metadata?.version,
      effective_from: e.metadata?.effective_from,
    }))
    .sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));

  // Which definition version governs a given YYYY-MM month?
  const versionFor = (month) => {
    let current = changelog[0];
    for (const def of changelog) {
      if (String(def.effective_from).slice(0, 7) <= month) current = def;
    }
    return current?.version ?? null;
  };
  changelog.forEach((d, i) => {
    d.is_current = i === changelog.length - 1;
  });

  // ── 4. Join by month in JS ──────────────────────────────────────────────
  const months = churnRows.map((row) => {
    const month = String(row.month);
    const raw = Number(row.cancellations);

    // Business events overlapping this month.
    const flags = businessEvents
      .filter((ev) => String(ev.metadata?.event_date ?? "").slice(0, 7) === month)
      .map((ev) => ({
        event: ev.name,
        type: ev.metadata?.event_type,
        date: ev.metadata?.event_date,
        source: ev.metadata?.source_link,
      }));

    // A data_incident means the numbers are WRONG — exclude that month from the
    // adjusted series. Everything else is real (keep the number, keep the flag).
    const excluded = flags.some((f) => f.type === "data_incident");

    return {
      month,
      raw_cancellations: raw,
      adjusted_cancellations: excluded ? null : raw,
      excluded,
      flags,
      definition_version: versionFor(month),
    };
  });

  // ── 5. A human-readable narrative citing sources + versions ─────────────
  const lines = [];
  for (const m of months) {
    for (const f of m.flags) {
      if (f.type === "data_incident") {
        lines.push(
          m.month + ": raw " + m.raw_cancellations + " EXCLUDED — " + f.event +
            " (" + f.source + "). Adjusted series drops this month.",
        );
      } else if (f.type === "definition_change") {
        lines.push(
          m.month + ": definition moved to " + m.definition_version + " — " +
            f.event + " (" + f.source + "). Do not compare raw across the boundary.",
        );
      } else {
        lines.push(
          m.month + ": raw " + m.raw_cancellations + " genuinely elevated — " +
            f.event + " (" + f.source + "). Real but flagged; do not extrapolate.",
        );
      }
    }
  }

  return {
    metric: metric.name,
    months,
    narrative: {
      definitions_changelog: changelog,
      flagged_months: lines,
      summary:
        "Adjusted churn excludes months distorted by data incidents and labels " +
        "each month with the governed definition version in effect. Every flag " +
        "cites its source of truth.",
    },
  };
};
`;

interface Composed {
  metric: string;
  months: Array<{
    month: string;
    raw_cancellations: number;
    adjusted_cancellations: number | null;
    excluded: boolean;
    flags: Array<{ event: string; type: string; date: string; source: string }>;
    definition_version: string | null;
  }>;
  narrative: {
    definitions_changelog: Array<{
      version: string;
      effective_from: string;
      definition: string;
      is_current: boolean;
    }>;
    flagged_months: string[];
    summary: string;
  };
}

const gw = await connectLocalGateway();
console.log(`Connected to local gateway (org: ${gw.org})`);

const composed = await runSdkSource<Composed>(gw, SANDBOX_SCRIPT);

console.log(`\n=== Adjusted churn for ${composed.metric} ===\n`);
const table = composed.months.map((m) => ({
  month: m.month,
  raw: m.raw_cancellations,
  adjusted: m.excluded ? "—" : m.adjusted_cancellations,
  def: m.definition_version,
  flags: m.flags.map((f) => f.type).join(", ") || "",
}));
console.table(table);

console.log("\n=== Definition changelog ===");
for (const d of composed.narrative.definitions_changelog) {
  console.log(
    `  ${d.version} (from ${d.effective_from})${d.is_current ? " [current]" : ""}: ${d.definition}`
  );
}

console.log("\n=== Narrative ===");
for (const line of composed.narrative.flagged_months) {
  console.log(`  • ${line}`);
}
console.log(`\n${composed.narrative.summary}`);
