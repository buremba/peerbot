import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import reducePollVote from "../poll-vote.reaction";

interface State {
  question: string;
  options: string[];
  status: "open" | "closed";
  quorum: number;
  closes_at: string;
  results: Array<{ option: string; count: number }>;
  response_count: number;
  close_reason?: "quorum" | "deadline";
}

function harness(closesAt = "2026-08-28T15:00:00.000Z", quorum = 2) {
  let runId = 0;
  let eventId = 100;
  let closeBeforeNextSave = false;
  let failNextPollEntityUpdate = false;
  let trigger: Record<string, unknown> = {};
  let head = {
    id: eventId,
    semantic_type: "poll_opened" as "poll_opened" | "poll_closed",
    metadata: {
      question: "Ship which lane?",
      options: ["A", "B", "C"],
      status: "open",
      quorum,
      closes_at: closesAt,
      results: [
        { option: "A", count: 0 },
        { option: "B", count: 0 },
        { option: "C", count: 0 },
      ],
      response_count: 0,
    } as State,
  };
  let entityState: State = { ...head.metadata };
  const voteEvents: Array<{
    id: number;
    occurredAt: string;
    platform: string;
    actorId: string;
    choice: string;
  }> = [];
  const savedKinds: string[] = [];

  const client = {
    knowledge: {
      read: async (input: Record<string, unknown>) => {
        expect(input).toEqual({ automation_id: 9, run_id: runId, limit: 10 });
        return { content: [trigger] };
      },
      save: async (input: Record<string, unknown>) => {
        expect(input.supersedes_event_id).toBe(head.id);
        if (closeBeforeNextSave) {
          closeBeforeNextSave = false;
          eventId += 1;
          head = {
            id: eventId,
            semantic_type: "poll_closed",
            metadata: {
              ...head.metadata,
              status: "closed",
              close_reason: "deadline",
            },
          };
          throw new Error("head was superseded by deadline close");
        }
        eventId += 1;
        head = {
          id: eventId,
          semantic_type: input.semantic_type as "poll_opened" | "poll_closed",
          metadata: input.metadata as unknown as State,
        };
        savedKinds.push(head.semantic_type);
        return { id: eventId, created: true, metadata: input.metadata };
      },
    },
    entities: {
      create: async () => {
        throw new Error("Reducer must not create response entities");
      },
      update: async (input: {
        entity_id: number;
        metadata?: Record<string, unknown>;
      }) => {
        if (input.entity_id === 77) {
          if (failNextPollEntityUpdate) {
            failNextPollEntityUpdate = false;
            throw new Error("poll entity update failed");
          }
          if (input.metadata) entityState = input.metadata as unknown as State;
          return;
        }
        throw new Error(`Unexpected entity update: ${input.entity_id}`);
      },
    },
    query: async (sql: string) => {
      if (sql.includes("entity_type = 'poll'")) return [{ id: 77 }];
      if (sql.includes("WITH latest AS")) {
        expect(sql).toContain("semantic_type = 'poll_vote_cast'");
        expect(sql).toContain("origin_type = 'template_interaction'");
        const latest = new Map<string, (typeof voteEvents)[number]>();
        for (const event of voteEvents) {
          if (Date.parse(event.occurredAt) >= Date.parse(closesAt)) continue;
          const key = `${event.platform}:${event.actorId}`;
          const previous = latest.get(key);
          if (
            !previous ||
            event.occurredAt > previous.occurredAt ||
            (event.occurredAt === previous.occurredAt && event.id > previous.id)
          ) {
            latest.set(key, event);
          }
        }
        const counts = new Map<string, number>();
        for (const event of latest.values()) {
          counts.set(event.choice, (counts.get(event.choice) ?? 0) + 1);
        }
        return [...counts].map(([choice, count]) => ({ choice, count }));
      }
      if (sql.includes("FROM events")) {
        expect(sql).not.toContain("superseded_by");
        return [head];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    log: () => undefined,
  } as unknown as ReactionClient;

  const run = async () => {
    runId += 1;
    await reducePollVote(
      {
        extracted_data: { summary: "Process the trusted poll interaction." },
        entities: [],
        window: {
          run_id: runId,
          automation_id: 9,
          window_start: "2026-08-28T14:00:00.000Z",
          window_end: "2026-08-28T15:00:00.000Z",
          granularity: "event",
          content_analyzed: 1,
        },
        automation: {
          id: 9,
          slug: "poll-vote-reducer",
          name: "Poll vote reducer",
          version: 1,
        },
        organization_id: "org-test",
        organization_slug: "test",
      } satisfies ReactionContext,
      client
    );
  };

  const vote = async (params: {
    actorId: string;
    actorName: string;
    choice: string;
    occurredAt: string;
    entityIds?: unknown;
  }) => {
    trigger = {
      id: 200 + runId,
      entity_ids: params.entityIds ?? [77],
      semantic_type: "poll_vote_cast",
      origin_type: "template_interaction",
      occurred_at: params.occurredAt,
      metadata: {
        interaction: {
          action: "vote",
          value: params.choice,
          source_event_id: head.id,
          actor: {
            platform: "gchat",
            id: params.actorId,
            name: params.actorName,
          },
        },
      },
    };
    voteEvents.push({
      id: Number(trigger.id),
      occurredAt: params.occurredAt,
      platform: "gchat",
      actorId: params.actorId,
      choice: params.choice,
    });
    await run();
  };

  const close = (reason: "quorum" | "deadline") => {
    eventId += 1;
    head = {
      id: eventId,
      semantic_type: "poll_closed",
      metadata: {
        ...head.metadata,
        status: "closed",
        close_reason: reason,
      },
    };
  };

  return {
    vote,
    close,
    raceDeadlineOnNextSave: () => {
      closeBeforeNextSave = true;
    },
    failNextPollEntityUpdate: () => {
      failNextPollEntityUpdate = true;
    },
    retryLastVote: run,
    state: () => head.metadata,
    entityState: () => entityState,
    savedKinds,
  };
}

describe("poll vote reaction", () => {
  test("accepts run-bound PostgreSQL array text for event entity ids", async () => {
    const poll = harness("2026-08-28T15:00:00.000Z", 1);
    await poll.vote({
      actorId: "users/ada",
      actorName: "Ada",
      choice: "A",
      occurredAt: "2026-08-28T14:10:00.000Z",
      entityIds: "{77,31540}",
    });

    expect(poll.state()).toMatchObject({
      status: "closed",
      close_reason: "quorum",
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 0 },
        { option: "C", count: 0 },
      ],
      response_count: 1,
    });
  });

  test("derives two actors, a vote change, and quorum closure from events", async () => {
    const poll = harness();
    await poll.vote({
      actorId: "users/ada",
      actorName: "Ada",
      choice: "A",
      occurredAt: "2026-08-28T14:10:00.000Z",
    });
    await poll.vote({
      actorId: "users/grace",
      actorName: "Grace",
      choice: "B",
      occurredAt: "2026-08-28T14:11:00.000Z",
    });
    await poll.vote({
      actorId: "users/ada",
      actorName: "Ada",
      choice: "B",
      occurredAt: "2026-08-28T14:12:00.000Z",
    });

    expect(poll.state()).toMatchObject({
      status: "closed",
      close_reason: "quorum",
      results: [
        { option: "A", count: 0 },
        { option: "B", count: 2 },
        { option: "C", count: 0 },
      ],
      response_count: 2,
    });
    expect(poll.savedKinds).toEqual([
      "poll_opened",
      "poll_opened",
      "poll_closed",
    ]);
  });

  test("closes at the deadline without counting the late vote", async () => {
    const poll = harness("2026-08-28T14:05:00.000Z");
    await poll.vote({
      actorId: "users/late",
      actorName: "Late voter",
      choice: "C",
      occurredAt: "2026-08-28T14:05:00.000Z",
    });

    expect(poll.state()).toMatchObject({
      status: "closed",
      close_reason: "deadline",
      response_count: 0,
    });
    expect(poll.savedKinds).toEqual(["poll_closed"]);
  });

  test("reconciles an accepted pre-deadline vote processed after closure", async () => {
    const poll = harness();
    await poll.vote({
      actorId: "users/ada",
      actorName: "Ada",
      choice: "A",
      occurredAt: "2026-08-28T14:10:00.000Z",
    });
    poll.close("deadline");

    await poll.vote({
      actorId: "users/grace",
      actorName: "Grace",
      choice: "B",
      occurredAt: "2026-08-28T14:59:59.000Z",
    });

    expect(poll.state()).toMatchObject({
      status: "closed",
      close_reason: "deadline",
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 1 },
        { option: "C", count: 0 },
      ],
      response_count: 2,
    });
    expect(poll.savedKinds).toEqual(["poll_opened", "poll_closed"]);
  });

  test("reconciles when the deadline supersedes the open head during save", async () => {
    const poll = harness();
    poll.raceDeadlineOnNextSave();

    await poll.vote({
      actorId: "users/ada",
      actorName: "Ada",
      choice: "A",
      occurredAt: "2026-08-28T14:10:00.000Z",
    });

    expect(poll.state()).toMatchObject({
      status: "closed",
      close_reason: "deadline",
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 0 },
        { option: "C", count: 0 },
      ],
      response_count: 1,
    });
    expect(poll.savedKinds).toEqual(["poll_closed"]);
  });

  test("repairs poll entity metadata when a closed successor already exists", async () => {
    const poll = harness("2026-08-28T15:00:00.000Z", 1);
    poll.failNextPollEntityUpdate();

    await expect(
      poll.vote({
        actorId: "users/ada",
        actorName: "Ada",
        choice: "A",
        occurredAt: "2026-08-28T14:10:00.000Z",
      })
    ).rejects.toThrow("poll entity update failed");

    expect(poll.state()).toMatchObject({
      status: "closed",
      close_reason: "quorum",
      results: [
        { option: "A", count: 1 },
        { option: "B", count: 0 },
        { option: "C", count: 0 },
      ],
    });
    expect(poll.entityState()).toMatchObject({
      status: "open",
      response_count: 0,
    });

    await poll.retryLastVote();

    expect(poll.entityState()).toEqual(poll.state());
    expect(poll.savedKinds).toEqual(["poll_closed"]);
  });

  test("repairs poll entity metadata when a deadline close already exists", async () => {
    const poll = harness("2026-08-28T14:05:00.000Z");
    poll.failNextPollEntityUpdate();

    await expect(
      poll.vote({
        actorId: "users/late",
        actorName: "Late voter",
        choice: "C",
        occurredAt: "2026-08-28T14:05:00.000Z",
      })
    ).rejects.toThrow("poll entity update failed");

    expect(poll.state()).toMatchObject({
      status: "closed",
      close_reason: "deadline",
      response_count: 0,
    });
    expect(poll.entityState()).toMatchObject({ status: "open" });

    await poll.retryLastVote();

    expect(poll.entityState()).toEqual(poll.state());
    expect(poll.savedKinds).toEqual(["poll_closed"]);
  });
});
