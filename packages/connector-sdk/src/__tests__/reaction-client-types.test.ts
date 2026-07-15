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
});
