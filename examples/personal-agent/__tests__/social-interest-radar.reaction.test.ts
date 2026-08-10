import { describe, expect, it } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import runReaction from "../social-interest-radar.reaction";

// The author is a first-class event field, so it is deliberately absent here:
// the reaction must read it from the `author_name` column, never from metadata.
const signalMetadata = {
  platform: "linkedin",
  why: "Directly relevant to Lobu's delivery model.",
  priority: "high",
  source_event_id: 101,
  source_connection_id: 410,
};

const draftMetadata = {
  platform: "linkedin",
  why: "Directly relevant to Lobu's delivery model.",
  priority: "high",
  source_event_id: 101,
  source_connection_id: 410,
};

function context(): ReactionContext {
  return {
    extracted_data: {
      signals: [
        {
          title: "Ada on linkedin",
          author: "Ada",
          content:
            "Directly relevant to Lobu's delivery model.\n\nSuggested action: Reply with the event-sourcing design.",
          source_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:123",
          parent_event_id: 101,
          idempotency_key: "linkedin:activity:123",
          metadata: signalMetadata,
        },
      ],
      drafts: [
        {
          title: "Draft reply to Ada",
          author: "Ada",
          content:
            "Durable state is the difference between a demo and a dependable agent.",
          source_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:123",
          parent_event_id: 101,
          idempotency_key: "draft:linkedin:activity:123",
          metadata: draftMetadata,
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

function clientWithRows(options: {
  signals?: Array<{
    id: number;
    author_name: string | null;
    metadata: typeof signalMetadata;
  }>;
  drafts?: Array<{
    id: number;
    payload_text: string;
    source_url: string;
    metadata: typeof draftMetadata;
  }>;
  chrome?: Array<{ id: number; slug?: string; device_online?: boolean }>;
  operationError?: Error;
  reviewError?: Error;
}) {
  const queries: string[] = [];
  const notifications: Record<string, unknown>[] = [];
  const operations: Record<string, unknown>[] = [];
  const operationResults = new Map<string, Record<string, unknown>>();
  const logs: string[] = [];
  let reviewError = options.reviewError;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("behavior_output' = 'signals"))
        return options.signals ?? [];
      if (sql.includes("behavior_output' = 'drafts"))
        return options.drafts ?? [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    connections: {
      list: async (input?: { offset?: number; limit?: number }) => {
        const rows = (options.chrome ?? []).map((c) => ({
          slug: "chrome-macbook",
          device_online: true,
          ...c,
        }));
        const offset = input?.offset ?? 0;
        const limit = input?.limit ?? 50;
        return { connections: rows.slice(offset, offset + limit) };
      },
    },
    notifications: {
      send: async (input: Record<string, unknown>) => {
        if (input.input_schema && reviewError) {
          const error = reviewError;
          reviewError = undefined;
          throw error;
        }
        notifications.push(input);
        return {
          notified_count: 1,
          event_id: 700 + notifications.length,
          url: `/buremba/memory?run_ids=${800 + notifications.length}`,
          ...(input.input_schema ? { run_id: 800 + notifications.length } : {}),
        };
      },
    },
    operations: {
      execute: async (input: Record<string, unknown>) => {
        if (options.operationError) throw options.operationError;
        const idempotencyKey = input.idempotency_key;
        if (typeof idempotencyKey === "string") {
          const prior = operationResults.get(idempotencyKey);
          if (prior) return prior;
        }
        operations.push(input);
        const result = { status: "completed", output: { prepared: true } };
        if (typeof idempotencyKey === "string") {
          operationResults.set(idempotencyKey, result);
        }
        return result;
      },
    },
    log: (message: string) => logs.push(message),
  } as unknown as ReactionClient;
  return { client, queries, notifications, operations, logs };
}

describe("social interest radar reaction", () => {
  it("stages the LinkedIn draft and creates one answerable review instead of a duplicate FYI", async () => {
    const fixture = clientWithRows({
      signals: [{ id: 501, author_name: "Ada", metadata: signalMetadata }],
      drafts: [
        {
          id: 601,
          payload_text:
            "Durable state is the difference between a demo and a dependable agent.",
          source_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:123",
          metadata: draftMetadata,
        },
      ],
      chrome: [{ id: 432 }],
    });

    await runReaction(context(), fixture.client);

    expect(fixture.queries[0]).toContain("run_id = 88");
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).toMatchObject({
      title: "Review LinkedIn comment for Ada",
      idempotency_key: "social-radar:review:601",
      behavior_source: { behavior_id: 71, window_id: 44 },
      input_schema: {
        type: "object",
        required: ["outcome"],
        properties: {
          outcome: {
            enum: ["posted_unchanged", "posted_edited"],
          },
        },
      },
    });
    expect(fixture.notifications[0]).not.toHaveProperty("resource_url");
    expect(String(fixture.notifications[0]?.body)).toContain(
      "Durable state is the difference"
    );
    expect(fixture.operations).toEqual([
      {
        connection_id: 410,
        operation_key: "prepare_comment",
        idempotency_key: "social-radar:draft:601",
        input: {
          post_url: "https://www.linkedin.com/feed/update/urn:li:activity:123",
          body: "Durable state is the difference between a demo and a dependable agent.",
          reason: "Directly relevant to Lobu's delivery model.",
          browser_connection_id: 432,
        },
        behavior_source: { behavior_id: 71, window_id: 44 },
      },
    ]);
  });

  it("keeps unrelated signals in a digest when one LinkedIn signal becomes a review", async () => {
    const otherMetadata = {
      ...signalMetadata,
      platform: "x",
      source_event_id: 202,
      why: "A separate launch signal.",
    };
    const fixture = clientWithRows({
      signals: [
        { id: 501, author_name: "Ada", metadata: signalMetadata },
        { id: 502, author_name: "Grace", metadata: otherMetadata },
      ],
      drafts: [
        {
          id: 601,
          payload_text: "A staged answer.",
          source_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:123",
          metadata: draftMetadata,
        },
      ],
      chrome: [{ id: 432 }],
    });

    await runReaction(context(), fixture.client);

    expect(fixture.notifications).toHaveLength(2);
    expect(fixture.notifications[0]?.title).toBe(
      "Review LinkedIn comment for Ada"
    );
    expect(fixture.notifications[1]).toMatchObject({
      title: "Social interest radar",
      idempotency_key: "social-radar:notification:run:88",
    });
    expect(String(fixture.notifications[1]?.body)).toContain("Grace");
    expect(String(fixture.notifications[1]?.body)).not.toContain("Ada");
    expect(String(fixture.notifications[1]?.resource_url)).toContain(
      "content_ids=202,502"
    );
  });

  it("does not create an impossible review or stage against the generic LinkedIn feed URL", async () => {
    const fixture = clientWithRows({
      signals: [{ id: 501, author_name: "Ada", metadata: signalMetadata }],
      drafts: [
        {
          id: 601,
          payload_text: "Draft",
          source_url: "https://www.linkedin.com/feed/",
          metadata: draftMetadata,
        },
      ],
      chrome: [{ id: 432 }],
    });

    await runReaction(context(), fixture.client);

    expect(fixture.operations).toHaveLength(0);
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).not.toHaveProperty("input_schema");
    expect(fixture.notifications[0]?.resource_url).toBe(
      "/buremba/memory?content_ids=101,501,601"
    );
    expect(fixture.logs.join("\n")).toMatch(/permalink|feed URL/i);
  });

  it("still delivers the signal digest when browser staging throws", async () => {
    const fixture = clientWithRows({
      signals: [{ id: 501, author_name: "Ada", metadata: signalMetadata }],
      drafts: [
        {
          id: 601,
          payload_text: "Draft",
          source_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:123",
          metadata: draftMetadata,
        },
      ],
      chrome: [{ id: 432 }],
      operationError: new Error("idempotency conflict"),
    });

    await runReaction(context(), fixture.client);

    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]?.title).toBe("Social interest radar");
    expect(String(fixture.notifications[0]?.body)).toContain(
      "LinkedIn draft not staged"
    );
    expect(fixture.logs.join("\n")).toContain("staging threw");
  });

  it("retries review creation after staging instead of completing without an answerable review", async () => {
    const fixture = clientWithRows({
      signals: [{ id: 501, author_name: "Ada", metadata: signalMetadata }],
      drafts: [
        {
          id: 601,
          payload_text: "Draft",
          source_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:123",
          metadata: draftMetadata,
        },
      ],
      chrome: [{ id: 432 }],
      reviewError: new Error("notification service unavailable"),
    });

    await expect(runReaction(context(), fixture.client)).rejects.toThrow(
      "notification service unavailable"
    );
    expect(fixture.operations).toHaveLength(1);
    expect(fixture.notifications).toHaveLength(0);

    await runReaction(context(), fixture.client);

    expect(fixture.operations).toHaveLength(1);
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).toMatchObject({
      title: "Review LinkedIn comment for Ada",
      idempotency_key: "social-radar:review:601",
      input_schema: {
        type: "object",
        required: ["outcome"],
      },
    });
  });

  it("names the author from the event column, not from a restated metadata copy", async () => {
    const fixture = clientWithRows({
      signals: [{ id: 501, author_name: "Ada", metadata: signalMetadata }],
    });

    await runReaction(context(), fixture.client);

    expect(fixture.queries[0]).toContain("author_name");
    expect(fixture.notifications[0]?.body).toBe(
      "[high] Ada (linkedin) — Directly relevant to Lobu's delivery model."
    );
  });

  it("does not notify when this run only re-ranked an event owned by an earlier run", async () => {
    const fixture = clientWithRows({});

    await runReaction(context(), fixture.client);

    expect(fixture.notifications).toHaveLength(0);
  });

  it("lets the original run retry its idempotent notification", async () => {
    const fixture = clientWithRows({
      signals: [{ id: 501, author_name: "Ada", metadata: signalMetadata }],
    });

    await runReaction(context(), fixture.client);

    expect(fixture.notifications[0]?.idempotency_key).toBe(
      "social-radar:notification:run:88"
    );
  });

  it("keeps the digest within the notification service limit", async () => {
    const fixture = clientWithRows({
      signals: [
        {
          id: 501,
          author_name: "Ada",
          metadata: { ...signalMetadata, why: "x".repeat(1_200) },
        },
      ],
    });

    await runReaction(context(), fixture.client);

    expect(String(fixture.notifications[0]?.body).length).toBe(1000);
  });

  it("stages an X draft on the explicit interactive browser", async () => {
    const ctx = context();
    const fixture = clientWithRows({
      drafts: [
        {
          id: 602,
          payload_text: "The actor model is the useful boundary here.",
          source_url: "https://x.com/ada/status/123",
          metadata: {
            ...draftMetadata,
            platform: "x",
            source_connection_id: 411,
          },
        },
      ],
      chrome: [{ id: 432 }],
    });

    await runReaction(ctx, fixture.client);

    expect(fixture.operations).toEqual([
      expect.objectContaining({
        connection_id: 411,
        operation_key: "prepare_reply",
        input: expect.objectContaining({
          tweet_url: "https://x.com/ada/status/123",
          browser_connection_id: 432,
        }),
      }),
    ]);
  });

  it("pages past earlier Chrome connections to find the pinned browser", async () => {
    const ctx = context();
    const many = Array.from({ length: 510 }, (_, i) => ({
      id: 1000 + i,
      slug: `chrome-other-${i}`,
      device_online: true,
    }));
    many[503] = { id: 432, slug: "chrome-macbook", device_online: true };
    const fixture = clientWithRows({
      drafts: [
        {
          id: 603,
          payload_text: "Draft",
          source_url: "https://x.com/ada/status/123",
          metadata: {
            ...draftMetadata,
            platform: "x",
            source_connection_id: 411,
          },
        },
      ],
      chrome: many,
    });

    await runReaction(ctx, fixture.client);

    expect(fixture.operations).toHaveLength(1);
    expect(fixture.operations[0]?.input).toMatchObject({
      browser_connection_id: 432,
    });
  });

  it("stages a persisted draft only once when the same reaction retries", async () => {
    const fixture = clientWithRows({
      drafts: [
        {
          id: 601,
          payload_text: "Draft",
          source_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:123",
          metadata: draftMetadata,
        },
      ],
      chrome: [{ id: 432 }],
    });

    await runReaction(context(), fixture.client);
    await runReaction(context(), fixture.client);

    expect(fixture.operations).toHaveLength(1);
    expect(fixture.operations[0]?.idempotency_key).toBe(
      "social-radar:draft:601"
    );
  });

  it("fails closed instead of staging on a guessed browser", async () => {
    const fixture = clientWithRows({
      drafts: [
        {
          id: 601,
          payload_text: "Draft",
          source_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:123",
          metadata: draftMetadata,
        },
      ],
    });

    await runReaction(context(), fixture.client);

    expect(fixture.operations).toHaveLength(0);
    expect(fixture.logs.join("\n")).toMatch(
      /chrome-macbook|interactive browser/i
    );
  });
});
