import { describe, expect, it } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import runReaction from "../social-interest-radar.reaction";

const signalMetadata = {
  kind: "social_signal",
  platform: "linkedin",
  author: "Ada",
  snippet: "Reliable agents need durable state.",
  why: "Directly relevant to Lobu's delivery model.",
  priority: "high",
  source_origin_id: "linkedin:activity:123",
  source_event_id: 101,
  suggested_action: "Reply with the event-sourcing design.",
};

function context(): ReactionContext {
  return {
    extracted_data: {
      signals: [
        {
          title: "Ada on linkedin",
          content:
            "Directly relevant to Lobu's delivery model.\n\nSuggested action: Reply with the event-sourcing design.",
          parent_event_id: 101,
          idempotency_key: "linkedin:activity:123",
          metadata: signalMetadata,
        },
      ],
    },
    entities: [],
    window: {
      id: 44,
      run_id: 88,
      behavior_id: 71,
      window_start: "2026-08-01T15:00:00.000Z",
      window_end: "2026-08-01T16:00:00.000Z",
      granularity: "hour",
      content_analyzed: 1,
    },
    behavior: {
      id: 71,
      slug: "social-interest-radar",
      name: "Social interest radar (X + LinkedIn)",
      version: 9,
    },
    organization_id: "org-1",
    organization_slug: "buremba",
  };
}

function clientWithRows(
  rows: Array<{ id: number; metadata: typeof signalMetadata }>
) {
  const queries: string[] = [];
  const notifications: Record<string, unknown>[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return rows;
    },
    notifications: {
      send: async (input: Record<string, unknown>) => {
        notifications.push(input);
        return { notified_count: 1 };
      },
    },
  } as unknown as ReactionClient;
  return { client, queries, notifications };
}

describe("social interest radar reaction", () => {
  it("links the notification to declaratively persisted source and reply events", async () => {
    const fixture = clientWithRows([{ id: 501, metadata: signalMetadata }]);

    await runReaction(context(), fixture.client);

    expect(fixture.queries[0]).toContain("run_id = 88");
    expect(fixture.notifications).toEqual([
      expect.objectContaining({
        resource_url: "/buremba/memory?content_ids=101,501",
        idempotency_key: "social-radar:notification:run:88",
      }),
    ]);
  });

  it("does not notify when this run only re-ranked an event owned by an earlier run", async () => {
    const fixture = clientWithRows([]);

    await runReaction(context(), fixture.client);

    expect(fixture.notifications).toHaveLength(0);
  });

  it("lets the original run retry its idempotent notification", async () => {
    const fixture = clientWithRows([{ id: 501, metadata: signalMetadata }]);

    await runReaction(context(), fixture.client);

    expect(fixture.notifications[0]?.idempotency_key).toBe(
      "social-radar:notification:run:88"
    );
  });

  it("keeps the digest within the notification service limit", async () => {
    const fixture = clientWithRows([
      { id: 501, metadata: { ...signalMetadata, why: "x".repeat(1_200) } },
    ]);

    await runReaction(context(), fixture.client);

    expect(String(fixture.notifications[0]?.body).length).toBe(1000);
  });
});
