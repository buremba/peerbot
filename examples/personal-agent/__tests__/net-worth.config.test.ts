import { describe, expect, test } from "bun:test";
import config from "../lobu.config";
import taxConfig from "../../personal-finance/lobu.config";

describe("Midas net-worth configuration", () => {
  test("runs weekly in London even when Midas events are unchanged", () => {
    const behavior = config.behaviors?.find(
      (candidate) => candidate.slug === "midas-net-worth"
    );
    expect(behavior).toBeDefined();
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

  test("declares a same-org, feedless quote connection", () => {
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
    ).toBeDefined();
  });

  test("the tax workspace no longer declares a net-worth Behavior", () => {
    expect(
      taxConfig.behaviors?.find((behavior) => behavior.slug === "net-worth")
    ).toBeUndefined();
  });
});
