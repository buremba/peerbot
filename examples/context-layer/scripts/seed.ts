/**
 * Seed the CONTEXT LAYER itself — the org data that explains the warehouse:
 *
 *  1. (declared in lobu.config.ts, not here) A `postgres` connection to the
 *     Kelder warehouse (env auth profile) and a VIRTUAL feed on it: the monthly
 *     churn rollup, read LIVE at request time through the connector pushdown.
 *     Nothing is copied into Lobu. `lobu run` creates both.
 *  2. The `churn_rate` metric-definition entity, with its definition history
 *     as a supersede chain: v1 (2025-07) superseded by v2 (2026-05, dunning
 *     grace). The chain IS the changelog.
 *  3. Three business events — the governed "why" records:
 *       2026-03-12 billing migration (data incident),
 *       2026-05-01 churn definition v2 (definition change),
 *       2026-05-19 courier strike (external shock).
 *  4. Monthly churn observations recorded in Lobu (for the DECLARED metric —
 *     metrics_config on metric-definition makes them queryable via
 *     client.metrics.query).
 *  5. The pinned verified-query entity: the rollup SQL + the human-approved
 *     answer, captured now from the live warehouse.
 *
 * Prereqs: `lobu run` is up in this directory and `bun run seed:warehouse`
 * has been executed. Idempotent guard: refuses to double-seed.
 */

import postgres from "postgres";
import { CHURN_ROLLUP_SQL, WAREHOUSE_URL } from "./lib/env.ts";
import { callTool, connectLocalGateway } from "./lib/gateway.ts";

const gw = await connectLocalGateway();
console.log(`Connected to local gateway (org: ${gw.org})`);

// ── Guard: refuse to double-seed ────────────────────────────────────────────
const existing = await callTool<{ entities?: unknown[] }>(gw, "manage_entity", {
  action: "list",
  entity_type: "metric-definition",
});
if ((existing.entities ?? []).length > 0) {
  console.log(
    "Already seeded (metric-definition entities exist). Wipe ./.lobu-data and restart `lobu run` to reseed."
  );
  process.exit(0);
}

// ── 1. Metric definition entity + versioned definition chain ───────────────
// (The warehouse connection + its VIRTUAL churn-rollup feed are declared in
// lobu.config.ts and created by `lobu run` — see the file header.)
const metricRes = await callTool<{ entity?: { id?: number } }>(
  gw,
  "manage_entity",
  {
    action: "create",
    entity_type: "metric-definition",
    name: "churn_rate",
    slug: "churn-rate",
    metadata: {
      metric: "churn_rate",
      unit: "cancellations/month",
      owner: "data@kelder.coffee",
      // Observations resolve to this entity by alias (metadata.metric match).
      aliases: ["churn_rate"],
    },
  }
);
const metricEntityId = metricRes.entity?.id;
if (!metricEntityId) {
  throw new Error(
    `metric entity create returned no id: ${JSON.stringify(metricRes)}`
  );
}

// Each version carries a machine-usable `governing_predicate` in its metadata —
// NOT just prose. compose.ts reads the version in effect for a month and builds
// that month's rollup SQL from this predicate, so the definition GOVERNS the
// query (the same warehouse yields a different number under v2 than v1), it does
// not merely label it after the fact.
//
//   exclude_payment_failure_in_grace — v2's rule: a payment_failure cancelled
//     within `dunning_grace_days` of its dunning_started_at is a retry-window
//     artifact, not churn, so it is filtered OUT of the count.
const v1 = await callTool<{ id?: number; event_id?: number }>(
  gw,
  "save_memory",
  {
    content:
      "churn_rate v1 = subscriptions cancelled in month / active subscriptions at month start. " +
      "A subscription churns the day cancelled_at is set. Every cancellation counts.",
    semantic_type: "definition",
    title: "churn_rate v1",
    entity_ids: [metricEntityId],
    metadata: {
      version: "v1",
      effective_from: "2025-07-01",
      approved_by: "head-of-data",
      governing_predicate: {
        exclude_payment_failure_in_grace: false,
      },
    },
  }
);
const v1EventId = v1.id ?? v1.event_id;
if (!v1EventId) {
  throw new Error(`definition v1 save returned no id: ${JSON.stringify(v1)}`);
}

await callTool(gw, "save_memory", {
  content:
    "churn_rate v2 = cancellations excluding payment-failure cancellations inside a 28-day " +
    "dunning grace / active subscriptions at month start. A payment_failure cancelled within " +
    "28 days of dunning_started_at is a retry-window artifact (usually self-recovers), not churn.",
  semantic_type: "definition",
  title: "churn_rate v2",
  entity_ids: [metricEntityId],
  supersedes_event_id: v1EventId,
  metadata: {
    version: "v2",
    effective_from: "2026-05-01",
    approved_by: "head-of-data",
    governing_predicate: {
      exclude_payment_failure_in_grace: true,
      dunning_grace_days: 28,
    },
  },
});
console.log(
  `Created churn_rate definition chain: v1 (event ${v1EventId}) superseded by v2`
);

// ── 2. Business events — the governed "why" records ────────────────────────
const businessEvents = [
  {
    name: "Recharge billing migration wrote false cancellations",
    slug: "billing-migration-2026-03",
    metadata: {
      event_date: "2026-03-12",
      event_type: "data_incident",
      affected_metrics: ["churn_rate"],
      // Structured, warehouse-derivable adjustment. compose.ts SUBTRACTS exactly
      // the rows this names (cancel_reason = billing_migration_artifact) from the
      // affected month — it does NOT throw the whole month away. March keeps its
      // ~50 real cancellations; only the ~500 artifacts are removed.
      adjustment: {
        op: "subtract_reason",
        cancel_reason: "billing_migration_artifact",
      },
      expected_effect:
        "Repair 2026-03: ~500 cancellations recorded on 2026-03-12/13 are migration " +
        "artifacts (cancel_reason=billing_migration_artifact), not customers leaving. " +
        "Subtract those rows; the ~50 real cancellations that month still stand.",
      owner: "data-platform",
      source_link: "https://linear.app/kelder/issue/DATA-142",
    },
  },
  {
    name: "Churn definition v2: dunning grace period",
    slug: "churn-definition-v2",
    metadata: {
      event_date: "2026-05-01",
      event_type: "definition_change",
      affected_metrics: ["churn_rate"],
      expected_effect:
        "From 2026-05 the series is computed under churn_rate v2 (payment-failure " +
        "cancellations in a 28-day dunning grace no longer count). Do not compare raw " +
        "pre/post numbers without noting the version change.",
      owner: "data@kelder.coffee",
      source_link: "https://notion.so/kelder/churn-v2",
    },
  },
  {
    name: "Courier strike (Randstad region)",
    slug: "courier-strike-2026-05",
    metadata: {
      event_date: "2026-05-19",
      event_type: "external_shock",
      affected_metrics: ["churn_rate"],
      expected_effect:
        "2026-05 churn is genuinely elevated (~45 extra cancellations 2026-05-19..21, " +
        "cancel_reason=courier_strike). Real but temporary — do not extrapolate the May level.",
      owner: "ops",
      source_link: "https://kelder.slack.com/archives/C042/p1747650000",
    },
  },
];
for (const evt of businessEvents) {
  await callTool(gw, "manage_entity", {
    action: "create",
    entity_type: "business-event",
    ...evt,
  });
}
console.log(`Created ${businessEvents.length} business events`);

// ── 3. Monthly observations (feed the DECLARED metric) ─────────────────────
const observations: Array<[string, number]> = [
  ["2026-01", 50],
  ["2026-02", 50],
  ["2026-03", 550],
  ["2026-04", 50],
];
for (const [month, cancellations] of observations) {
  await callTool(gw, "save_memory", {
    content: `churn observation ${month}: ${cancellations} cancellations`,
    semantic_type: "observation",
    entity_ids: [metricEntityId],
    metadata: { metric: "churn_rate", month, cancellations },
  });
}
console.log(`Recorded ${observations.length} monthly churn observations`);

// ── 4. Verified query: pin the approved answer from the live warehouse ─────
const sql = postgres(WAREHOUSE_URL, { max: 1 });
const approvedAnswer = (await sql.unsafe(CHURN_ROLLUP_SQL)).map((r) => ({
  ...r,
}));
await sql.end();

await callTool(gw, "manage_entity", {
  action: "create",
  entity_type: "verified-query",
  name: "Monthly churn rollup — approved",
  slug: "monthly-churn-rollup",
  metadata: {
    question: "How many cancellations did we have per month?",
    sql: CHURN_ROLLUP_SQL,
    approved_answer: approvedAnswer,
    approved_by: "head-of-data",
    approved_at: "2026-07-12",
  },
});
console.log(
  `Pinned verified query with ${approvedAnswer.length} approved rows`
);

console.log("\nContext layer seeded. Next: bun run compose");
