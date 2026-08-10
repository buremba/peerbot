import { describe, expect, it } from "bun:test";
import type { ReactionClient } from "../reaction-client-types";

describe("ReactionClient knowledge.read input", () => {
  it("accepts the content_ids (array) shape save_memory's exact_read hint advertises", () => {
    // Compile-time contract: read_knowledge takes `content_ids: number[]` —
    // excess-property checking here would fail if the published type regressed
    // to the singular `content_id` the live bug advertised.
    const call = (client: ReactionClient) =>
      client.knowledge.read({ content_ids: [42] });
    expect(typeof call).toBe("function");
  });

  it("exposes ask results and run reads to Behavior reactions", () => {
    const call = async (client: ReactionClient) => {
      const sent = await client.notifications.send({
        title: "Was this LinkedIn comment posted?",
        input_schema: {
          type: "object",
          properties: {
            outcome: { enum: ["posted_unchanged", "posted_edited"] },
          },
          required: ["outcome"],
        },
      });
      const page = await client.operations.listRuns({
        behavior_ids: [71],
        run_types: ["internal", "action"],
      });
      const run = sent.run_id
        ? await client.operations.getRun(sent.run_id)
        : undefined;
      return { page, run, eventId: sent.event_id };
    };
    expect(typeof call).toBe("function");
  });
});
