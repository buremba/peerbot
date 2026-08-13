import { describe, expect, test } from "bun:test";
import taxConfig from "../../personal-finance/lobu.config";
import config from "../lobu.config";

describe("consolidated net-worth configuration", () => {
  test("keeps the durable Behavior identity and runs weekly even when books are unchanged", () => {
    const behavior = config.behaviors?.find(
      (candidate) => candidate.slug === "midas-net-worth"
    );
    expect(behavior).toBeDefined();
    expect(behavior?.name).toBe("Weekly net worth");
    expect(behavior?.tags).toEqual(
      expect.arrayContaining(["midas", "revolut", "net-worth"])
    );
    expect(behavior?.triggers).toEqual([
      {
        kind: "schedule",
        cron: "0 9 * * 1",
        timezone: "Europe/London",
        skip_if_unchanged: false,
      },
    ]);
    expect(behavior?.reaction).toMatchObject({
      path: "./net-worth.reaction.ts",
    });
  });

  test("exposes the latest precomputed scalar and bounded drilldown as a derived entity", () => {
    const entity = config.entities?.find(
      (candidate) => candidate.key === "net-worth-snapshot"
    );
    expect(entity?.backing?.sql).toContain(
      "metadata->>'schema' = 'net-worth-snapshot/v3'"
    );
    expect(entity?.backing?.sql).toContain("SUM(latest.net_worth_gbp) OVER ()");
    expect(entity?.backing?.sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(entity?.backing?.sql).toContain("LIMIT 1");
    expect(entity?.backing?.sql).not.toContain("GROUP BY");
  });

  test("declares a same-org catalog quote handle without shipping duplicate source", () => {
    expect(
      config.connections?.find(
        (connection) => connection.slug === "market-quotes"
      )
    ).toMatchObject({
      connector: "market.quotes",
      feeds: [],
    });
    expect(
      config.connectors?.find(
        (connector) => connector.path === "./market-quotes.connector.ts"
      )
    ).toBeUndefined();
  });

  test("the tax workspace no longer declares a net-worth Behavior", () => {
    expect(
      taxConfig.behaviors?.find((behavior) => behavior.slug === "net-worth")
    ).toBeUndefined();
  });
});
