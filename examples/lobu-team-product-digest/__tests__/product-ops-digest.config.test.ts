import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

describe("Lobu Team product activity digest", () => {
  test("is organization-owned and runs every 20 minutes", () => {
    expect(config.org).toBe("lobu-team");

    const behavior = config.behaviors?.find(
      (candidate) => candidate.slug === "product-activity-digest"
    );
    expect(behavior).toBeDefined();
    expect(behavior?.agent).toMatchObject({ id: "product-ops" });
    expect(behavior?.triggers).toEqual([
      {
        kind: "schedule",
        cron: "5,25,45 * * * *",
        skip_if_unchanged: false,
      },
    ]);
    expect(behavior?.reaction).toMatchObject({
      kind: "reactionSource",
      path: "./product-activity-digest.reaction.ts",
    });
  });

  test("collects product activity and Kubernetes logs through org connections", () => {
    const connections = config.connections ?? [];
    const productActivity = connections.find(
      (candidate) => candidate.slug === "lobu-product-activity-db"
    );
    const kubernetesLogs = connections.find(
      (candidate) => candidate.slug === "lobu-production-logs"
    );

    expect(productActivity?.connector).toBe("postgres");
    expect(productActivity?.feeds).toMatchObject([
      { feed: "query", schedule: "2,22,42 * * * *" },
    ]);
    expect(JSON.stringify(productActivity?.feeds)).toContain(
      "m.last_activity_at AS occurred_at"
    );
    expect(kubernetesLogs?.connector).toBe("loki.activity");
    expect(kubernetesLogs?.feeds).toMatchObject([
      { feed: "activity", schedule: "3,23,43 * * * *" },
    ]);
  });
});
