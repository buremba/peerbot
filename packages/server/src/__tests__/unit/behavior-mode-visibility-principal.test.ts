/**
 * Behavior knowledge.read must pass a connection-visibility principal so
 * private oauth_account connections (e.g. personal X) are not silently
 * dropped. Without userId, executeDataSources is org-visible-only.
 */
import { describe, expect, it } from "bun:test";
import { buildScopedQuery } from "../../utils/execute-data-sources";

describe("Behavior source visibility principal", () => {
  it("includes private-connection created_by when userId is the Behavior author", () => {
    const { sql, params } = buildScopedQuery(
      "SELECT id FROM events WHERE connector_key = 'x'",
      ["events"],
      {
        organizationId: "org_buremba",
        userId: "user_owner",
        windowStart: "2026-07-30T00:00:00.000Z",
        windowEnd: "2026-07-31T00:00:00.000Z",
      }
    );
    expect(sql).toContain("vc.visibility = 'org'");
    expect(sql).toContain("vc.created_by");
    expect(params).toContain("user_owner");
    expect(params).toContain("2026-07-30T00:00:00.000Z");
  });

  it("is org-only when principal is null (the bug Behavior mode used to hit)", () => {
    const { sql, params } = buildScopedQuery(
      "SELECT id FROM events WHERE connector_key = 'x'",
      ["events"],
      {
        organizationId: "org_buremba",
        userId: null,
        windowStart: "2026-07-30T00:00:00.000Z",
        windowEnd: "2026-07-31T00:00:00.000Z",
      }
    );
    expect(sql).toContain("vc.visibility = 'org'");
    // Null principal must not bind a user id that could match private rows.
    expect(params).not.toContain("user_owner");
  });
});
