import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

describe("Lobu Team configuration", () => {
  test("owns office and product operations in one organization config", () => {
    expect(config.org).toBe("lobu-team");
    expect(config.organizationId).toBe("UdNAH1bb3csC842vhOgxAHVcfX4tYU5A");
    expect(config.behaviors?.map((behavior) => behavior.slug)).toEqual([
      "lobu-team-lunch-open",
      "lobu-team-lunch-finalize",
      "product-activity-digest",
    ]);
  });

  test("uses one hosted Slack declaration for the whole team", () => {
    expect(
      config.connections?.filter(
        (connection) => connection.connector === "slack"
      )
    ).toEqual([
      expect.objectContaining({
        slug: "lobu-team-slack",
        credentialMode: "hosted",
        surfaces: ["dm", "channel"],
      }),
    ]);
  });

  test("keeps product activity and logs organization-owned", () => {
    expect(
      config.connections?.find(
        (connection) => connection.slug === "lobu-product-activity-db"
      )
    ).toMatchObject({ connector: "postgres" });
    expect(
      config.connections?.find(
        (connection) => connection.slug === "lobu-production-logs"
      )
    ).toMatchObject({ connector: "loki.activity" });

    const digest = config.behaviors?.find(
      (behavior) => behavior.slug === "product-activity-digest"
    );
    expect(digest?.triggers).toEqual([
      {
        kind: "schedule",
        cron: "5,25,45 * * * *",
        skip_if_unchanged: true,
      },
    ]);
    expect(digest?.sources).toEqual({
      product_activity: "@connection:lobu-product-activity-db",
      kubernetes_logs: "@connection:lobu-production-logs",
    });
    expect(digest?.agent).toMatchObject({ id: "product-ops" });
    expect(digest?.reaction).toMatchObject({
      kind: "reactionSource",
      path: "./product-activity-digest.reaction.ts",
    });
  });
});
