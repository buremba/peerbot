import { describe, expect, test } from "bun:test";
import { WorkerPollLoop } from "../daemon/poll-loop";

describe("worker daemon capacity polling", () => {
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
});
