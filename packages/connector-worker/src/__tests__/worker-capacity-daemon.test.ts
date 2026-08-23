import { describe, expect, test } from "bun:test";
import { WorkerPollLoop } from "../daemon/poll-loop";

describe("worker daemon capacity polling", () => {
  test("runs credential maintenance before polls only when no job is active", async () => {
    const order: string[] = [];
    let releaseJob: (() => void) | undefined;
    const jobDone = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    let polls = 0;
    let loop: WorkerPollLoop;
    const client = {
      healthCheck: async () => true,
      poll: async () => {
        polls++;
        order.push(`poll:${polls}`);
        if (polls === 1) return { run_id: 42, run_type: "sync" };
        if (polls === 2) {
          releaseJob?.();
          return { next_poll_seconds: 0.001 };
        }
        loop.stop();
        return { next_poll_seconds: 0.001 };
      },
    } as never;
    loop = new WorkerPollLoop({
      client,
      pollIntervalMs: 1,
      maxConcurrentJobs: 1,
      execute: async () => jobDone,
      beforeIdlePoll: async () => {
        order.push("maintenance");
      },
    });

    await loop.start();

    expect(order).toEqual([
      "maintenance",
      "poll:1",
      "poll:2",
      "maintenance",
      "poll:3",
    ]);
  });

  test("treats credential maintenance refusal as fatal before polling", async () => {
    let polls = 0;
    const loop = new WorkerPollLoop({
      client: {
        healthCheck: async () => true,
        poll: async () => {
          polls++;
          return {};
        },
      } as never,
      execute: async () => {},
      beforeIdlePoll: async () => {
        throw new Error("device credential was revoked");
      },
    });

    await expect(loop.start()).rejects.toThrow(/credential was revoked/);
    expect(polls).toBe(0);
  });

  test("polls at capacity with zero and does not execute a returned job", async () => {
    const calls: number[] = [];
    let executed = 0;
    const client = {
      poll: async (capacity?: number) => {
        calls.push(capacity ?? -1);
        return { run_id: 42, run_type: "sync", next_poll_seconds: 10 };
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      maxConcurrentJobs: 1,
      execute: async () => {
        executed++;
      },
    });
    (loop as unknown as { activeJobs: number }).activeJobs = 1;

    await (loop as unknown as { pollAndExecute: () => Promise<number | undefined> })
      .pollAndExecute();

    expect(calls).toEqual([0]);
    expect(executed).toBe(0);
  });

  test("sends the number of free slots when below capacity", async () => {
    const calls: number[] = [];
    const client = {
      poll: async (capacity?: number) => {
        calls.push(capacity ?? -1);
        return {};
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      maxConcurrentJobs: 3,
      execute: async () => {},
    });
    (loop as unknown as { activeJobs: number }).activeJobs = 1;

    await (loop as unknown as { pollAndExecute: () => Promise<number | undefined> })
      .pollAndExecute();

    expect(calls).toEqual([2]);
  });

  test("releases one slot when the executor rejects asynchronously", async () => {
    const capacities: number[] = [];
    let firstPoll = true;
    const client = {
      poll: async (capacity?: number) => {
        capacities.push(capacity ?? -1);
        if (firstPoll) {
          firstPoll = false;
          return { run_id: 42, run_type: "sync" };
        }
        return { next_poll_seconds: 1 };
      },
    } as never;
    const loop = new WorkerPollLoop({
      client,
      maxConcurrentJobs: 1,
      execute: async () => {
        throw new Error("asynchronous executor failure");
      },
    });
    const pollAndExecute = (loop as unknown as {
      pollAndExecute: () => Promise<number | undefined>;
    }).pollAndExecute.bind(loop);

    await pollAndExecute();
    expect(await loop.waitForActiveJobs(1000, 1)).toBe(true);
    await pollAndExecute();

    expect(capacities).toEqual([1, 1]);
  });
});
