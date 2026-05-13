import { describe, expect, it } from "bun:test";
import { createActionCaller } from "../../../sandbox/namespaces/action-call";

describe("createActionCaller", () => {
  it("forces the action discriminator, ignoring a caller-supplied `action` key", async () => {
    const calls: object[] = [];
    const handler = async (payload: object) => {
      calls.push(payload);
      return payload;
    };
    const { action } = createActionCaller(handler as never, {} as never, {} as never);

    // A read-only caller tries to smuggle `action: "delete"` into a "list" call.
    await action("list", { action: "delete", entity_id: 42 });

    expect(calls).toHaveLength(1);
    expect((calls[0] as Record<string, unknown>).action).toBe("list");
    expect((calls[0] as Record<string, unknown>).entity_id).toBe(42);
  });

  it("passes through ordinary input", async () => {
    const calls: object[] = [];
    const handler = async (payload: object) => {
      calls.push(payload);
      return payload;
    };
    const { action } = createActionCaller(handler as never, {} as never, {} as never);
    await action("get", { entity_id: 7 });
    expect(calls[0]).toEqual({ entity_id: 7, action: "get" });
  });
});
