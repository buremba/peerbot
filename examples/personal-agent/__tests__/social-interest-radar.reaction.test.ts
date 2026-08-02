import { describe, expect, it } from "bun:test";
import type {
  KnowledgeSaveResult,
  ReactionClient,
  ReactionContext,
} from "@lobu/connector-sdk";
import runReaction from "../social-interest-radar.reaction";

function context(): ReactionContext {
  return {
    extracted_data: {
      digest_title: "Social interest radar",
      analysis_summary: "One useful post",
      items: [
        {
          platform: "linkedin",
          author: "Ada",
          snippet: "Reliable agents need durable state.",
          why: "Directly relevant to Lobu's delivery model.",
          priority: "high",
          source_origin_id: "linkedin:activity:123",
          source_event_id: 101,
          suggested_action: "Reply with the event-sourcing design.",
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

function clientWithSaveResult(saveResult: KnowledgeSaveResult) {
  const saves: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const client = {
    knowledge: {
      save: async (input: Record<string, unknown>) => {
        saves.push(input);
        return saveResult;
      },
    },
    notifications: {
      send: async (input: Record<string, unknown>) => {
        notifications.push(input);
        return { ok: true };
      },
    },
  } as unknown as ReactionClient;
  return { client, saves, notifications };
}

describe("social interest radar reaction", () => {
  it("persists a threaded reply and links the notification to both events", async () => {
    const fixture = clientWithSaveResult({
      id: 501,
      created: true,
      metadata: { producer_run_key: "run:88" },
    });

    await runReaction(context(), fixture.client);

    expect(fixture.saves).toHaveLength(1);
    expect(fixture.saves[0]).toMatchObject({
      parent_event_id: 101,
      idempotency_key: "social-radar:source:linkedin:activity:123",
      semantic_type: "social_signal",
      payload_type: "markdown",
    });
    expect(fixture.notifications).toEqual([
      expect.objectContaining({
        resource_url: "/buremba/memory?content_ids=101,501",
        idempotency_key: "social-radar:notification:run:88",
      }),
    ]);
  });

  it("does not notify again when a later run re-ranks an existing post", async () => {
    const fixture = clientWithSaveResult({
      id: 501,
      created: false,
      metadata: { producer_run_key: "run:77" },
    });

    await runReaction(context(), fixture.client);

    expect(fixture.saves).toHaveLength(1);
    expect(fixture.notifications).toHaveLength(0);
  });

  it("lets the original run retry its idempotent notification", async () => {
    const fixture = clientWithSaveResult({
      id: 501,
      created: false,
      metadata: { producer_run_key: "run:88" },
    });

    await runReaction(context(), fixture.client);

    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]?.idempotency_key).toBe(
      "social-radar:notification:run:88"
    );
  });

  it("keeps the digest within the notification service limit", async () => {
    const longContext = context();
    const extracted = longContext.extracted_data as {
      items: Array<{ why: string }>;
    };
    extracted.items[0].why = "x".repeat(1_200);
    const fixture = clientWithSaveResult({
      id: 501,
      created: true,
      metadata: { producer_run_key: "run:88" },
    });

    await runReaction(longContext, fixture.client);

    expect(String(fixture.notifications[0]?.body).length).toBe(1000);
  });
});
