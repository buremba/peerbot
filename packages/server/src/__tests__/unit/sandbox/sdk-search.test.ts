import { describe, expect, it } from "bun:test";
import { sdkSearch } from "../../../tools/sdk_search";

const stubEnv = {} as never;
const stubCtx = {} as never;

describe("sdkSearch", () => {
  it("returns drill-down for an exact path", async () => {
    const result = await sdkSearch(
      { query: "watchers.list" },
      stubEnv,
      stubCtx,
    );
    expect(result.match_count).toBe(1);
    expect(result.results[0]).toContain("watchers.list");
    expect(result.results[0]).toContain("access:");
  });

  it("returns namespace listing for a top-level namespace", async () => {
    const result = await sdkSearch({ query: "watchers" }, stubEnv, stubCtx);
    expect(result.match_count).toBeGreaterThan(2);
    const joined = result.results.join("\n");
    expect(joined).toContain("watchers.list");
    expect(joined).toContain("watchers.create");
  });

  it("substring-matches across paths and summaries", async () => {
    const result = await sdkSearch(
      { query: "extraction" },
      stubEnv,
      stubCtx,
    );
    // "extraction_schema" appears in watchers.create's summary or example.
    expect(result.match_count).toBeGreaterThan(0);
  });

  it("returns empty + helpful note for unknown queries", async () => {
    const result = await sdkSearch(
      { query: "definitelyNotAMethod" },
      stubEnv,
      stubCtx,
    );
    expect(result.match_count).toBe(0);
    expect(result.notes).toBeDefined();
  });

  it("respects the limit parameter", async () => {
    const result = await sdkSearch(
      { query: "watchers", limit: 2 },
      stubEnv,
      stubCtx,
    );
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.notes).toContain("more matches");
  });
});
