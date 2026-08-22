import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { PollRequestSchema } from "../contracts/worker/protocol";

const baseRequest = { worker_id: "worker-1" };

describe("worker poll capacity", () => {
  test("accepts omitted, zero, and positive capacity", () => {
    expect(Value.Check(PollRequestSchema, baseRequest)).toBe(true);
    expect(
      Value.Check(PollRequestSchema, { ...baseRequest, capacity_available: 0 })
    ).toBe(true);
    expect(
      Value.Check(PollRequestSchema, { ...baseRequest, capacity_available: 7 })
    ).toBe(true);
  });

  test("rejects negative, fractional, and absurd capacity", () => {
    for (const capacity_available of [-1, 1.5, 1025]) {
      expect(
        Value.Check(PollRequestSchema, { ...baseRequest, capacity_available })
      ).toBe(false);
    }
  });
});
