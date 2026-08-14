import { describe, expect, it } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import runReaction from "../social-interest-radar.reaction";

const signalMetadata = {
  platform: "linkedin",
  why: "Directly relevant to Lobu's delivery model.",
  priority: "high",
  source_event_id: 101,
  source_connection_id: 410,
};
const draftMetadata = { ...signalMetadata };

function context(): ReactionContext {
  return {
    extracted_data: { signals: [{}], drafts: [{}] },
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
      version: 10,
    },
    organization_id: "org-1",
    organization_slug: "buremba",
  };
}

function fixture(options?: {
  platform?: "x" | "linkedin" | "hackernews";
  operationResult?: Record<string, unknown>;
  operationErrorOnce?: Error;
  includeSignal?: boolean;
  includeDraft?: boolean;
  signalWhy?: string;
}) {
  const platform = options?.platform ?? "linkedin";
  const sourceUrl =
    platform === "x"
      ? "https://x.com/ada/status/123?ref=home"
      : platform === "hackernews"
        ? "https://news.ycombinator.com/item?id=42954035"
        : "https://www.linkedin.com/feed/update/urn:li:activity:123";
  const metadata = {
    ...draftMetadata,
    platform,
    why: options?.signalWhy ?? draftMetadata.why,
    source_connection_id:
      platform === "x" ? 411 : platform === "hackernews" ? 412 : 410,
  };
  const signals =
    options?.includeSignal === false
      ? []
      : [{ id: 501, author_name: "Ada", metadata }];
  const drafts =
    options?.includeDraft === false
      ? []
      : [
          {
            id: 601,
            author_name: "Ada",
            payload_text: "Durable state makes the difference.",
            source_url: sourceUrl,
            metadata,
          },
        ];
  const notifications: Record<string, unknown>[] = [];
  const operations: Record<string, unknown>[] = [];
  let connectionListCalls = 0;
  let operationError = options?.operationErrorOnce;
  const client = {
    query: async (sql: string) =>
      sql.includes("behavior_output' = 'signals") ? signals : drafts,
    connections: {
      list: async () => {
        connectionListCalls += 1;
        return { connections: [] };
      },
    },
    notifications: {
      send: async (input: Record<string, unknown>) => {
        notifications.push(input);
        return { notified_count: 1, event_id: 700 };
      },
    },
    operations: {
      execute: async (input: Record<string, unknown>) => {
        operations.push(input);
        if (operationError) {
          const error = operationError;
          operationError = undefined;
          throw error;
        }
        return (
          options?.operationResult ?? { status: "in_progress", run_id: 900 }
        );
      },
    },
    log: () => {
      // Tests assert durable calls, not diagnostic output.
    },
  } as unknown as ReactionClient;
  return {
    client,
    notifications,
    operations,
    get connectionListCalls() {
      return connectionListCalls;
    },
  };
}

describe("social interest radar reaction", () => {
  it("parks a LinkedIn draft until the exact page is visited and sends one normal notification", async () => {
    const f = fixture();
    await runReaction(context(), f.client);

    expect(f.connectionListCalls).toBe(0);
    expect(f.operations).toEqual([
      {
        connection_id: 410,
        operation_key: "prepare_comment",
        idempotency_key: "social-radar:draft:601",
        input: {
          post_url: "https://www.linkedin.com/feed/update/urn:li:activity:123",
          body: "Durable state makes the difference.",
          reason: "Directly relevant to Lobu's delivery model.",
        },
        activation: {
          kind: "page_visit",
          urls: ["https://www.linkedin.com/feed/update/urn:li:activity:123"],
          expires_in_seconds: 86_400,
        },
        behavior_source: { behavior_id: 71, window_id: 44 },
      },
    ]);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]).toMatchObject({
      title: "Draft ready for Ada on LinkedIn",
      idempotency_key: "social-radar:draft-ready:601",
      resource_url: "/buremba/memory?content_ids=101,601",
      browser_url: "https://www.linkedin.com/feed/update/urn:li:activity:123",
    });
    expect(f.notifications[0]).not.toHaveProperty("input_schema");
    expect(String(f.notifications[0]?.body)).toContain(
      "Open the post in Chrome"
    );
  });

  it("uses the same generic activation contract for X without selecting a machine", async () => {
    const f = fixture({ platform: "x", includeSignal: false });
    await runReaction(context(), f.client);

    expect(f.connectionListCalls).toBe(0);
    expect(f.operations[0]).toMatchObject({
      connection_id: 411,
      operation_key: "prepare_reply",
      input: { tweet_url: "https://x.com/ada/status/123?ref=home" },
      activation: {
        kind: "page_visit",
        urls: ["https://x.com/ada/status/123?ref=home"],
      },
    });
    expect(f.operations[0]?.input).not.toHaveProperty("browser_connection_id");
  });

  it("stages a Hacker News draft via prepare_comment with the item url", async () => {
    const f = fixture({ platform: "hackernews", includeSignal: false });
    await runReaction(context(), f.client);

    expect(f.connectionListCalls).toBe(0);
    expect(f.operations[0]).toMatchObject({
      connection_id: 412,
      operation_key: "prepare_comment",
      input: { item_url: "https://news.ycombinator.com/item?id=42954035" },
      activation: {
        kind: "page_visit",
        urls: ["https://news.ycombinator.com/item?id=42954035"],
      },
    });
    expect(f.notifications[0]).toMatchObject({
      title: "Draft ready for Ada on Hacker News",
      browser_url: "https://news.ycombinator.com/item?id=42954035",
    });
  });

  it("accepts an idempotent completed run and still retries the draft notification", async () => {
    const f = fixture({
      operationResult: { status: "completed", run_id: 900 },
    });
    await runReaction(context(), f.client);
    expect(f.notifications).toHaveLength(1);
  });

  it("retries an ambiguous scheduling error instead of completing without a draft card", async () => {
    const f = fixture({
      operationErrorOnce: new Error(
        "reaction tracking temporarily unavailable"
      ),
    });
    await expect(runReaction(context(), f.client)).rejects.toThrow(
      "reaction tracking temporarily unavailable"
    );
    expect(f.notifications).toHaveLength(0);

    await runReaction(context(), f.client);
    expect(f.operations.map((operation) => operation.idempotency_key)).toEqual([
      "social-radar:draft:601",
      "social-radar:draft:601",
    ]);
    expect(f.notifications[0]?.idempotency_key).toBe(
      "social-radar:draft-ready:601"
    );
  });

  it("sends no digest when scheduling fails terminally — only draft-ready cards", async () => {
    const f = fixture({
      operationResult: {
        status: "failed",
        error_message: "connector unavailable",
      },
    });
    await runReaction(context(), f.client);
    // No digest fallback: a failed scheduling run notifies nothing.
    expect(f.notifications).toHaveLength(0);
  });

  it("refuses a generic LinkedIn feed URL because it cannot match one post", async () => {
    const f = fixture();
    const originalQuery = f.client.query;
    f.client.query = (async (sql: string) => {
      const rows = await originalQuery(sql);
      if (sql.includes("behavior_output' = 'drafts")) {
        return (rows as Array<Record<string, unknown>>).map((row) => ({
          ...row,
          source_url: "https://www.linkedin.com/feed/",
        }));
      }
      return rows;
    }) as typeof f.client.query;
    await runReaction(context(), f.client);
    expect(f.operations).toHaveLength(0);
  });

  it("does not notify an observation-only run — only drafts get cards", async () => {
    const f = fixture({ includeDraft: false });
    await runReaction(context(), f.client);
    expect(f.operations).toHaveLength(0);
    // The "Social interest radar" digest is gone; signals alone notify nothing.
    expect(f.notifications).toHaveLength(0);
  });

  it("does not notify when the persisted run owns no new output", async () => {
    const f = fixture({ includeSignal: false, includeDraft: false });
    await runReaction(context(), f.client);
    expect(f.operations).toHaveLength(0);
    expect(f.notifications).toHaveLength(0);
  });

  it("does not truncate a draft-ready body below the service limit", async () => {
    const f = fixture({ signalWhy: "x".repeat(1_200) });
    await runReaction(context(), f.client);
    expect(f.notifications).toHaveLength(1);
    expect(String(f.notifications[0]?.body).length).toBeLessThanOrEqual(1000);
  });

  it("uses stable operation and notification keys across reaction retries", async () => {
    const f = fixture();
    await runReaction(context(), f.client);
    await runReaction(context(), f.client);
    expect(f.operations.map((op) => op.idempotency_key)).toEqual([
      "social-radar:draft:601",
      "social-radar:draft:601",
    ]);
    expect(
      f.notifications.map((notification) => notification.idempotency_key)
    ).toEqual(["social-radar:draft-ready:601", "social-radar:draft-ready:601"]);
  });
});
