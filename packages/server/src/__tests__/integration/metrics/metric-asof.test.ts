/**
 * Point-in-time (`reads: { asOf }`) metric reads.
 *
 * The gate here is NOT "asOf returns something" — it is that the point-in-time
 * answer DIFFERS from the current answer in exactly the right way: the same
 * declared measure over the same entity must exclude events that occurred after
 * the cut, include the ones on the boundary day, and still dedupe/segment as it
 * does today. A stale-history bug that returned the current total would pass a
 * "returns a number" test and fail every assertion below.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { compileReadModePredicate, validateMetricReadModes } from "../../../metrics/read-mode";
import { runMetric } from "../../../metrics/run-metric";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from "../../setup/test-fixtures";
import { TestApiClient } from "../../setup/test-mcp-client";

const CHARGES = {
  by: "alias",
  field: "metadata->>'description'",
  against: "aliases",
  where: "semantic_type='transaction' AND connector_key='revolut'",
  dedupeKey: ["metadata->>'date'", "metadata->>'amount'", "metadata->>'description'"],
};

const METRICS = {
  eventSets: {
    charges: CHARGES,
    // End of 31 March (UTC) — the date-only form, read INCLUSIVELY.
    charges_eod_march: { ...CHARGES, reads: { asOf: "2026-03-31" } },
    // Midday 31 March — an explicit instant, read inclusively at that instant.
    charges_noon_march: { ...CHARGES, reads: { asOf: "2026-03-31T12:00:00Z" } },
  },
  segments: {
    outflow: {
      description: "Money leaving the account.",
      where: "metadata->>'direction'='out'",
      on: "event",
      appliedBefore: "dedupe",
    },
  },
  measures: {
    balance: {
      eventSet: "charges",
      agg: "sum",
      expr: "(metadata->>'amount')::numeric",
      segments: ["outflow"],
      description: "Total outflow to this company (current truth).",
    },
    balance_eod_march: {
      eventSet: "charges_eod_march",
      agg: "sum",
      expr: "(metadata->>'amount')::numeric",
      segments: ["outflow"],
      description: "Outflow as of the end of 31 March 2026.",
    },
    balance_noon_march: {
      eventSet: "charges_noon_march",
      agg: "sum",
      expr: "(metadata->>'amount')::numeric",
      segments: ["outflow"],
      description: "Outflow as of midday 31 March 2026.",
    },
    charge_count_eod_march: {
      eventSet: "charges_eod_march",
      agg: "count",
      segments: ["outflow"],
      description: "Deduped outflow charges as of the end of 31 March 2026.",
    },
  },
  dimensions: {
    currency: {
      expr: "metadata->>'currency'",
      description: "Charge currency.",
    },
  },
};

async function total(orgId: string, measure: string): Promise<number> {
  const rows = await runMetric({
    organizationId: orgId,
    entityType: "company",
    measure,
  });
  return rows.reduce((sum, row) => sum + Number(row[measure] ?? 0), 0);
}

describe("metric compiler — asOf point-in-time reads", () => {
  let orgId: string;
  let owner: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: "Metric AsOf Org" });
    orgId = org.id;
    const user = await createTestUser({ email: "metric-asof@test.com" });
    await addUserToOrganization(user.id, org.id, "owner");
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: "owner",
    });

    await owner.entity_schema.createType({
      slug: "company",
      name: "Company",
      metrics_config: METRICS,
    });

    const company = await createTestEntity({
      name: "Anthropic",
      entity_type: "company",
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      UPDATE entities SET metadata = ${sql.json({ aliases: ["Claude.ai", "Anthropic"] })}
      WHERE id = ${company.id}
    `;

    const charge = (occurredAt: string, m: Record<string, unknown>) =>
      createTestEvent({
        organization_id: orgId,
        content: "charge",
        semantic_type: "transaction",
        connector_key: "revolut",
        occurred_at: new Date(occurredAt),
        metadata: m,
      });

    // Before the cut.
    await charge("2026-02-10T09:00:00Z", {
      date: "2026-02-10",
      amount: 100,
      currency: "GBP",
      direction: "out",
      description: "Claude.ai",
    });
    // ON the boundary day, AFTER midday — in for the end-of-day cut, out for the
    // midday instant. This is the off-by-one that a naive `<= '2026-03-31'`
    // would silently drop.
    await charge("2026-03-31T18:00:00Z", {
      date: "2026-03-31",
      amount: 50,
      currency: "GBP",
      direction: "out",
      description: "Anthropic",
    });
    // Exact duplicate on the boundary day → must still dedupe under asOf.
    await charge("2026-03-31T18:00:00Z", {
      date: "2026-03-31",
      amount: 50,
      currency: "GBP",
      direction: "out",
      description: "Anthropic",
    });
    // Refund on the boundary day → still excluded by the outflow segment.
    await charge("2026-03-31T19:00:00Z", {
      date: "2026-03-31",
      amount: 9,
      currency: "GBP",
      direction: "in",
      description: "Claude.ai",
    });
    // After the cut — the whole point: current sees it, asOf must not.
    await charge("2026-04-05T09:00:00Z", {
      date: "2026-04-05",
      amount: 7,
      currency: "GBP",
      direction: "out",
      description: "Claude.ai",
    });
  });

  it("answers the historical state, not the current one", async () => {
    const current = await total(orgId, "balance");
    const endOfMarch = await total(orgId, "balance_eod_march");
    const middayMarch = await total(orgId, "balance_noon_march");

    // Current truth: 100 + 50 (dup collapsed) + 7.
    expect(current).toBeCloseTo(157, 2);
    // End of 31 March: the April charge is gone, the boundary-day charge stays.
    expect(endOfMarch).toBeCloseTo(150, 2);
    // Midday 31 March: the 18:00 charge had not happened yet.
    expect(middayMarch).toBeCloseTo(100, 2);

    // The assertion that matters: these are genuinely different answers.
    expect(endOfMarch).not.toBeCloseTo(current, 2);
    expect(middayMarch).not.toBeCloseTo(endOfMarch, 2);
  });

  it("keeps dedupe and segments under the cut", async () => {
    const rows = await runMetric({
      organizationId: orgId,
      entityType: "company",
      measure: "charge_count_eod_march",
    });
    const count = rows.reduce((sum, row) => sum + Number(row.charge_count_eod_march ?? 0), 0);
    // Feb charge + ONE of the duplicated 31 March charges; refund excluded.
    expect(count).toBe(2);
  });

  it("still groups by dimension under the cut", async () => {
    const rows = await runMetric({
      organizationId: orgId,
      entityType: "company",
      measure: "balance_eod_march",
      by: ["currency"],
    });
    const byCurrency = Object.fromEntries(
      rows.map((row) => [row.currency as string, Number(row.balance_eod_march)]),
    );
    expect(byCurrency.GBP).toBeCloseTo(150, 2);
  });

  it("rejects a malformed asOf at apply time, not at query time", async () => {
    await expect(
      owner.entity_schema.createType({
        slug: "broken_asof",
        name: "Broken",
        metrics_config: {
          eventSets: { c: { ...CHARGES, reads: { asOf: "31/03/2026" } } },
          measures: {
            m: { eventSet: "c", agg: "count", description: "x" },
          },
        },
      }),
    ).rejects.toThrow(/asOf/);
  });

  describe("predicate lowering", () => {
    it("reads a date-only cut as the END of that UTC day", () => {
      expect(compileReadModePredicate({ asOf: "2026-03-31" }, "c")).toBe(
        "occurred_at < '2026-04-01T00:00:00.000Z'::timestamptz",
      );
    });

    it("reads an explicit instant inclusively", () => {
      expect(compileReadModePredicate({ asOf: "2026-03-31T12:00:00Z" }, "c")).toBe(
        "occurred_at <= '2026-03-31T12:00:00Z'::timestamptz",
      );
    });

    it("adds no predicate for the default current read", () => {
      expect(compileReadModePredicate(undefined, "c")).toBeNull();
      expect(compileReadModePredicate("current", "c")).toBeNull();
    });

    it("refuses an offset-less timestamp (replica-dependent answer)", () => {
      expect(() => compileReadModePredicate({ asOf: "2026-03-31T12:00:00" }, "c")).toThrow(
        /explicit offset/,
      );
    });

    // `Date.parse("2026-02-30T00:00:00Z")` succeeds and rolls over to 2 March,
    // so shape-matching plus a NaN check accepts a date that does not exist and
    // silently answers as of a different day. Caught by pi-review on #2766.
    it("refuses an impossible calendar date instead of rolling it over", () => {
      for (const bad of ["2026-02-30", "2026-04-31", "2026-13-01", "2026-02-29"]) {
        expect(() => compileReadModePredicate({ asOf: bad }, "c")).toThrow(/is not a real date/);
        expect(
          validateMetricReadModes({
            eventSets: { c: { by: "alias", reads: { asOf: bad } } },
          }),
        ).toHaveLength(1);
      }
    });

    it("refuses an impossible calendar date in the instant form too", () => {
      expect(() => compileReadModePredicate({ asOf: "2026-02-30T12:00:00Z" }, "c")).toThrow(
        /must be an ISO-8601 date/,
      );
    });

    it("still accepts a real leap day", () => {
      expect(compileReadModePredicate({ asOf: "2024-02-29" }, "c")).toBe(
        "occurred_at < '2024-03-01T00:00:00.000Z'::timestamptz",
      );
    });

    it("refuses an injected literal", () => {
      expect(() => compileReadModePredicate({ asOf: "2026-03-31' OR '1'='1" }, "c")).toThrow(
        /must be an ISO-8601 date/,
      );
      expect(
        validateMetricReadModes({
          eventSets: { c: { by: "alias", reads: { asOf: "x'" } } },
        }),
      ).toHaveLength(1);
    });

    it("leaves raw unimplemented rather than silently answering current", () => {
      expect(() => compileReadModePredicate("raw", "c")).toThrow(/not implemented/);
      // …but an unimplemented mode is not an apply-time error.
      expect(
        validateMetricReadModes({
          eventSets: { c: { by: "alias", reads: "raw" } },
        }),
      ).toEqual([]);
    });
  });
});
